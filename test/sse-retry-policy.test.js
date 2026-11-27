import test from 'node:test';
import assert from 'node:assert/strict';
import { reliableRequest, RequestTimeoutError } from '../src/index.js';
import { streamLocalChat, StreamInterruptedError, StreamEventTooLongError } from '../src/local-chat.js';
import { createSseParser } from '../src/sse.js';
import { retryAfterMs, retryDelayMs } from '../src/retry.js';

const encoder = new TextEncoder();
const options = {
  endpoint: 'http://localhost:1234',
  model: 'test',
  messages: [],
  retries: 1,
  timeoutMs: 3000,
  onEvent: () => {},
};
const done = () => new Response('data: [DONE]\n\n');
const httpError = value => new Response('', { status: 429, headers: { 'Retry-After': value } });

function fragmented(text, step = 1) {
  const bytes = encoder.encode(text);
  return new Response(new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += step) controller.enqueue(bytes.subarray(i, i + step));
      controller.close();
    },
  }));
}

test('SSE joins data fields, handles all line endings and UTF-8 split across bytes', async () => {
  const text = '\uFEFF: heartbeat\r\nid: 12\revent: message\nretry: 100\r\n' +
    'data: {"choices":[\r\ndata: {"delta":{"content":"Привет 🌍"}}\r' +
    ': comment\n' + 'data: ]}\r\n\r\n' +
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\r' +
    'data: [DONE]\n\n';
  const events = [];
  const result = await streamLocalChat({
    ...options, onEvent: event => events.push(event),
    fetchImpl: async () => fragmented(text),
  });
  assert.deepEqual(result, { attempts: 1, finishReason: 'stop' });
  assert.deepEqual(events.map(event => event.type), ['attempt', 'delta', 'done']);
  assert.equal(events[1].text, 'Привет 🌍');
});

test('SSE field whitespace, empty data and event boundaries follow data framing', () => {
  const data = [];
  const parser = createSseParser({ maxLineChars: 100, maxEventChars: 100, onData: value => data.push(value) });
  for (const chunk of ['data:  first\r', '\ndata:second\r', '\ndata\r', '\n\r', '\n',
    'Data: ignored\n: ping\n\n', 'data:\n\n', 'data: lost\n']) parser.push(chunk);
  parser.finish();
  assert.deepEqual(data, [' first\nsecond\n', '']);
});

test('EOF never dispatches an incomplete SSE event or accepts an incomplete DONE', async () => {
  for (const ending of ['data: [DONE]', 'data: [DONE]\n', 'data: [DONE]\r\n']) {
    const events = [];
    await assert.rejects(streamLocalChat({
      ...options, retries: 0, onEvent: event => events.push(event.type),
      fetchImpl: async () => new Response(ending),
    }), StreamInterruptedError);
    assert.deepEqual(events, ['attempt']);
  }
  const events = [];
  await streamLocalChat({
    ...options, onEvent: event => events.push(event),
    fetchImpl: async () => events.filter(event => event.type === 'attempt').length === 1
      ? new Response('data: {"choices":[{"delta":{"content":"old"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"not dispatched"}}]}\n')
      : new Response('data: {"choices":[{"delta":{"content":"fresh"}}]}\n\ndata: [DONE]\n\n'),
  });
  assert.deepEqual(events.filter(event => event.type === 'delta').map(event => event.text), ['old', 'fresh']);
  assert.deepEqual(events.map(event => event.type), ['attempt', 'delta', 'retry', 'reset', 'attempt', 'delta', 'done']);
});

test('SSE event limit counts joined data and does not limit total output', () => {
  const data = [];
  const parser = createSseParser({ maxLineChars: 20, maxEventChars: 5, onData: value => data.push(value) });
  parser.push('data: ab\ndata: cd\n\n'.repeat(5));
  assert.deepEqual(data, Array(5).fill('ab\ncd'));
  assert.throws(() => parser.push('data: ab\ndata: cde\n'), StreamEventTooLongError);
});

test('oversized multiline event cancels the reader without retry or calling the custom predicate', async () => {
  let calls = 0, cancelled = false, classified = 0;
  await assert.rejects(streamLocalChat({
    ...options, maxLineChars: 40, maxEventChars: 24,
    shouldRetryError: () => { classified++; return true; },
    fetchImpl: async () => {
      calls++;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: 1234567890\ndata: 1234567890\ndata: 1234567890\n'));
        },
        cancel() { cancelled = true; },
      }));
    },
  }), error => error instanceof StreamEventTooLongError && error.code === 'STREAM_EVENT_TOO_LONG' && error.maxEventChars === 24);
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
  assert.equal(classified, 0);
  for (const maxEventChars of [0, NaN, 1.5, 4_194_305]) {
    await assert.rejects(streamLocalChat({ ...options, maxEventChars, fetchImpl: () => { calls++; } }), RangeError);
  }
  assert.equal(calls, 1);
});

test('shared delay honors seconds, HTTP dates, jitter and the remaining time budget', () => {
  const now = Date.UTC(2026, 0, 1);
  assert.equal(retryAfterMs(httpError('120'), now), 120000);
  assert.equal(retryAfterMs(httpError('0.25'), now), 250);
  assert.equal(retryAfterMs(httpError(new Date(now + 5000).toUTCString()), now), 5000);
  assert.equal(retryAfterMs(httpError(new Date(now - 5000).toUTCString()), now), 0);
  assert.equal(retryAfterMs(httpError('-1'), now), null);
  assert.equal(retryAfterMs(httpError('not a date'), now), null);
  assert.equal(retryDelayMs({ attempt: 1, remainingMs: 1000, random: () => 0 }), 200);
  assert.equal(retryDelayMs({ attempt: 1, remainingMs: 1000, random: () => 1 }), 250);
  assert.equal(retryDelayMs({ attempt: 100, remainingMs: 10000, random: () => 1 }), 5000);
  assert.equal(retryDelayMs({ attempt: 1, response: httpError('120'), remainingMs: 121000, random: () => 0 }), 120000);
  assert.equal(retryDelayMs({ attempt: 1, response: httpError('120'), remainingMs: 30000, random: () => 0 }), null);
  assert.equal(retryDelayMs({ attempt: 1, remainingMs: 200, random: () => 0 }), null);
});

test('both public APIs wait for Retry-After rather than ignoring the server', async () => {
  const calls = { http: [], stream: [] };
  const events = [];
  await Promise.all([
    reliableRequest('https://example.test', {
      retries: 1, timeoutMs: 5000,
      fetchImpl: async () => {
        calls.http.push(performance.now());
        return calls.http.length === 1 ? httpError('1') : new Response('ok');
      },
    }),
    streamLocalChat({
      ...options, timeoutMs: 5000, onEvent: event => events.push(event),
      fetchImpl: async () => {
        calls.stream.push(performance.now());
        return calls.stream.length === 1 ? httpError('1') : done();
      },
    }),
  ]);
  for (const times of Object.values(calls)) {
    assert.equal(times.length, 2);
    assert.ok(times[1] - times[0] >= 990, 'must not retry before the server allows');
  }
  assert.ok(events.find(event => event.type === 'retry').delayMs >= 1000);
});

test('an unaffordable Retry-After never starts another request in either API', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return httpError('120'); };
  await assert.rejects(reliableRequest('https://example.test', { fetchImpl, timeoutMs: 3000 }), RequestTimeoutError);
  const events = [];
  await assert.rejects(streamLocalChat({ ...options, fetchImpl, onEvent: event => events.push(event.type) }), RequestTimeoutError);
  assert.equal(calls, 2);
  assert.deepEqual(events, ['attempt']);
});

test('custom transport classifier receives context and can accept or reject errors', async () => {
  const transient = new Error('temporary connection failure');
  const contexts = [];
  let calls = 0;
  await reliableRequest('https://example.test', {
    timeoutMs: 3000, retries: 1,
    fetchImpl: async (_, init) => {
      assert.equal('shouldRetryError' in init, false);
      if (++calls === 1) throw transient;
      return new Response('ok');
    },
    shouldRetryError(error, context) { contexts.push(context); return error === transient; },
  });
  assert.deepEqual(contexts, [{ attempt: 1, method: 'GET', phase: 'fetch' }]);
  calls = 0;
  const bad = new TypeError('bad fetch configuration');
  await assert.rejects(reliableRequest('https://example.test', {
    shouldRetryError: () => false,
    fetchImpl: async () => { calls++; throw bad; },
  }), error => error === bad);
  assert.equal(calls, 1);
  calls = 0;
  await streamLocalChat({
    ...options,
    shouldRetryError(error, context) { contexts.push(context); return error === transient; },
    fetchImpl: async () => {
      if (++calls === 1) return new Response(new ReadableStream({ start(controller) { controller.error(transient); } }));
      return done();
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(contexts.at(-1), { attempt: 1, method: 'POST', phase: 'read' });
  calls = 0;
  await assert.rejects(streamLocalChat({
    ...options, shouldRetryError: () => false,
    fetchImpl: async () => { calls++; throw bad; },
  }), error => error === bad);
  assert.equal(calls, 1);
});

test('custom policy cannot bypass method safety, remote opt-in or protocol validation', async () => {
  let called = 0, classified = 0;
  const error = new TypeError('network');
  const policy = () => { classified++; return true; };
  const fetchImpl = async () => { called++; throw error; };
  await assert.rejects(reliableRequest('https://example.test', { method: 'POST', fetchImpl, shouldRetryError: policy }), error);
  assert.equal(called, 1);
  await assert.rejects(streamLocalChat({ ...options, endpoint: 'https://example.test', fetchImpl, shouldRetryError: policy }), /allowRemoteRetries/);
  assert.equal(called, 1);
  await assert.rejects(reliableRequest('https://example.test', {
    fetchImpl: async () => new Response('ok'), consume: () => { throw error; }, shouldRetryError: policy,
  }), error);
  for (const protocol of ['openai', 'ollama']) {
    await assert.rejects(streamLocalChat({
      ...options, protocol, shouldRetryError: policy,
      fetchImpl: async () => {
        called++;
        return new Response(protocol === 'openai' ? 'data: null\n\n' : 'null\n');
      },
    }), /Invalid .* stream event/);
  }
  assert.equal(called, 3);
  assert.equal(classified, 0);
  await assert.rejects(reliableRequest('https://example.test', { shouldRetryError: true, fetchImpl }), TypeError);
  await assert.rejects(streamLocalChat({ ...options, shouldRetryError: true, fetchImpl }), TypeError);
  assert.equal(called, 3);
});

test('abort during streaming retry delay emits no reset or new attempt', async () => {
  const controller = new AbortController();
  const events = [];
  let calls = 0;
  await assert.rejects(streamLocalChat({
    ...options, signal: controller.signal,
    onEvent(event) {
      events.push(event.type);
      if (event.type === 'retry') controller.abort();
    },
    fetchImpl: async () => {
      calls++;
      return new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    },
  }), { name: 'AbortError' });
  assert.equal(calls, 1);
  assert.deepEqual(events, ['attempt', 'delta', 'retry']);
});
