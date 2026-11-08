# Contributing

Thanks for helping make local AI integrations more reliable.

## Getting started

The project supports modern browsers and Node.js 18+. It has no runtime dependencies.

1. Fork the repository and create a focused branch.
2. Run `npm test` before opening a pull request. No model is required.
3. Run `npm run demo` and visit http://127.0.0.1:4173 for an interactive simulated stream failure.
4. If you use Ollama, LM Studio, or llama.cpp, follow the optional live smoke-test instructions in README.
5. Propose small changes with a clear English commit subject and regression tests.

## Design principles

- Keep runtime dependencies at zero unless there is a strong reason not to.
- A single deadline should cover request, retries, and response consumption when using `consume`.
- Never silently retry non-idempotent HTTP operations. Model retries can start *different* generations, so callers must receive `reset`.
- Do not execute model tool calls or print secret prompts in logs.
- Keep `src/` browser-compatible; avoid Node-only APIs in shared code.
- Document public API changes and add tests for new behavior.

## Reporting problems

Include your Node/browser version, runtime, protocol, sanitized error, reproduction steps, expected behavior, and actual behavior. Use the simulation demo to reproduce a disconnect without sharing model data.

Do not commit API keys, private prompts, internal endpoints, or identifying information. See [SECURITY.md](SECURITY.md).

## Licensing contributions

Contributions to this repository are proposed under [GPL-3.0-only](LICENSE). You must have the rights needed to contribute any submitted code; disclose the origin and license of third-party material. The maintainer may separately negotiate different licenses for code they own, but third-party contributions are **not** automatically covered by such agreements. Contact contributors for any required additional permissions.
