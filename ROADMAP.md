# Roadmap

The focus is **predictable recovery for text-only local model streams**, not faster GPU inference or an all-purpose HTTP framework.

## Included in the draft PR

- [x] Dependency-free fetch wrapper with a shared timeout and conservative retries
- [x] Ollama NDJSON and OpenAI-compatible SSE text streams
- [x] Interrupted-stream restart with explicit `reset` event
- [x] Cancellation and clear error classes
- [x] Node 18/22 unit and localhost HTTP fault-injection tests
- [x] Browser demo with simulated failures
- [x] Real TCP fault injector with an automated fake-Ollama test and optional live-Ollama command
- [x] Optional no-telemetry stream metrics
- [x] GPL-3.0-only license and contributor guidance

## Before v0.1.0

- [ ] Verify a real installed model using the optional smoke test and the forced-disconnect command
- [ ] Test the live demo in Chromium, Firefox, and Safari/WebKit
- [ ] Verify and document CORS behavior for local inference servers
- [ ] Audit stream parser memory limits for very long events
- [ ] Check large answers and slower CPU inference
- [ ] Get feedback from outside developers
- [ ] Review package metadata and third-party license handling
- [ ] Get explicit maintainer approval before releasing or publishing

## Possible next improvements

- User-selectable retry policy and per-attempt diagnostics
- Maximum event size and backpressure control
- Fault-injection helpers developers can use in their apps
- Concurrency controls and queue diagnostics

**Out of scope:** executing model tools, promising identical output after restart, secretly replaying billable remote requests, or guaranteeing exactly-once generation.
