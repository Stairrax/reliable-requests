import test from 'node:test';
import assert from 'node:assert/strict';
import { streamLocalChat, StreamInterruptedError } from '../src/local-chat.js';
import { reliableRequest, RequestTimeoutError } from '../src/index.js';

const encoder = new TextEncoder();
const chunksResponse = chunks => new Response(new ReadableStream({
  start(controller) {
    for (const bytes of chunks) controller.enqueue(bytes);
    controller.close();
  },
}));
const openaiEvent = content => 'data: ' + JSON.stringify({
  choices: [{ delta: { content } }],
}) + '\n\n';

test('OpenAI SSE survives a Unicode character split across arbitrary network chunks', async () => {
  const encoded = encoder.encode(openaiEvent('Hello 🌍') + 'data: [DONE]\n\n');
  const position = encoded.indexOf(0xF0);
  assert.ok(position >= 0);
  const pieces = [encoded.slice(0, position + 2), encoded.slice(position + 2, position + 3),
    encoded.slice(position + 3, encoded.length - 2), encoded.slice(encoded.length - 2)];
  let shown = '';
  await streamLocalChat({
    endpoint: 'http://127.0.0.1:1234', model: 'test', messages: [],
    onEvent(event) { if (event.type === 'delta') shown += event.text; },
    fetchImpl: async () => chunksResponse(pieces),
  });
  assert.equal(shown, 'Hello 🌍');
});

test('Ollama handles a fragmented completion marker with no trailing newline', async () => {
  const bytes = encoder.encode(JSON.stringify({ message: { content: 'fine' }, done: false }) +
    '\n' + JSON.stringify({ done: true }));
  const pieces = Array.from({ length: Math.ceil(bytes.length / 3) },
    (_, i) => bytes.slice(i * 3, (i + 1) * 3));
  let output = '';
  await streamLocalChat({
    endpoint: 'http://localhost:11434', protocol: 'ollama', model: 'test', messages: [],
    onEvent(event) { if (event.type === 'delta') output += event.text; },
    fetchImpl: async () => chunksResponse(pieces),
  });
  assert.equal(output, 'fine');
});

test('invalid protocol JSON fails immediately rather than retrying', async () => {
  let requests = 0;
  await assert.rejects(streamLocalChat({
    endpoint: 'http://localhost:11434', protocol: 'ollama', model: 'test', messages: [],
    retries: 3, onEvent: () => {},
    fetchImpl: async () => { requests++; return chunksResponse([encoder.encode('not-json\n')]); },
  }), /Invalid Ollama stream event/);
  assert.equal(requests, 1);
});

test('an interrupted stream stops after its configured retry budget', async () => {
  let calls = 0;
  let resets = 0;
  await assert.rejects(streamLocalChat({
    endpoint: 'http://127.0.0.1:1234', model: 'test', messages: [], retries: 2,
    timeoutMs: 5000,
    onEvent(event) { if (event.type === 'reset') resets++; },
    fetchImpl: async () => {
      calls++;
      return chunksResponse([encoder.encode(openaiEvent('incomplete'))]);
    },
  }), StreamInterruptedError);
  assert.equal(calls, 3);
  assert.equal(resets, 2);
});

test('a total deadline also covers waiting to retry Retry-After responses', async () => {
  let requests = 0;
  await assert.rejects(reliableRequest('http://127.0.0.1:9999', {
    timeoutMs: 40, retries: 5,
    fetchImpl: async () => {
      requests++;
      return new Response('', { status: 429, headers: { 'retry-after': '100' } });
    },
  }), RequestTimeoutError);
  assert.equal(requests, 1);
});
