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

## Why another wrapper?

[Ky](https://github.com/sindresorhus/ky) is a more complete fetch client and already has a `totalTimeout` option. [p-retry](https://github.com/sindresorhus/p-retry) retries arbitrary async work with a time budget and cancellation. [Got](https://github.com/sindresorhus/got) is a capable Node.js HTTP client. Use one of them when you need its broader features. This project focuses on local text-model streams that can restart after partial output with an explicit reset event. The general fetch wrapper remains available for ordinary HTTP calls.

The design was informed by a timeout fix in [helper-with-conspects](https://github.com/Stairrax/helper-with-conspects). This implementation is written independently; no source code was copied from that GPL-3.0-only project.

## License

No license has been selected yet. The repository is public for review, but this version does not grant general reuse rights. Before publishing a package, the owner should choose a license and add its full text. GPL-3.0-only is suitable if the project should remain under copyleft. A permissive license such as MIT or Apache-2.0 is an option for independently written code if all copyright holders agree. Copying GPL-covered source into this project would change that analysis.
