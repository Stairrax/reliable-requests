// Stream parser stress tests: all synthetic and deterministic; no local model required.
import test from 'node:test';
import assert from 'node:assert/strict';
import { streamLocalChat } from '../src/local-chat.js';

const encode = new TextEncoder();
const ollamaLine = text => JSON.stringify({ message: { content: text }, done: false }) + '\n';
const openaiLine = text => 'data: ' +
  JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n';

function chunkedStream({ count, batchSize, line, finish }) {
  let produced = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (produced === count) {
        controller.enqueue(encode.encode(finish));
        produced++;
        return;
      }
      if (produced > count) {
        controller.close();
        return;
      }
      const lines = Math.min(batchSize, count - produced);
      controller.enqueue(encode.encode(line.repeat(lines)));
      produced += lines;
    },
  }));
}
const call = (options = {}) => streamLocalChat({
  endpoint: 'http://127.0.0.1:1234',
  protocol: 'ollama',
  model: 'stress-fake',
  messages: [],
  retries: 0,
  timeoutMs: 10_000,
  maxLineChars: 128,
  onEvent: () => {},
  ...options,
});

test('Ollama: processes 20,000 events without limiting total output length', async () => {
  const count = 20_000;
  let chunks = 0;
  let chars = 0;
  let done = 0;
  await call({
    fetchImpl: async () => chunkedStream({
      count, batchSize: 130, line: ollamaLine('abc'), finish: '{"done":true}\n',
    }),
    onEvent(event) {
      if (event.type === 'delta') { chunks++; chars += event.text.length; }
      if (event.type === 'done') done++;
    },
  });
  assert.equal(chunks, count);
  assert.equal(chars, count * 3);
  assert.equal(done, 1);
});

test('OpenAI: 16,000 SSE events with small per-line limit', async () => {
  const count = 16_000;
  let chars = 0;
  let done = 0;
  await call({
    protocol: 'openai',
    fetchImpl: async () => chunkedStream({
      count, batchSize: 180, line: openaiLine('⚙️'), finish: 'data: [DONE]\n\n',
    }),
    onEvent(event) {
      if (event.type === 'delta') chars += event.text.length;
      if (event.type === 'done') done++;
    },
  });
  assert.equal(chars, '⚙️'.length * count);
  assert.equal(done, 1);
});

test('several completed generations release readers and preserve event totals', async () => {
  let cancelled = 0;
  let attempts = 0;
  let done = 0;
  const count = 900;
  for (let iteration = 0; iteration < 8; iteration++) {
    let total = 0;
    await call({
      fetchImpl: async () => {
        let emitted = 0;
        return new Response(new ReadableStream({
          pull(controller) {
            if (emitted < count) {
              controller.enqueue(encode.encode(ollamaLine('Z')));
              emitted++;
            } else if (emitted === count) {
              controller.enqueue(encode.encode('{"done":true}\n'));
              emitted++;
            } else {
              controller.close();
            }
          },
          cancel() { cancelled++; },
        }));
      },
      onEvent(event) {
        if (event.type === 'attempt') attempts++;
        if (event.type === 'done') done++;
        if (event.type === 'delta') total += event.text.length;
      },
    });
    assert.equal(total, count);
  }
  assert.equal(done, 8);
  assert.equal(attempts, 8);
  assert.equal(cancelled, 8);
});
