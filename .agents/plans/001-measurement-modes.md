# 001 — pi-gauge measurement modes (e2e vs stream)

Status: accepted design brief. Details here are authoritative over AGENTS.md.

## 1. Definitions (normative)

- **TTFT (both modes):** `firstDeltaTime - requestStart`. Time from request
  dispatch to first content chunk available to the extension.
- **TPS_e2e:** `totalOutputTokens / ((messageEndTime - requestStart) / 1000)`.
- **TPS_stream:** `totalOutputTokens / ((messageEndTime - firstDeltaTime) / 1000)`.
- `totalOutputTokens` = `message.usage.output` at `message_end` (exact snap).
  Mid-stream only: `partial.usage.output` if > 0 else `ceil(contentChars/4)`.

## 2. Mode A (e2e wall-clock): how it works event-by-event

Proven in `pi-speedometer/src/index.ts`; reuse the pattern directly.

1. `before_provider_request` → `requestStart = performance.now()`,
   reset `firstDeltaTime=null`, `streaming=true`. Re-anchors every LLM call
   (tool loops make N calls per turn; always show the current call).
2. `message_update` → read `event.assistantMessageEvent`. If
   `type ∈ {text_delta, thinking_delta, toolcall_delta}` and
   `firstDeltaTime===null`: set `firstDeltaTime=now`,
   `TTFT = now - requestStart`. Update live TPS (throttle `setStatus` ~250ms).
3. `message_end` (role=assistant) → `streaming=false`; snap tokens to
   `message.usage.output`; final render with exact TPS + TTFT.
4. `agent_end` / `session_shutdown` → `streaming=false`; leave final values.
5. Guards: `firstDeltaTime===null` (empty/error/abort) → show TTFT as `—`,
   skip TPS (no divide-by-zero); `durationSec<=0` or `tokens<=0` → skip.

Provider quirks (pi-ai normalizes all into `AssistantMessageEvent.partial`):
- Anthropic: `partial.usage.output` cumulative mid-stream → live TPS exact.
- Google: `usageMetadata` per chunk, cumulative → live TPS exact.
- OpenAI chat-completions: usage only in final chunk (`stream_options`
  `include_usage`) → mid-stream `usage.output==0`, use chars/4 estimate,
  snap exact at `message_end`. `OpenAICompletionsCompat.supportsUsageInStreaming`
  confirms this varies per OpenAI-compatible backend.

## 3. Mode B (response-JSON parsing): feasibility verdict — NOT FEASIBLE

From inside an extension, available surface is (`types.d.ts`):
- `before_provider_request`: `{ payload: unknown }` — mutable prompt payload,
  no timing/body access, no raw HTTP.
- `before_provider_headers`: headers only (mutate in place).
- `after_provider_response`: `{ status, headers }` — NO body, NO chunks.
- `message_update`: pi-ai `AssistantMessageEvent` (already-normalized
  `partial: AssistantMessage`) — provider JSON is gone by this point.
- No event exposes raw SSE chunks, byte sizes, or per-chunk arrival times.

Verdict: (B) cannot be built without patching pi core. It would require new
hooks, e.g. `on_provider_chunk({ rawJson, byteLength, tArrival })` emitted
from the provider fetch/SSE loop in `sdk.js`, plus a `rawUsage` passthrough
on stream events. Out of scope; pi-ai deliberately abstracts provider JSON
away (`Usage` is the only token contract). Recommend mode A only.

## 4. Recommended design: two toggleable TPS denominators

`measurementMode: "e2e" | "stream"` (default `"e2e"`). TTFT identical both.

| Mode | TPS denominator | Measures | Limitations |
|---|---|---|---|
| `e2e` | `message_end − requestStart` | User-perceived throughput incl. queue/TTFT | Penalizes slow-TTFT providers; tool-call-only turns look slow |
| `stream` | `message_end − firstDelta` | Pure decode speed after first token | Hides queue/TTFT stalls; near-zero durations inflate TPS |

Confounders (both modes): tool-loop re-anchor per call (by design);
`thinking_delta` ends TTFT before visible text (thinking-heavy models show
fast TTFT); `toolcall_delta` JSON counted via `JSON.stringify(args)` chars;
aborted streams keep partials, never NaN; we measure TTFT-to-decode
(extension dispatch), not socket TTFB — includes pi overhead (~ms).

## 5. Display + settings surface

```ts
interface GaugeSettings {
  showThroughput: boolean;            // default true
  showLatency: boolean;               // default true
  measurementMode: "e2e" | "stream";  // default "e2e"
  displayMode: "pill" | "icon";       // default "pill"
  iconSet: "emoji" | "nerd";          // default "emoji"
}
// pill+emoji:  "[⚡ 42.1 t/s ⏱ 412ms]"; icon+emoji: "⚡ 42.1 ⏱ 412ms"
// pill+nerd:   "[\uF0E4 42.1 t/s \uF017 412ms]" ( tachometer,  clock);
// icon+nerd:   "\uF0E4 42.1 \uF017 412ms". Store: ~/.pi/agent/pi-gauge.json
```

`/gauge` command: no args → notify current settings; `tps|ttft on|off`,
`mode e2e|stream`, `display pill|icon`, `icons emoji|nerd`; persist + re-render.
Status key: `"gauge"`. Throttle 250ms. Single file `src/index.ts`, no deps.

## Verification

- `npm run build && pi -e ./dist/index.js -p "say hi"` on Anthropic + one
  OpenAI-compatible model: TTFT renders; live TPS estimates then snaps exact.
- `/gauge mode stream` flips TPS denominator; `/gauge` persists to JSON.
- Abort mid-stream (Ctrl-C): no crash, partials retained.
