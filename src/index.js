/**
 * A small fetch wrapper with one deadline across attempts and response consumption.
 * Requires global fetch, AbortController, and DOMException (modern browsers and Node 18+).
 */
export class RequestTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Request exceeded the ${timeoutMs} ms total timeout`);
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

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const SAFE_METHODS = new Set(['GET', 'HEAD']);
const abortError = () => new DOMException('Request cancelled', 'AbortError');

function retryAfterMs(response) {
  const value = response.headers?.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function pause(ms, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * @param {string|URL} input URL to fetch. Request objects are deliberately unsupported.
 * @param {object} options fetch options plus timeoutMs, retries, consume, fetchImpl.
 * @returns {Promise<Response|unknown>} Response, or the result of consume(response, signal).
 */
export async function reliableRequest(input, options = {}) {
  const {
    timeoutMs = 30_000,
    retries = 2,
    consume,
    fetchImpl = globalThis.fetch,
    signal: callerSignal,
    ...init
  } = options;
  if (typeof input !== 'string' && !(input instanceof URL)) throw new TypeError('input must be a URL string or URL');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new RangeError('timeoutMs must be a positive integer');
  if (!Number.isSafeInteger(retries) || retries < 0) throw new RangeError('retries must be a non-negative integer');
  if (consume !== undefined && typeof consume !== 'function') throw new TypeError('consume must be a function');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
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
  const timer = setTimeout(() => stop(new RequestTimeoutError(timeoutMs)), timeoutMs);
  const run = async () => {
    for (let attempt = 1; ; attempt++) {
      if (controller.signal.aborted) throw controller.signal.reason;
      let response;
      try {
        response = await fetchImpl(input, { ...init, method, signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (!canRetry || attempt > retries || !(error instanceof TypeError)) throw error;
        await pause(Math.min(250 * 2 ** (attempt - 1), 5_000), controller.signal);
        continue;
      }
      if (!response.ok) {
        const error = new HttpError(response, attempt);
        if (!canRetry || attempt > retries || !RETRY_STATUSES.has(response.status)) throw error;
        const delay = retryAfterMs(response) ?? Math.min(250 * 2 ** (attempt - 1), 5_000);
        await response.body?.cancel?.().catch(() => {});
        await pause(Math.min(delay, 30_000), controller.signal);
        continue;
      }
      const value = consume ? await consume(response, controller.signal) : response;
      if (controller.signal.aborted) throw controller.signal.reason;
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
