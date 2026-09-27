# pi-gauge

> **v0.1.0 work-in-progress** — API and status-bar format may change before 1.0.

A [pi coding agent](https://github.com/marlowe633/pi-mono) extension that shows live LLM latency (time-to-first-token, TTFT) and throughput (tokens/sec) in the status bar, so you can see at a glance how fast your model is responding.

## The `/gauge` command (planned)

- `/gauge` — show current settings and last measured TTFT / tokens-per-sec.
- `/gauge tps on|off` / `/gauge ttft on|off` — toggle each metric's visibility.
- `/gauge reset` — clear stored settings back to defaults.

## Measurement modes

- **e2e** — wall-clock latency for the whole request: from `before_provider_request` to `message_end`, divided by final output tokens. Simple, works with every provider.
- **stream** — live readout during streaming: TTFT from request start to the first content delta, then running tokens/sec from cumulative `usage.output` on each delta event. Note some providers (e.g. OpenAI chat completions) only report usage in the final chunk, so the live number is a chars/4 estimate until `message_end` snaps it to the exact value.

## Install

```sh
pi install pi-gauge
```

## Dev

```sh
npm install
npm run build
npm test
```

## License

MIT © 2026 Arnav Gupta
