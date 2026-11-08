import test from 'node:test';
import assert from 'node:assert/strict';
import { streamLocalChat, StreamLineTooLongError } from '../src/local-chat.js';

const encoder = new TextEncoder();
const openaiLine = text => 'data: ' + JSON.stringify({
  choices: [{ delta: { content: text } }],
});
const ollamaLine = text => JSON.stringify({ message: { content: text }, done: false });

function responseFromParts(parts, onCancel = () => {}) {
  let index = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (index < parts.length) controller.enqueue(parts[index++]);
      else controller.close();
    },
    cancel: onCancel,
  }));
}
function split(bytes, length) {
  const pieces = [];
  for (let start = 0; start < bytes.length; start += length) {
    pieces.push(bytes.subarray(start, start + length));
  }
  return pieces;
}
const request = (overrides = {}) => streamLocalChat({
  endpoint: 'http://127.0.0.1:1234',
  model: 'test-model',
  messages: [],
  timeoutMs: 3000,
  onEvent: () => {},
  ...overrides,
});

test('oversized OpenAI SSE protocol line fails clearly without an automatic retry', async () => {
  const bytes = encoder.encode(openaiLine('x'.repeat(500)) + '\n\n');
  let fetches = 0;
  let cancelled = false;
  const events = [];
  await assert.rejects(request({
    maxLineChars: 128, retries: 3,
    onEvent: event => events.push(event.type),
    fetchImpl: async () => {
      fetches++;
      return responseFromParts(split(bytes, 19), () => { cancelled = true; });
    },
  }), error => error instanceof StreamLineTooLongError &&
    error.code === 'STREAM_LINE_TOO_LONG' && error.maxLineChars === 128);
  assert.equal(fetches, 1);
  assert.equal(cancelled, true, 'reader should cancel an oversized response');
  assert.deepEqual(events, ['attempt']);
});

test('oversized unfinished Ollama NDJSON line fails before its end', async () => {
  let fetches = 0;
  const bytes = encoder.encode(ollamaLine('y'.repeat(2000)));
  await assert.rejects(request({
    protocol: 'ollama', maxLineChars: 256, retries: 2,
    fetchImpl: async () => {
      fetches++;
      return responseFromParts(split(bytes, 32));
    },
  }), StreamLineTooLongError);
  assert.equal(fetches, 1);
});

test('many small protocol lines in one large network chunk do not trigger the per-line limit', async () => {
  const count = 900;
  const lines = Array.from({ length: count }, () => ollamaLine('ok') + '\n').join('') +
    JSON.stringify({ done: true }) + '\n';
  assert.ok(lines.length > 20_000, 'exercise a large HTTP chunk');
  let received = '';
  await request({
    protocol: 'ollama', maxLineChars: 128,
    onEvent: event => { if (event.type === 'delta') received += event.text; },
    fetchImpl: async () => responseFromParts([encoder.encode(lines)]),
  });
  assert.equal(received, 'ok'.repeat(count));
});

test('exact maximum line length is accepted, but one character more is rejected', async () => {
  const first = openaiLine('works');
  const answer = first + '\n\ndata: [DONE]\n\n';
  let result = '';
  await request({
    maxLineChars: first.length,
    onEvent: event => { if (event.type === 'delta') result += event.text; },
    fetchImpl: async () => responseFromParts(split(encoder.encode(answer), 7)),
  });
  assert.equal(result, 'works');
  await assert.rejects(request({
    maxLineChars: first.length - 1,
    fetchImpl: async () => responseFromParts([encoder.encode(answer)]),
  }), StreamLineTooLongError);
});

test('invalid line-size options fail before starting a request', async () => {
  for (const maxLineChars of [0, -1, 0.5, NaN, Infinity, 4_194_305]) {
    let called = false;
    await assert.rejects(request({
      maxLineChars,
      fetchImpl: async () => { called = true; throw new Error('must not run'); },
    }), RangeError);
    assert.equal(called, false);
  }
});

test('large valid streamed answers can be longer than the per-line limit', async () => {
  const line = openaiLine('x'.repeat(30));
  const count = 600;
  const text = (line + '\n\n').repeat(count) + 'data: [DONE]\n\n';
  let characters = 0;
  await request({
    maxLineChars: line.length,
    onEvent: event => { if (event.type === 'delta') characters += event.text.length; },
    fetchImpl: async () => responseFromParts(split(encoder.encode(text), 4096)),
  });
  assert.equal(characters, 30 * count);
});
