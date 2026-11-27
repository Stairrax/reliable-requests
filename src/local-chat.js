import { reliableRequest, HttpError, RequestTimeoutError } from './index.js';
import { createLineParser, createSseParser } from './sse.js';
import { isRetryableStatus, defaultShouldRetryError, retryDelayMs, pause, abortError, discardResponse } from './retry.js';

export { StreamLineTooLongError, StreamEventTooLongError } from './sse.js';

export class StreamInterruptedError extends Error {
  constructor(message = 'The model stream ended before completion') {
    super(message);
    this.name = 'StreamInterruptedError';
    this.code = 'STREAM_INTERRUPTED';
  }
}

export class UnsupportedModelOutputError extends Error {
  constructor() {
    super('Tool calls are not supported by this text-only API');
    this.name = 'UnsupportedModelOutputError';
    this.code = 'UNSUPPORTED_MODEL_OUTPUT';
  }
}

const DEFAULT_MAX_LINE_CHARS = 262_144;
const HARD_MAX_LINE_CHARS = 4_194_304;
const MAX_DECODE_CHUNK_BYTES = 16 * 1024;

function isLoopback(url) {
  return url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\./.test(url.hostname);
}

async function readStream(response, protocol, signal, emit, maxLineChars, maxEventChars, markNetworkError) {
  if (!response.body) throw new StreamInterruptedError('The response has no stream');
  const reader = response.body.getReader();
  const abort = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  let complete = false;
  let finishReason = null;
  const decoder = new TextDecoder();
  const line = (raw) => {
    if (protocol === 'openai') {
      const data = raw.trim();
      if (data === '[DONE]') { complete = true; return false; }
      if (!data) return;
      let event;
      try { event = JSON.parse(data); }
      catch { throw new Error('Invalid OpenAI-compatible stream event'); }
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Invalid OpenAI-compatible stream event');
      if (event.error) throw new Error(event.error.message || 'Model stream error');
      const choice = event.choices?.[0];
      if (choice?.delta?.tool_calls?.length || choice?.delta?.function_call || choice?.finish_reason === 'tool_calls' || choice?.finish_reason === 'function_call') throw new UnsupportedModelOutputError();
      if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
      const content = choice?.delta?.content;
      if (typeof content === 'string' && content) emit(content);
    } else {
      const text = raw.trim();
      if (!text) return;
      let event;
      try { event = JSON.parse(text); }
      catch { throw new Error('Invalid Ollama stream event'); }
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Invalid Ollama stream event');
      if (event.error) throw new Error(String(event.error));
      if (event.message?.tool_calls?.length) throw new UnsupportedModelOutputError();
      if (typeof event.done_reason === 'string') finishReason = event.done_reason;
      const content = event.message?.content;
      if (typeof content === 'string' && content) emit(content);
      if (event.done === true) { complete = true; return false; }
    }
  };
  const parser = protocol === 'openai'
    ? createSseParser({ maxLineChars, maxEventChars, onData: line })
    : createLineParser({ maxLineChars, onLine: line });
  try {
    while (!complete) {
      let chunk;
      try { chunk = await reader.read(); }
      catch (error) { markNetworkError('read'); throw error; }
      const { value, done } = chunk;
      if (signal.aborted) throw abortError();
      if (done) {
        parser.push(decoder.decode());
        parser.finish(protocol === 'ollama');
        break;
      }
      for (let start = 0; start < value.byteLength && !complete; start += MAX_DECODE_CHUNK_BYTES) {
        const bytes = value.subarray(start, start + MAX_DECODE_CHUNK_BYTES);
        parser.push(decoder.decode(bytes, { stream: true }));
      }
    }
    if (!complete) throw new StreamInterruptedError();
    return finishReason;
  } finally {
    signal.removeEventListener('abort', abort);
    reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch {}
  }
}

/**
 * Retry a text-only local model generation, including a partially delivered stream.
 * onEvent receives attempt, delta, reset, retry, and done events.
 */
export async function streamLocalChat({
  endpoint,
  protocol = 'openai',
  model,
  messages,
  timeoutMs = 120_000,
  retries = 2,
  signal,
  onEvent,
  headers,
  fetchImpl = globalThis.fetch,
  shouldRetryError = defaultShouldRetryError,
  allowRemoteRetries = false,
  maxLineChars = DEFAULT_MAX_LINE_CHARS,
  maxEventChars = maxLineChars,
} = {}) {
  if (protocol !== 'openai' && protocol !== 'ollama') throw new TypeError('protocol must be openai or ollama');
  if (!model || typeof model !== 'string') throw new TypeError('model is required');
  if (!Array.isArray(messages) || !messages.every(m => typeof m?.role === 'string' && typeof m?.content === 'string')) {
    throw new TypeError('messages must contain text-only role/content pairs');
  }
  if (typeof onEvent !== 'function') throw new TypeError('onEvent is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new RangeError('invalid timeoutMs');
  if (!Number.isSafeInteger(retries) || retries < 0) throw new RangeError('invalid retries');
  if (!Number.isSafeInteger(maxLineChars) || maxLineChars < 1 || maxLineChars > HARD_MAX_LINE_CHARS) {
    throw new RangeError('maxLineChars must be an integer between 1 and 4194304');
  }
  if (!Number.isSafeInteger(maxEventChars) || maxEventChars < 1 || maxEventChars > HARD_MAX_LINE_CHARS) {
    throw new RangeError('maxEventChars must be an integer between 1 and 4194304');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (typeof shouldRetryError !== 'function') throw new TypeError('shouldRetryError must be a function');
  const base = new URL(endpoint);
  if (retries > 0 && !isLoopback(base) && !allowRemoteRetries) {
    throw new Error('Retries for remote servers require allowRemoteRetries: true');
  }
  const path = base.pathname.replace(/\/+$/, '');
  const suffix = protocol === 'ollama' ? '/api/chat'
    : path.endsWith('/v1') ? '/chat/completions' : '/v1/chat/completions';
  base.pathname = path + suffix;
  base.search = '';
  base.hash = '';
  const url = base;
  const requestHeaders = new Headers(headers);
  requestHeaders.set('content-type', 'application/json');
  const body = JSON.stringify({ model, messages, stream: true });
  const controller = new AbortController();
  let expired = false;
  const callerAbort = () => controller.abort();
  if (signal?.aborted) throw abortError();
  signal?.addEventListener('abort', callerAbort, { once: true });
  const timer = setTimeout(() => { expired = true; controller.abort(); }, timeoutMs);
  const started = performance.now();
  const remainingMs = () => timeoutMs - (performance.now() - started);
  const checkDeadline = () => {
    if (expired || remainingMs() <= 0) throw new RequestTimeoutError(timeoutMs);
    if (controller.signal.aborted) throw abortError();
  };
  let partial = false;
  let attempts = 0;
  let callbackFailed = false;
  const emit = event => {
    if (!controller.signal.aborted) {
      try { onEvent(event); } catch (error) { callbackFailed = true; throw error; }
    }
  };
  try {
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      checkDeadline();
      attempts = attempt;
      partial = false;
      let networkPhase = null;
      emit({ type: 'attempt', attempt });
      try {
        checkDeadline();
        const remaining = Math.max(1, Math.ceil(remainingMs()));
        const finishReason = await reliableRequest(url, {
          method: 'POST', body, headers: requestHeaders, retries: 0,
          timeoutMs: remaining, signal: controller.signal,
          fetchImpl: async (...args) => {
            try { return await fetchImpl(...args); }
            catch (error) { networkPhase = 'fetch'; throw error; }
          },
          consume: (response, readSignal) => readStream(response, protocol, readSignal, text => {
            partial = true;
            emit({ type: 'delta', attempt, text });
          }, maxLineChars, maxEventChars, phase => { networkPhase = phase; }),
        });
        checkDeadline();
        const completion = finishReason === null ? {} : { finishReason };
        emit({ type: 'done', attempt, ...completion });
        return { attempts, ...completion };
      } catch (error) {
        if (callbackFailed) throw error;
        if (expired || error instanceof RequestTimeoutError) throw new RequestTimeoutError(timeoutMs);
        if (controller.signal.aborted) throw abortError();
        checkDeadline();
        if (attempt > retries) throw error;
        const http = error instanceof HttpError;
        const retryable = http ? isRetryableStatus(error.status)
          : error instanceof StreamInterruptedError ||
            (networkPhase !== null && shouldRetryError(error, { attempt, method: 'POST', phase: networkPhase }) === true);
        if (!retryable) throw error;
        if (http) discardResponse(error.response);
        const delayMs = retryDelayMs({ attempt, response: http ? error.response : undefined, remainingMs: remainingMs() });
        if (delayMs === null) throw new RequestTimeoutError(timeoutMs, 'Retry delay cannot fit within the ' + timeoutMs + ' ms total timeout');
        emit({ type: 'retry', attempt, error, partial, delayMs });
        checkDeadline();
        try { await pause(delayMs, controller.signal); }
        catch (waitError) { if (expired) throw new RequestTimeoutError(timeoutMs); throw waitError; }
        checkDeadline();
        if (partial) emit({ type: 'reset', attempt: attempt + 1 });
      }
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', callerAbort);
    controller.abort();
  }
}
