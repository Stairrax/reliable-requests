import { reliableRequest, HttpError, RequestTimeoutError } from './index.js';

export class StreamInterruptedError extends Error {
  constructor(message = 'The model stream ended before completion') {
    super(message);
    this.name = 'StreamInterruptedError';
    this.code = 'STREAM_INTERRUPTED';
  }
}

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
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

async function readStream(response, protocol, signal, emit) {
  if (!response.body) throw new StreamInterruptedError('The response has no stream');
  const reader = response.body.getReader();
  const abort = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  let buffer = '';
  let complete = false;
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
      const content = event.choices?.[0]?.delta?.content;
      if (typeof content === 'string' && content) emit(content);
    } else {
      const text = raw.trim();
      if (!text) return;
      let event;
      try { event = JSON.parse(text); }
      catch { throw new Error('Invalid Ollama stream event'); }
      if (event.error) throw new Error(String(event.error));
      const content = event.message?.content;
      if (typeof content === 'string' && content) emit(content);
      if (event.done === true) complete = true;
    }
  };
  try {
    while (!complete) {
      const { value, done } = await reader.read();
      if (signal.aborted) throw abortError();
      if (done) {
        buffer += decoder.decode();
        if (buffer.trim()) line(buffer);
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n')) >= 0 && !complete) {
        const current = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        line(current);
      }
    }
    if (!complete) throw new StreamInterruptedError();
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
} = {}) {
  if (protocol !== 'openai' && protocol !== 'ollama') throw new TypeError('protocol must be openai or ollama');
  if (!model || typeof model !== 'string') throw new TypeError('model is required');
  if (!Array.isArray(messages) || !messages.every(m => typeof m?.role === 'string' && typeof m?.content === 'string')) {
    throw new TypeError('messages must contain text-only role/content pairs');
  }
  if (typeof onEvent !== 'function') throw new TypeError('onEvent is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new RangeError('invalid timeoutMs');
  if (!Number.isSafeInteger(retries) || retries < 0) throw new RangeError('invalid retries');
  const base = new URL(endpoint);
  if (retries > 0 && !isLoopback(base) && !allowRemoteRetries) {
    throw new Error('Retries for remote servers require allowRemoteRetries: true');
  }
  const url = new URL(protocol === 'ollama' ? '/api/chat' : '/v1/chat/completions', base);
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
  const emit = event => { if (!controller.signal.aborted) onEvent(event); };
  try {
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      attempts = attempt;
      partial = false;
      emit({ type: 'attempt', attempt });
      try {
        const remaining = Math.max(1, Math.ceil(timeoutMs - (performance.now() - started)));
        await reliableRequest(url, {
          method: 'POST', body, headers: requestHeaders, retries: 0,
          timeoutMs: remaining, signal: controller.signal, fetchImpl,
          consume: (response, readSignal) => readStream(response, protocol, readSignal, text => {
            partial = true;
            emit({ type: 'delta', attempt, text });
          }),
        });
        emit({ type: 'done', attempt });
        return { attempts };
      } catch (error) {
        if (expired || error instanceof RequestTimeoutError) throw new RequestTimeoutError(timeoutMs);
        if (controller.signal.aborted) throw abortError();
        const retryable = error instanceof StreamInterruptedError || error instanceof TypeError ||
          (error instanceof HttpError && RETRY_STATUSES.has(error.status));
        if (!retryable || attempt > retries) throw error;
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
