// Fault injection for a real local Ollama instance. Not part of the public library API.
// Binds to 127.0.0.1 on a random port. Only forwards authenticated text-only /api/chat.
import { createServer, request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_EVENT_BYTES = 256 * 1024;
const CUT_DELAY_MS = 80;

export async function createOneShotOllamaFaultProxy({
  upstream = 'http://127.0.0.1:11434',
} = {}) {
  const upstreamUrl = new URL(upstream);
  if (upstreamUrl.protocol !== 'http:' || upstreamUrl.hostname !== '127.0.0.1' ||
      upstreamUrl.username || upstreamUrl.password ||
      (upstreamUrl.pathname !== '/' && upstreamUrl.pathname !== '') ||
      upstreamUrl.search || upstreamUrl.hash) {
    throw new TypeError('The fault proxy only connects to an HTTP server on 127.0.0.1');
  }

  const token = randomBytes(24).toString('hex');
  const stats = { requests: 0, forcedCuts: 0, forwardedTextEvents: 0 };
  const sockets = new Set();
  const server = createServer(async (req, res) => {
    const fail = (status, message) => {
      if (!res.destroyed && !res.headersSent) {
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end(message);
      } else if (!res.destroyed) {
        res.destroy();
      }
    };

    if (req.method !== 'POST' || req.url !== '/api/chat') {
      fail(404, 'Only POST /api/chat is supported');
      return;
    }
    // No CORS, no browser-origin requests, and no public-facing port.
    if (req.headers.origin || req.headers['x-rr-test-token'] !== token) {
      fail(403, 'Fault proxy access denied');
      return;
    }
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      fail(415, 'Expected application/json');
      return;
    }
    if (stats.requests >= 2) {
      fail(429, 'The one-shot fault test allows only two model requests');
      return;
    }

    try {
      const parts = [];
      let length = 0;
      for await (const part of req) {
        length += part.length;
        if (length > MAX_REQUEST_BYTES) {
          fail(413, 'Test request is too large');
          return;
        }
        parts.push(part);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(parts).toString('utf8')); }
      catch { fail(400, 'Invalid JSON'); return; }
      if (input?.stream !== true || typeof input.model !== 'string' || !input.model ||
          !Array.isArray(input.messages) ||
          !input.messages.every(m => typeof m?.role === 'string' && typeof m?.content === 'string')) {
        fail(400, 'Only text-only, streaming Ollama chat requests are supported');
        return;
      }

      stats.requests++;
      const injectCut = stats.requests === 1;
      const body = JSON.stringify({ model: input.model, messages: input.messages, stream: true });
      const upstreamRequest = httpRequest(upstreamUrl, {
        method: 'POST',
        path: '/api/chat',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      });
      res.once('close', () => upstreamRequest.destroy());

      upstreamRequest.on('error', () => fail(502, 'Could not reach the local Ollama server'));
      upstreamRequest.on('response', upstreamResponse => {
        const status = upstreamResponse.statusCode || 502;
        const responseHeaders = {
          'content-type': String(upstreamResponse.headers['content-type'] || 'application/x-ndjson'),
          'cache-control': 'no-store',
        };
        if (!injectCut || status !== 200) {
          res.writeHead(status, responseHeaders);
          upstreamResponse.on('error', () => { if (!res.destroyed) res.destroy(); });
          upstreamResponse.pipe(res);
          return;
        }

        let pending = Buffer.alloc(0);
        let cutScheduled = false;
        upstreamResponse.on('data', chunk => {
          if (cutScheduled) return;
          pending = Buffer.concat([pending, chunk]);
          if (pending.length > MAX_EVENT_BYTES) {
            upstreamRequest.destroy();
            fail(502, 'Ollama event exceeded the test limit');
            return;
          }
          let end;
          while ((end = pending.indexOf(10)) >= 0) {
            const lineBytes = pending.subarray(0, end);
            pending = pending.subarray(end + 1);
            let event;
            try { event = JSON.parse(lineBytes.toString('utf8')); }
            catch { continue; }
            if (typeof event?.message?.content !== 'string' || !event.message.content || event.done) {
              continue;
            }

            cutScheduled = true;
            stats.forwardedTextEvents++;
            stats.forcedCuts++;
            res.writeHead(200, responseHeaders);
            res.socket?.setNoDelay(true);
            res.write(Buffer.concat([lineBytes, Buffer.from('\n')]));
            // Briefly allow the first text to reach the client, then drop the TCP connection.
            // Do not terminate Ollama or modify system network settings.
            upstreamResponse.pause();
            setTimeout(() => {
              upstreamRequest.destroy();
              if (!res.destroyed) res.destroy();
            }, CUT_DELAY_MS).unref();
            return;
          }
        });
        upstreamResponse.on('end', () => {
          if (!cutScheduled) fail(502, 'Ollama completed without a text event to interrupt');
        });
        upstreamResponse.on('error', () => fail(502, 'Ollama stream ended unexpectedly'));
      });
      upstreamRequest.end(body);
    } catch {
      fail(400, 'Could not read the test request');
    }
  });

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

  return {
    endpoint: 'http://127.0.0.1:' + server.address().port,
    token,
    snapshot: () => Object.freeze({ ...stats }),
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
