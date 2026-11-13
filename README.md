# reliable-requests

[![Tests](https://github.com/Stairrax/reliable-requests/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/Stairrax/reliable-requests/actions/workflows/test.yml)
[![Browser demo](https://github.com/Stairrax/reliable-requests/actions/workflows/browser.yml/badge.svg?branch=main)](https://github.com/Stairrax/reliable-requests/actions/workflows/browser.yml)
[![GPL-3.0-only](https://img.shields.io/badge/license-GPL--3.0--only-blue)](LICENSE)

**Small JavaScript helpers for reliable HTTP requests and interrupted local AI streams.** Runs in modern browsers and Node.js 18+, with no runtime dependencies.

When a text stream breaks, `streamLocalChat` can start a fresh generation and emit **`reset`**, so an app does not mix the unfinished old answer with the new one.

- Ollama and OpenAI-compatible endpoints (LM Studio, llama.cpp).
- One total deadline, cancellation, and cautious retries.
- Interactive demo, diagnostic metrics, and real-HTTP failure tests.

> A retry **restarts** the generation; it cannot continue the same answer or guarantee identical text. Model calls may use additional compute or cost money. Remote automatic retries require explicit opt-in. The first version handles text only.

## Quick start

Clone the repository and switch to the project directory:

```bash
git clone https://github.com/Stairrax/reliable-requests.git
cd reliable-requests
npm test
npm run demo
```

Open **http://127.0.0.1:4173**. Select **Simulate interruption** to see a partial response discarded and replaced. No model or GPU is required for the demo.

To test a real model, start Ollama and install a model (for example `ollama pull qwen2.5:0.5b`):

```bash
MODEL_NAME=qwen2.5:0.5b npm run test:model
MODEL_NAME=qwen2.5:0.5b npm run test:ollama:recovery
```

The second command deliberately breaks one **local** Ollama connection, then checks for a retry and reset. It does not stop Ollama. These examples use **Git Bash** on Windows, macOS, or Linux; see the guide for PowerShell.

## Use in JavaScript

This is **source code, not a published npm package**. Import it from your checkout:

```js
import { streamLocalChat } from './src/local-chat.js';

let answer = '';
await streamLocalChat({
  endpoint: 'http://127.0.0.1:11434',
  protocol: 'ollama',
  model: 'qwen2.5:0.5b', // Replace with your installed model
  messages: [{ role: 'user', content: 'Hello!' }],
  onEvent(event) {
    if (event.type === 'reset') answer = '';
    if (event.type === 'delta') answer += event.text;
    if (event.type === 'done') console.log(answer);
  },
});
```

Also included: `reliableRequest` for regular fetch calls and `createStreamMetrics` for local diagnostics.

## Documentation

- [Detailed usage, API, and PowerShell instructions](docs/USAGE.md)
- [Roadmap](ROADMAP.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

**Status:** early open-source implementation. Automated tests cover Node.js 18/22 and simulated demo flows in Chromium, Firefox, and WebKit. A Windows user verified live Qwen 2.5 0.5B responses, Stop, and recovery from a deliberately cut TCP connection, plus a normal streamed llama.cpp response with Qwen 2.5 0.5B. Live llama.cpp interruption recovery, LM Studio, live cross-browser inference, other models, and very long responses still need testing.

## License

[GPL-3.0-only](LICENSE) © 2026 Stairrax. You may use the code under GPL-3.0-only without asking first, provided you meet its terms. For **alternative licensing or collaboration**, [contact the maintainer through GitHub Issues](https://github.com/Stairrax/reliable-requests/issues); other terms require a separate written agreement.
