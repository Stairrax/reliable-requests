import test from 'node:test';
import assert from 'node:assert/strict';
import { reliableRequest, RequestTimeoutError, HttpError } from '../src/index.js';

const response = (status = 200, headers = {}) => new Response('ok', { status, headers });

test('one timeout stops a fetch that ignores abort', async () => {
  const start = performance.now();
  await assert.rejects(
    reliableRequest('https://example.test', { timeoutMs: 25, fetchImpl: () => new Promise(() => {}) }),
    error => error instanceof RequestTimeoutError && error.code === 'REQUEST_TIMEOUT'
  );
  assert.ok(performance.now() - start < 1000);
});

test('the same timeout covers response body consumption', async () => {
  await assert.rejects(
    reliableRequest('https://example.test', {
      timeoutMs: 25,
      fetchImpl: async () => response(),
      consume: () => new Promise(() => {}),
    }),
    RequestTimeoutError
  );
});

test('caller abort stops retry backoff without another attempt', async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = reliableRequest('https://example.test', {
    timeoutMs: 1000, retries: 3, signal: controller.signal,
    fetchImpl: async () => { calls++; return response(503); },
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('already aborted requests never call fetch', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(reliableRequest('https://example.test', {
    signal: controller.signal, fetchImpl: () => { calls++; },
  }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('GET retries selected HTTP statuses and respects Retry-After', async () => {
  let calls = 0;
  const value = await reliableRequest('https://example.test', {
    retries: 2, timeoutMs: 1000,
    fetchImpl: async () => ++calls === 1 ? response(429, { 'Retry-After': '0' }) : response(),
    consume: res => res.text(),
  });
  assert.equal(value, 'ok');
  assert.equal(calls, 2);
});

test('POST is never repeated, even when retries are configured', async () => {
  let calls = 0;
  await assert.rejects(reliableRequest('https://example.test', {
    method: 'POST', body: '{}', retries: 5,
    fetchImpl: async () => { calls++; return response(503); },
  }), error => error instanceof HttpError && error.status === 503 && error.attempts === 1);
  assert.equal(calls, 1);
});

test('network failures retry only for safe methods', async () => {
  let calls = 0;
  const result = await reliableRequest('https://example.test', {
    timeoutMs: 1000,
    fetchImpl: async () => { if (++calls === 1) throw new TypeError('network'); return response(); },
  });
  assert.equal(result.status, 200);
  assert.equal(calls, 2);
});

test('a consumer can read a stream under the same deadline', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('first')); },
    cancel() { cancelled = true; },
  });
  const chunks = [];
  await assert.rejects(reliableRequest('https://example.test', {
    timeoutMs: 25,
    fetchImpl: async () => new Response(stream),
    consume: async (res, signal) => {
      const reader = res.body.getReader();
      const onAbort = () => { reader.cancel().catch(() => {}); };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          chunks.push(new TextDecoder().decode(value));
        }
      } finally {
        signal.removeEventListener('abort', onAbort);
        reader.releaseLock();
      }
    },
  }), RequestTimeoutError);
  assert.deepEqual(chunks, ['first']);
  assert.equal(cancelled, true);
});

test('non-retryable status preserves the response for inspection', async () => {
  await assert.rejects(reliableRequest('https://example.test', {
    fetchImpl: async () => response(404),
  }), error => error instanceof HttpError && error.status === 404 && error.response.status === 404);
});
