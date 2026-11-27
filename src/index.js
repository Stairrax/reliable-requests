import { isRetryableStatus, defaultShouldRetryError, retryDelayMs, pause, abortError, discardResponse } from './retry.js';

/**
 * A small fetch wrapper with one deadline across attempts and response consumption.
 * Requires global fetch, AbortController, and DOMException (modern browsers and Node 18+).
 */
export class RequestTimeoutError extends Error {
  constructor(timeoutMs, message = `Request exceeded the ${timeoutMs} ms total timeout`) {
    super(message);
    this.name = 'RequestTimeoutError';
    this.code = 'REQUEST_TIMEOUT';
    this.timeoutMs = timeoutMs;
  }
}

export class HttpError extends Error {
  constructor(response, attempts) {
    super(`HTTP ${response.status} ${response.statusText || ''}`.trim());
    this.name = 'HttpError';
    this.code = 'HTTP_ERROR';
    this.status = response.status;
    this.response = response;
    this.attempts = attempts;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD']);

/**
 * @param {string|URL} input URL to fetch. Request objects are deliberately unsupported.
 * @param {object} options fetch options plus timeoutMs, retries, consume, fetchImpl, shouldRetryError.
 * @returns {Promise<Response|unknown>} Response, or the result of consume(response, signal).
 */
export async function reliableRequest(input, options = {}) {
  const {
    timeoutMs = 30_000,
    retries = 2,
    consume,
    fetchImpl = globalThis.fetch,
    shouldRetryError = defaultShouldRetryError,
    signal: callerSignal,
    ...init
  } = options;
  if (typeof input !== 'string' && !(input instanceof URL)) throw new TypeError('input must be a URL string or URL');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new RangeError('timeoutMs must be a positive integer');
  if (!Number.isSafeInteger(retries) || retries < 0) throw new RangeError('retries must be a non-negative integer');
  if (consume !== undefined && typeof consume !== 'function') throw new TypeError('consume must be a function');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (typeof shouldRetryError !== 'function') throw new TypeError('shouldRetryError must be a function');
  const method = String(init.method || 'GET').toUpperCase();
  const canRetry = SAFE_METHODS.has(method);
  const controller = new AbortController();
  let rejectStopped;
  const stopped = new Promise((_, reject) => { rejectStopped = reject; });
  let finished = false;
  const stop = (error) => {
    if (finished) return;
    finished = true;
    rejectStopped(error);
    controller.abort(error);
  };
  const onCallerAbort = () => stop(abortError());
  if (callerSignal?.aborted) throw abortError();
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
  const started = performance.now();
  const remaining = () => timeoutMs - (performance.now() - started);
  const timer = setTimeout(() => stop(new RequestTimeoutError(timeoutMs)), timeoutMs);
  const checkDeadline = () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (remaining() <= 0) {
      stop(new RequestTimeoutError(timeoutMs));
      throw controller.signal.reason;
    }
  };
  const waitToRetry = async (attempt, response) => {
    checkDeadline();
    const delay = retryDelayMs({ attempt, response, remainingMs: remaining() });
    if (delay === null) {
      stop(new RequestTimeoutError(timeoutMs, 'Retry delay cannot fit within the ' + timeoutMs + ' ms total timeout'));
      throw controller.signal.reason;
    }
    await pause(delay, controller.signal);
  };
  const run = async () => {
    for (let attempt = 1; ; attempt++) {
      checkDeadline();
      let response;
      try {
        response = await fetchImpl(input, { ...init, method, signal: controller.signal });
      } catch (error) {
        checkDeadline();
        if (!canRetry || attempt > retries || error?.name === 'AbortError' || error instanceof RequestTimeoutError ||
          shouldRetryError(error, { attempt, method, phase: 'fetch' }) !== true) throw error;
        await waitToRetry(attempt);
        continue;
      }
      if (controller.signal.aborted || remaining() <= 0) {
        discardResponse(response);
        checkDeadline();
      }
      if (!response.ok) {
        const error = new HttpError(response, attempt);
        if (!canRetry || attempt > retries || !isRetryableStatus(response.status)) throw error;
        discardResponse(response);
        await waitToRetry(attempt, response);
        continue;
      }
      const value = consume ? await consume(response, controller.signal) : response;
      checkDeadline();
      return value;
    }
  };
  try {
    return await Promise.race([run(), stopped]);
  } finally {
    finished = true;
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}
