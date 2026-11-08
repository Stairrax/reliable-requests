# reliable-requests

A small, dependency-free set of request helpers for browser apps and Node.js 18+.

## Local model streams

`streamLocalChat` is the distinctive part of this project: it can restart a **text-only** local-model stream after a partial answer. Before the next attempt it emits `reset`, so the caller replaces the old answer instead of appending a second generation to it. It works with any model name served by Ollama's native chat API or an OpenAI-compatible chat-completions endpoint (for example, LM Studio or llama.cpp). The model does not need to be Qwen.

```js
import { streamLocalChat } from './src/local-chat.js';

let shown = '';
await streamLocalChat({
  endpoint: 'http://localhost:11434',
  protocol: 'ollama',
  model: 'qwen2.5:7b',
  messages: [{ role: 'user', content: 'Explain recursion simply.' }],
  timeoutMs: 60_000,
  onEvent(event) {
    if (event.type === 'reset') shown = '';
    if (event.type === 'delta') shown += event.text;
    if (event.type === 'retry') console.log('Restarting generation:', event.error.message);
    if (event.type === 'done') console.log(shown);
  },
});
```

For an OpenAI-compatible local server, set `protocol: 'openai'` (the default) and `endpoint: 'http://localhost:1234/v1'` for LM Studio or your llama.cpp server URL. The function adds `/v1/chat/completions` itself. `fetchImpl` and `headers` are optional. `signal` cancels the operation.

The callback receives `attempt`, `delta`, `retry`, `reset`, and `done` events. Its work should be synchronous. A retry begins only for a transient HTTP status (429, 500, 502, 503, 504), a network error, or a stream ending before its completion marker. Invalid requests and malformed protocol events fail without retry. The same total deadline covers the stream and retry waits. The function returns `{ attempts }` on success.

A restart runs the model again and may produce different text. Local inference uses extra compute; remote services may charge again. For that reason automatic retries are enabled by default only for loopback addresses. To permit them for a remote endpoint, explicitly set `allowRemoteRetries: true`. This is **not** an exactly-once guarantee. This first version accepts text messages only and does not execute model tool calls. Browser apps also need their local server to allow the browser origin through CORS.

## General fetch wrapper

It gives one deadline to the whole operation: attempts, pauses before retries, and response reading **when you provide a `consume` function**. It uses `AbortSignal` for cancellation and retries only `GET` and `HEAD` by default.

This is an early, unpublished project. Install it from a checkout while the API and license are being decided.

## Try it

```js
import { reliableRequest } from './src/index.js';

const user = await reliableRequest('https://example.com/api/user', {
  timeoutMs: 8_000,
  retries: 2,
  consume: response => response.json(),
});
console.log(user);
```

Without `consume`, the function returns a normal `Response` as soon as headers arrive. The deadline then ends, so later reads of `response.body` are **not** covered. Use `consume` whenever the full body or a stream must finish within the deadline.

## Cancellation

```js
const controller = new AbortController();
const pending = reliableRequest('https://example.com/api/user', {
  signal: controller.signal,
  consume: response => response.text(),
});
controller.abort();
await pending; // rejects with AbortError
```

An already aborted signal sends no request. Cancellation also interrupts retry delays. A timeout rejects with `RequestTimeoutError` and `code === 'REQUEST_TIMEOUT'`. The wrapper aborts its own fetch signal and rejects on time even if a custom fetch implementation ignores abort.

## Streaming

Keep the reader inside `consume` and release it when finished. The wrapper's signal tells you when to stop. This example collects chunks; a UI can process each chunk as it arrives.

```js
const chunks = await reliableRequest('https://example.com/events', {
  timeoutMs: 30_000,
  consume: async (response, signal) => {
    const reader = response.body.getReader();
    const chunks = [];
    const onAbort = () => { reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return chunks;
        chunks.push(new TextDecoder().decode(value, { stream: true }));
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      reader.releaseLock();
    }
  },
});
```

The deadline includes the entire stream. If it expires after some chunks were delivered, the promise rejects; those chunks may already have reached your UI. Do not silently retry a partially delivered stream. For SSE, parse events in your consumer and treat a protocol marker such as `[DONE]` according to the server's rules.

## Retry policy and errors

`retries` means additional attempts (default 2); `timeoutMs` defaults to 30,000 ms. Only `GET` and `HEAD` retry. A network `TypeError` or HTTP 429, 500, 502, 503, or 504 may retry. HTTP 4xx errors such as 401 and 404 fail immediately. Delays use exponential backoff; `Retry-After` in seconds or HTTP date is honored up to 30 seconds. Every delay consumes the same total time budget.

`POST`, `PUT`, `PATCH`, and `DELETE` are never retried. Repeating one could create a duplicate operation or charge twice. If your API has an idempotency key contract, put a separate, explicit retry policy around that operation.

An unsuccessful final response throws `HttpError` with `status`, `response`, and `attempts`. The response body remains available for diagnosis. Transport errors retain their original error. Errors thrown by `consume` propagate and are not retried, because the body or a stream may already have been partly read.

Pass ordinary `fetch` options such as `headers`, `credentials`, and `method` alongside the options above. The first argument must be a URL string or `URL`; `Request` objects are not supported because their bodies may be one-shot. `fetchImpl` is available for tests or a compatible custom implementation.

## Run tests

```sh
npm test
```

The tests use Node's built-in test runner and need no install step.

## Tests over real HTTP

Run all automated tests with:

    npm test

The integration tests start an actual HTTP server on your computer (not a fake fetch). They test both Ollama NDJSON and OpenAI-compatible SSE, break connections after the first words, stall streams, send transient server errors, and verify cancellation, deadline enforcement, and safe retry boundaries. You do not need to install a model, GPU drivers, or extra dependencies.

## Test against an installed local model

First start your existing Ollama, LM Studio, or llama.cpp server. Then use the optional smoke test. It sends a short text prompt, prints the streamed answer, and reports whether the protocol completed.

For Ollama, first run ollama list to find your installed model. For example:

    MODEL_PROTOCOL=ollama MODEL_NAME=qwen2.5:7b npm run test:model

The model name is an example; use one you actually have installed. The default Ollama endpoint is http://127.0.0.1:11434. If it is not running, start it normally (for example with ollama serve).

For an OpenAI-compatible endpoint in LM Studio or llama.cpp:

    MODEL_PROTOCOL=openai MODEL_ENDPOINT=http://127.0.0.1:1234/v1 MODEL_NAME=your-installed-model npm run test:model

Replace the model and address with your server settings. For slow local models you can specify a larger deadline in milliseconds, for example MODEL_TIMEOUT_MS=300000.

On Windows PowerShell, an Ollama example is:

    $env:MODEL_PROTOCOL = 'ollama'
    $env:MODEL_NAME = 'qwen2.5:7b'
    npm run test:model

The smoke test does not retry a real model call automatically: it only checks that one generation succeeds. To test interrupted streams and automatic recovery without breaking your own model server, run npm test. Those tests simulate failures predictably and confirm that reset replaces the partial output. A restarted generation is not a continuation of the old text.

## Why another wrapper?

[Ky](https://github.com/sindresorhus/ky) is a more complete fetch client and already has a `totalTimeout` option. [p-retry](https://github.com/sindresorhus/p-retry) retries arbitrary async work with a time budget and cancellation. [Got](https://github.com/sindresorhus/got) is a capable Node.js HTTP client. Use one of them when you need its broader features. This project focuses on local text-model streams that can restart after partial output with an explicit reset event. The general fetch wrapper remains available for ordinary HTTP calls.

The design was informed by a timeout fix in [helper-with-conspects](https://github.com/Stairrax/helper-with-conspects). This implementation is written independently; no source code was copied from that GPL-3.0-only project.

## License

Copyright (C) 2026 Stairrax.

This project uses the GNU General Public License version 3 only (SPDX: GPL-3.0-only). See the complete terms in [LICENSE](LICENSE).

You may use, modify, and redistribute the code under GPL-3.0-only without asking the author individually, provided that you comply with the license. For different licensing terms, including commercial agreements, please [contact the maintainer via GitHub Issues](https://github.com/Stairrax/reliable-requests/issues) and describe your intended use. Other terms require a separate written agreement; reaching out does not by itself grant permission.

The code was independently written: no implementation was copied from helper-with-conspects. This is an unpublished draft; the package is still marked private.
