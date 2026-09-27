# Plan 003 — Fix absurd mid-stream TPS spikes (e.g. 5000 t/s on tool calls)

Status: **done** (implemented + tested, 39 tests green)

## Symptom

During tool-call-heavy turns the TPS meter jumps to absurd values (observed: ~5000 t/s).

## Reproduction (confirmed)

User settings have `measurementMode: "stream"`. Simulating the real event flow
through the shipped `renderText`:

```
stream, +8ms after first delta, 40 cumulative tokens  → [⚡ 5000 t/s ⏱ 410ms]
stream, +28ms, 120 tokens                             → [⚡ 4286 t/s ⏱ 410ms]
```

## Root cause

In `stream` mode the TPS denominator is `now − firstDeltaTime`. Right after the
first delta this window is single-digit milliseconds, while the token count has
already jumped (Anthropic/Google stream *cumulative* usage; tool-call arguments
arrive in fast `toolcall_delta` bursts). cumulative-tokens / tiny-window is pure
quantization noise → thousands of t/s. The unthrottled first render
(`lastStatusUpdate = 0` on re-anchor) makes the very first delta render
immediately, amplifying it.

## Verified non-causes (checked in pi-coding-agent / pi-ai sources)

- We only ever count the **streaming assistant message**: `message_update`
  carries `assistantMessageEvent` only for the live assistant stream, we filter
  to `text_delta`/`thinking_delta`/`toolcall_delta`, and `message_end` is
  guarded to `role === "assistant"`. Tool *execution* time and tool *results*
  are never inside the measurement window. Tool-call **arguments** are genuine
  model output tokens, so counting them is correct.
- `before_provider_request` fires exactly once per LLM call (via the Agent's
  `onPayload` bridge), not per HTTP retry.
- Compaction (`completeSimpleWithRetries`) and the `CacheWarmer`
  (`models.streamSimple` direct) bypass the Agent's `onPayload`, so they do
  **not** re-anchor our timer.
- `usage.output` is per-message for every pi-ai provider (not
  session-cumulative).

## Fix

1. Add `MIN_TPS_WINDOW_MS = 500`: mid-stream renders only show TPS once the
   denominator window reaches 500 ms; below that only TTFT is shown.
2. Exempt the **final** render (`message_end`): there the tokens are exact
   (`usage.output`) and the window is the full stream/e2e duration, so the value
   is the true average even for short responses (fast providers like
   Groq/Cerebras legitimately exceed 1000 t/s).
3. `renderText` gains an optional `final` flag (default false, so `demoPreview`
   and existing call sites are unaffected); `refreshStatus` forwards it; the
   `message_end` handler passes `final = true`.

## Verification

- New unit tests: sub-window mid-stream render hides TPS but shows TTFT;
  ≥500 ms window shows TPS; `final: true` shows TPS regardless of window.
- `npm test` green (39 tests).
- `npm run build`; smoke-tested `pi -e ./dist/index.js -p "..."` (loads clean).
- Before/after via `renderText`: `+8ms / 40 tok` mid-stream went from
  `[⚡ 5000 t/s ⏱ 410ms]` to `[⏱ 410ms]`; final render of the same window
  still shows the exact average.
