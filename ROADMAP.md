# Roadmap

The focus is **predictable recovery for text-only local model streams**, not faster GPU inference or an all-purpose HTTP framework.

## Included in main

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

- [x] Verify Ollama with Qwen 2.5 0.5B using the smoke test and forced-disconnect command (Windows; other models and platforms remain to be checked)
- [ ] Verify live LM Studio and llama.cpp models, including interrupted streams
- [ ] Test the live demo with a real model in Chromium, Firefox, and Safari/WebKit (simulated cross-browser checks are in PR #3)
- [ ] Verify and document CORS behavior for local inference servers
- [x] Bound unfinished protocol lines and verify limits with stress tests
- [ ] Exercise extreme payload sizes and very long generations
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
