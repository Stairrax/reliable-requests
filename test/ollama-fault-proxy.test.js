// Real network integration tests of the one-shot loopback Ollama fault injector.
// These use a tiny fake upstream for CI; the optional CLI verifies a real installed model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createOneShotOllamaFaultProxy } from '../examples/ollama-fault-proxy.mjs';
import { streamLocalChat } from '../src/local-chat.js';

async function fakeOllama(handler, run) {
  const server = createServer(handler);
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await run('http://127.0.0.1:' + server.address().port);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

const eventLine = (text, done = false) => JSON.stringify({
  message: { content: text }, done,
}) + '\n';

test('real TCP: proxy cuts one Ollama text stream and the client resets correctly', async () => {
  let actualOllamaCalls = 0;
  await fakeOllama(async (req, res) => {
    actualOllamaCalls++;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/api/chat');
    const incoming = [];
    for await (const chunk of req) incoming.push(chunk);
    const body = JSON.parse(Buffer.concat(incoming).toString());
    assert.equal(body.model, 'fake-local-model');
    assert.equal(body.stream, true);
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    if (actualOllamaCalls === 1) {
      res.write(eventLine('DISCARD ME'));
      const timer = setTimeout(() => {
        if (!res.destroyed) res.end(eventLine('not expected', true));
      }, 1500);
      res.on('close', () => clearTimeout(timer));
    } else {
      res.end(eventLine('NEW ANSWER') + eventLine('', true));
    }
  }, async upstream => {
    const proxy = await createOneShotOllamaFaultProxy({ upstream });
    try {
      let visible = '';
      const types = [];
      const result = await streamLocalChat({
        endpoint: proxy.endpoint, protocol: 'ollama', model: 'fake-local-model',
        messages: [{ role: 'user', content: 'A safe test' }],
        headers: { 'x-rr-test-token': proxy.token },
        retries: 1, timeoutMs: 5000,
        onEvent(event) {
          types.push(event.type);
          if (event.type === 'reset') visible = '';
          if (event.type === 'delta') visible += event.text;
        },
      });
      assert.deepEqual(result, { attempts: 2 });
      assert.equal(visible, 'NEW ANSWER');
      assert.deepEqual(types, ['attempt', 'delta', 'retry', 'reset', 'attempt', 'delta', 'done']);
      assert.deepEqual(proxy.snapshot(), {
        requests: 2, forcedCuts: 1, forwardedTextEvents: 1,
      });
      assert.equal(actualOllamaCalls, 2);
    } finally {
      await proxy.close();
    }
  });
});

test('proxy refuses unauthenticated and browser-origin requests before Ollama', async () => {
  let calls = 0;
  await fakeOllama((_, res) => { calls++; res.end('unexpected'); }, async upstream => {
    const proxy = await createOneShotOllamaFaultProxy({ upstream });
    try {
      const body = JSON.stringify({ model: 'a', messages: [], stream: true });
      const denied = await fetch(proxy.endpoint + '/api/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body,
      });
      assert.equal(denied.status, 403);
      const browser = await fetch(proxy.endpoint + '/api/chat', {
        method: 'POST', headers: {
          'content-type': 'application/json',
          origin: 'https://some-other-site.example',
          'x-rr-test-token': proxy.token,
        }, body,
      });
      assert.equal(browser.status, 403);
      const route = await fetch(proxy.endpoint + '/unknown');
      assert.equal(route.status, 404);
      assert.equal(calls, 0);
      assert.equal(proxy.snapshot().requests, 0);
    } finally { await proxy.close(); }
  });
});

test('proxy refuses remote upstreams and invalid model requests', async () => {
  await assert.rejects(createOneShotOllamaFaultProxy({
    upstream: 'https://api.example.com',
  }), /127\.0\.0\.1/);
  await fakeOllama((_, res) => res.end('unused'), async upstream => {
    const proxy = await createOneShotOllamaFaultProxy({ upstream });
    try {
      const response = await fetch(proxy.endpoint + '/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rr-test-token': proxy.token },
        body: JSON.stringify({ model: 'm', messages: [], stream: false }),
      });
      assert.equal(response.status, 400);
      assert.equal(proxy.snapshot().requests, 0);
    } finally { await proxy.close(); }
  });
});
