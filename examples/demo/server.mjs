// Small localhost-only static server. It does not proxy model requests or store messages.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/src/index.js', ['../../src/index.js', 'text/javascript; charset=utf-8']],
  ['/src/local-chat.js', ['../../src/local-chat.js', 'text/javascript; charset=utf-8']],
  ['/src/metrics.js', ['../../src/metrics.js', 'text/javascript; charset=utf-8']],
]);

export async function startDemoServer({ port = 4173 } = {}) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new RangeError('port must be between 0 and 65535');
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    const asset = assets.get(url.pathname);
    if (!asset) { res.writeHead(404).end('Not found'); return; }
    try {
      const content = await readFile(new URL(asset[0], import.meta.url));
      res.writeHead(200, {
        'content-type': asset[1],
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src http://localhost:* http://127.0.0.1:* http://[::1]:*; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      console.error('Demo file error:', error.message);
      res.writeHead(500).end('Server error');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { server, url: 'http://127.0.0.1:' + server.address().port };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.DEMO_PORT || 4173);
  startDemoServer({ port }).then(({ url }) => {
    console.log('Open the stream demo in your browser: ' + url);
    console.log('Press Ctrl+C to stop the demo server.');
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
