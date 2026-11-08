import test from 'node:test';
import assert from 'node:assert/strict';
import { streamLocalChat, StreamInterruptedError } from '../src/local-chat.js';
import { RequestTimeoutError } from '../src/index.js';

const encoder = new TextEncoder();
const streamResponse = (chunks, status = 200) => new Response(new ReadableStream({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    controller.close();
  },
}), { status });
const openai = text => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

test('a local OpenAI-compatible stream completes', async () => {
  const events = [];
  const result = await streamLocalChat({
    endpoint: 'http://localhost:1234/v1', model: 'qwen', messages: [{ role: 'user', content: 'Hi' }],
    onEvent: event => events.push(event),
    fetchImpl: async (url, init) => {
      assert.equal(String(url), 'http://localhost:1234/v1/chat/completions');
      assert.equal(JSON.parse(init.body).model, 'qwen');
      return streamResponse([openai('Hello'), 'data: [DONE]\n\n']);
    },
  });
  assert.deepEqual(result, { attempts: 1 });
  assert.deepEqual(events.map(e => e.type), ['attempt', 'delta', 'done']);
  assert.equal(events[1].text, 'Hello');
});

test('Ollama NDJSON works with arbitrary installed model names', async () => {
  const events = [];
  await streamLocalChat({
    endpoint: 'http://127.0.0.1:11434', protocol: 'ollama', model: 'qwen2.5:7b',
    messages: [{ role: 'user', content: 'Hi' }], onEvent: event => events.push(event),
    fetchImpl: async (url) => {
      assert.equal(String(url), 'http://127.0.0.1:11434/api/chat');
      return streamResponse(['{"message":{"content":"Hi"},"done":false}\n', '{"done":true}\n']);
    },
  });
  assert.equal(events.find(e => e.type === 'delta').text, 'Hi');
});

test('partial stream is reset before automatic restart', async () => {
  let calls = 0;
  const events = [];
  const result = await streamLocalChat({
    endpoint: 'http://localhost:1234', model: 'qwen', messages: [{ role: 'user', content: 'Hi' }],
    onEvent: event => events.push(event),
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? streamResponse([openai('old')]) // no [DONE]: truncated response
        : streamResponse([openai('new'), 'data: [DONE]\n\n']);
    },
  });
  assert.equal(result.attempts, 2);
  assert.deepEqual(events.map(e => e.type), ['attempt', 'delta', 'retry', 'reset', 'attempt', 'delta', 'done']);
  assert.equal(events.find(e => e.type === 'reset').attempt, 2);
  assert.deepEqual(events.filter(e => e.type === 'delta').map(e => e.text), ['old', 'new']);
});

test('transient HTTP errors retry but bad requests do not', async () => {
  let calls = 0;
  await streamLocalChat({
    endpoint: 'http://localhost:1234', model: 'qwen', messages: [], onEvent: () => {},
    fetchImpl: async () => ++calls === 1 ? new Response('', { status: 503 }) : streamResponse(['data: [DONE]\n\n']),
  });
  assert.equal(calls, 2);
  await assert.rejects(streamLocalChat({
    endpoint: 'http://localhost:1234', model: 'qwen', messages: [], onEvent: () => {},
    fetchImpl: async () => new Response('', { status: 400 }),
  }), error => error.status === 400);
});

test('remote automatic retries require explicit opt-in', async () => {
  await assert.rejects(streamLocalChat({
    endpoint: 'https://api.example.com', model: 'qwen', messages: [], onEvent: () => {},
  }), /allowRemoteRetries/);
});

test('a stalled stream stops at the total deadline', async () => {
  const events = [];
  await assert.rejects(streamLocalChat({
    endpoint: 'http://localhost:1234', model: 'qwen', messages: [],
    timeoutMs: 30, onEvent: event => events.push(event),
    fetchImpl: async () => new Response(new ReadableStream({ start() {} })),
  }), RequestTimeoutError);
  assert.equal(events.filter(e => e.type === 'attempt').length, 1);
});

test('incomplete stream reports a clear error when retries run out', async () => {
  await assert.rejects(streamLocalChat({
    endpoint: 'http://localhost:1234', model: 'qwen', messages: [],
    retries: 0, onEvent: () => {},
    fetchImpl: async () => streamResponse([openai('partial')]),
  }), StreamInterruptedError);
});
