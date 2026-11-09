import { reliableRequest, HttpError, RequestTimeoutError } from './index.js';

export class StreamInterruptedError extends Error {
  constructor(message = 'The model stream ended before completion') {
    super(message);
    this.name = 'StreamInterruptedError';
    this.code = 'STREAM_INTERRUPTED';
  }
}

export class StreamLineTooLongError extends Error {
  constructor(maxLineChars) {
    super(`A model stream line exceeded the ${maxLineChars} character limit`);
    this.name = 'StreamLineTooLongError';
    this.code = 'STREAM_LINE_TOO_LONG';
    this.maxLineChars = maxLineChars;
  }
}

export class UnsupportedModelOutputError extends Error {
  constructor() {
    super('Tool calls are not supported by this text-only API');
    this.name = 'UnsupportedModelOutputError';
    this.code = 'UNSUPPORTED_MODEL_OUTPUT';
  }
}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const DEFAULT_MAX_LINE_CHARS = 262_144;
const HARD_MAX_LINE_CHARS = 4_194_304;
const MAX_DECODE_CHUNK_BYTES = 16 * 1024;
const abortError = () => new DOMException('Request cancelled', 'AbortError');

function isLoopback(url) {
  return url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\./.test(url.hostname);
}

function delay(ms, signal) {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); cleanup(); reject(abortError()); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function readStream(response, protocol, signal, emit, maxLineChars) {
  if (!response.body) throw new StreamInterruptedError('The response has no stream');
  const reader = response.body.getReader();
  const abort = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  let buffer = '';
  let complete = false;
  let finishReason = null;
  const decoder = new TextDecoder();
  const line = (raw) => {
    if (protocol === 'openai') {
      const text = raw.trim();
      if (!text.startsWith('data:')) return;
      const data = text.slice(5).trim();
      if (data === '[DONE]') { complete = true; return; }
      if (!data) return;
      let event;
      try { event = JSON.parse(data); }
      catch { throw new Error('Invalid OpenAI-compatible stream event'); }
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
      if (event.error) throw new Error(String(event.error));
      if (event.message?.tool_calls?.length) throw new UnsupportedModelOutputError();
      if (typeof event.done_reason === 'string') finishReason = event.done_reason;
      const content = event.message?.content;
      if (typeof content === 'string' && content) emit(content);
      if (event.done === true) complete = true;
    }
  };
  // Limit *each protocol line*, not the entire answer. A response can have
  // arbitrarily many short lines without growing our parser's pending buffer.
  // Decode large network chunks in small slices to avoid huge intermediate strings.
  const processText = text => {
    let start = 0;
    while (start < text.length && !complete) {
      const newline = text.indexOf('\n', start);
      const end = newline < 0 ? text.length : newline;
      const segmentLength = end - start;
      if (buffer.length + segmentLength > maxLineChars) {
        throw new StreamLineTooLongError(maxLineChars);
      }
      buffer += text.slice(start, end);
      if (newline < 0) break;
      const current = buffer;
      buffer = '';
      line(current);
      start = newline + 1;
    }
  };
  try {
    while (!complete) {
      const { value, done } = await reader.read();
      if (signal.aborted) throw abortError();
      if (done) {
        processText(decoder.decode());
        if (!complete && buffer.trim()) line(buffer);
        break;
      }
      for (let start = 0; start < value.byteLength && !complete; start += MAX_DECODE_CHUNK_BYTES) {
        const bytes = value.subarray(start, start + MAX_DECODE_CHUNK_BYTES);
        processText(decoder.decode(bytes, { stream: true }));
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
  fetchImpl,
  allowRemoteRetries = false,
  maxLineChars = DEFAULT_MAX_LINE_CHARS,
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
      attempts = attempt;
      partial = false;
      emit({ type: 'attempt', attempt });
      try {
        const remaining = Math.max(1, Math.ceil(timeoutMs - (performance.now() - started)));
        const finishReason = await reliableRequest(url, {
          method: 'POST', body, headers: requestHeaders, retries: 0,
          timeoutMs: remaining, signal: controller.signal, fetchImpl,
          consume: (response, readSignal) => readStream(response, protocol, readSignal, text => {
            partial = true;
            emit({ type: 'delta', attempt, text });
          }, maxLineChars),
        });
        const completion = finishReason === null ? {} : { finishReason };
        emit({ type: 'done', attempt, ...completion });
        return { attempts, ...completion };
      } catch (error) {
        if (callbackFailed) throw error;
        if (expired || error instanceof RequestTimeoutError) throw new RequestTimeoutError(timeoutMs);
        if (controller.signal.aborted) throw abortError();
        const retryable = error instanceof StreamInterruptedError || error instanceof TypeError ||
          (error instanceof HttpError && RETRY_STATUSES.has(error.status));
        if (!retryable || attempt > retries) throw error;
        if (error instanceof HttpError) error.response.body?.cancel().catch(() => {});
        emit({ type: 'retry', attempt, error, partial });
        try { await delay(Math.min(200 * 2 ** (attempt - 1), 3_000), controller.signal); }
        catch (waitError) { if (expired) throw new RequestTimeoutError(timeoutMs); throw waitError; }
        if (expired) throw new RequestTimeoutError(timeoutMs);
        if (partial) emit({ type: 'reset', attempt: attempt + 1 });
      }
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', callerAbort);
    controller.abort();
  }
}
