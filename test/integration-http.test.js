// Integration tests with real HTTP sockets, not mocked fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { reliableRequest, HttpError, RequestTimeoutError } from '../src/index.js';
import { streamLocalChat } from '../src/local-chat.js';

async function withServer(handler, run) {
  const server = createServer(handler);
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    const fail = error => reject(error);
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', fail);
      resolve();
    });
  });
  const endpoint = 'http://127.0.0.1:' + server.address().port;
  try {
    await run(endpoint);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

const sse = text => 'data: ' + JSON.stringify({
  choices: [{ delta: { content: text } }],
}) + '\n\n';

test('real HTTP: a broken OpenAI stream resets before the next answer', async () => {
  let requests = 0;
  await withServer((req, res) => {
    requests++;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/chat/completions');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requests === 1) {
      res.write(sse('obsolete answer'));
      setTimeout(() => res.destroy(), 80);
    } else {
      res.end(sse('fresh answer') + 'data: [DONE]\n\n');
    }
  }, async endpoint => {
    let visible = '';
    const types = [];
    const result = await streamLocalChat({
      endpoint, model: 'any-local-model', messages: [{ role: 'user', content: 'Hello' }],
      timeoutMs: 5000, retries: 1,
      onEvent(event) {
        types.push(event.type);
        if (event.type === 'reset') visible = '';
        if (event.type === 'delta') visible += event.text;
      },
    });
    assert.deepEqual(result, { attempts: 2 });
    assert.equal(visible, 'fresh answer');
    assert.deepEqual(types, ['attempt', 'delta', 'retry', 'reset', 'attempt', 'delta', 'done']);
    assert.equal(requests, 2);
  });
});

test('real HTTP: interrupted Ollama NDJSON resets before regeneration', async () => {
  let requests = 0;
  await withServer((req, res) => {
    requests++;
    assert.equal(req.url, '/api/chat');
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    if (requests === 1) {
      res.write(JSON.stringify({ message: { content: 'old' }, done: false }) + '\n');
      setTimeout(() => res.destroy(), 80);
    } else {
      res.end(JSON.stringify({ message: { content: 'new' }, done: false }) + '\n' +
        JSON.stringify({ done: true }) + '\n');
    }
  }, async endpoint => {
    let visible = '';
    const result = await streamLocalChat({
      endpoint, protocol: 'ollama', model: 'local-test-model', messages: [],
      retries: 1, timeoutMs: 5000,
      onEvent(event) {
        if (event.type === 'reset') visible = '';
        if (event.type === 'delta') visible += event.text;
      },
    });
    assert.equal(visible, 'new');
    assert.equal(result.attempts, 2);
    assert.equal(requests, 2);
  });
});

test('real HTTP: GET retries 503, but POST is never repeated by reliableRequest', async () => {
  let getCalls = 0;
  let postCalls = 0;
  await withServer((req, res) => {
    if (req.method === 'GET') {
      getCalls++;
      res.statusCode = getCalls === 1 ? 503 : 200;
      if (getCalls === 1) res.setHeader('retry-after', '0');
      res.end(getCalls === 1 ? 'unavailable' : 'recovered');
    } else {
      postCalls++;
      res.statusCode = 503;
      res.end('unavailable');
    }
  }, async endpoint => {
    const answer = await reliableRequest(endpoint, {
      retries: 2, timeoutMs: 3000, consume: r => r.text(),
    });
    assert.equal(answer, 'recovered');
    await assert.rejects(reliableRequest(endpoint, {
      method: 'POST', body: '{}', retries: 5, timeoutMs: 3000,
    }), error => error instanceof HttpError && error.status === 503);
    assert.equal(getCalls, 2);
    assert.equal(postCalls, 1);
  });
});

test('real HTTP: a stream that never finishes times out and closes its connection', async () => {
  let closed = false;
  await withServer((req, res) => {
    res.on('close', () => { closed = true; });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse('beginning'));
    // Deliberately do not send [DONE] or end the response.
  }, async endpoint => {
    await assert.rejects(streamLocalChat({
      endpoint, model: 'local-test-model', messages: [], timeoutMs: 120, retries: 0,
      onEvent: () => {},
    }), RequestTimeoutError);
    const limit = Date.now() + 1000;
    while (!closed && Date.now() < limit) await new Promise(r => setTimeout(r, 10));
    assert.equal(closed, true, 'the library must release the stalled HTTP connection');
  });
});

test('real HTTP: cancellation during a partial answer makes no extra requests', async () => {
  let requests = 0;
  await withServer((req, res) => {
    requests++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse('started'));
  }, async endpoint => {
    const controller = new AbortController();
    await assert.rejects(streamLocalChat({
      endpoint, model: 'local-test-model', messages: [], signal: controller.signal,
      timeoutMs: 5000, retries: 2,
      onEvent(event) {
        if (event.type === 'delta') controller.abort();
      },
    }), { name: 'AbortError' });
    assert.equal(requests, 1);
  });
});
