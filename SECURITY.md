# Security policy

This is an experimental, unpublished JavaScript project without supported stable releases.

If you believe you found a security vulnerability, please do not post exploitable details in a public issue. If GitHub's private **Report a vulnerability** feature is enabled in the repository's Security tab, use it. Otherwise, open a short non-sensitive issue requesting a private contact method.

For ordinary bugs, use the issue template and redact tokens, private prompts, identifiable data, and non-public server URLs.

The demo server binds to 127.0.0.1 and only serves an explicit set of files. It neither proxies nor stores model requests. The browser client connects directly to a loopback model endpoint. Never expose development servers to public networks.
