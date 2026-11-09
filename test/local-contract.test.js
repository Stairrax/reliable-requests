import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { streamLocalChat, UnsupportedModelOutputError } from '../src/local-chat.js';

const body = (...chunks) => new Response(chunks.join(''), { headers: { 'content-type': 'text/event-stream' } });
const data = value => `data: ${JSON.stringify(value)}\n\n`;
const opts = { endpoint: 'http://localhost:1234', model: 'test', messages: [], onEvent: () => {} };

test('callback TypeError is propagated without another model request', async () => {
  let calls = 0;
  const problem = new TypeError('UI broke');
  await assert.rejects(streamLocalChat({
    ...opts,
    fetchImpl: async () => { calls++; return body(data({choices:[{delta:{content:'hello'}}]}), 'data: [DONE]\n\n'); },
    onEvent: event => { if (event.type === 'delta') throw problem; },
  }), error => error === problem);
  assert.equal(calls, 1);
});

test('prefixes are preserved for both supported protocols', async () => {
  for (const [protocol, endpoint, expected, response] of [
    ['openai', 'http://localhost:1234/proxy/v1', '/proxy/v1/chat/completions', 'data: [DONE]\n\n'],
    ['openai', 'http://localhost:1234/proxy', '/proxy/v1/chat/completions', 'data: [DONE]\n\n'],
    ['ollama', 'http://localhost:1234/proxy/', '/proxy/api/chat', '{"done":true}\n'],
  ]) {
    let path;
    await streamLocalChat({ ...opts, protocol, endpoint, fetchImpl: async url => {
      path = url.pathname; return body(response);
    } });
    assert.equal(path, expected);
  }
});

test('reports truncation reason from both protocols', async () => {
  for (const [protocol, response] of [
    ['openai', data({choices:[{delta:{content:'partial'},finish_reason:'length'}]}) + 'data: [DONE]\n\n'],
    ['ollama', '{"message":{"content":"partial"},"done":true,"done_reason":"length"}\n'],
  ]) {
    const events = [];
    const result = await streamLocalChat({ ...opts, protocol,
      fetchImpl: async () => body(response), onEvent: e => events.push(e) });
    assert.equal(result.finishReason, 'length');
    assert.equal(events.at(-1).finishReason, 'length');
  }
});

test('unsupported model tool calls fail explicitly without retry', async () => {
  for (const [protocol, response] of [
    ['openai', data({choices:[{delta:{tool_calls:[{index:0}]}}]})],
    ['ollama', '{"message":{"tool_calls":[{"function":{"name":"run"}}]},"done":false}\n'],
  ]) {
    let calls = 0;
    await assert.rejects(streamLocalChat({ ...opts, protocol,
      fetchImpl: async () => { calls++; return body(response); } }), UnsupportedModelOutputError);
    assert.equal(calls, 1);
  }
});

test('a prefixed OpenAI endpoint works over a real HTTP connection', async () => {
  let requestPath;
  const server = createServer((req, res) => {
    requestPath = req.url;
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(data({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    let text = '';
    const result = await streamLocalChat({ ...opts,
      endpoint: `http://127.0.0.1:${server.address().port}/proxy/v1`,
      onEvent: e => { if (e.type === 'delta') text += e.text; },
    });
    assert.equal(requestPath, '/proxy/v1/chat/completions');
    assert.equal(text, 'ok');
    assert.equal(result.finishReason, 'stop');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
