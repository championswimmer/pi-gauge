# Plan 004 — Per-call history in session JSONL + `/gauge graph` TUI view

Status: **implemented** (`src/index.ts`, 13 new tests, 52 total green; harness smoke-tested)

## Goal

Persist one record per LLM call (TPS, TTFT, model) into the session JSONL so
`/gauge graph` can render a historical TUI chart of speed/TTFT over the
session, filterable by model.

## What research confirmed (verified, not assumed)

1. **Session JSONL is writable by extensions.** Sessions live at
   `~/.pi/agent/sessions/<slug>/<ts>_<uuid>.jsonl`, one JSON object per line.
   `ExtensionAPI` exposes `ctx.appendEntry(customType, data?)`, which persists
   a `{"type":"custom","customType","data"}` entry — **not sent to the LLM**,
   so zero context/token cost
   (`pi-coding-agent/dist/core/extensions/types.d.ts:1059-1060`,
   `core/session-manager.d.ts:81-85`).
2. **History is readable back.** `ctx.sessionManager` (`ReadonlySessionManager`)
   exposes `getEntries()` / `getBranch()` / `getSessionId()` / `getSessionFile()`
   (`core/session-manager.d.ts:140-170`). Graph view rebuilds history on demand
   from entries with `customType === "pi-gauge-sample"` — no in-memory log to
   keep in sync, and history **survives resume** (same file) automatically.
3. **Model identity is available at `message_end`.** `MessageEndEvent.message`
   is an `AgentMessage` carrying `provider` + `model` (confirmed in real
   session JSONL: `"provider":"openai-codex","model":"gpt-5.4"`). `ctx.model`
   (`Model<any>`, `.provider` / `.id`) is a fallback. `before_provider_request`
   payload is opaque `unknown` — do **not** try to read the model there.
4. **TUI overlay supports a graph.** `ctx.ui.custom(factory, { overlay: true,
   overlayOptions })` takes any `Component` (`render(width) => string[]`), so a
   ~20-row chart is fine. `OverlayOptions` has `width`/`minWidth`/`maxHeight`
   (no fixed height). **No chart/sparkline component exists in pi-tui** — we
   hand-roll ASCII/block rendering, dependency-free.

## Design

### 1. Record schema (one `appendEntry` per assistant `message_end`)

```ts
interface GaugeSample {
  v: 1;                  // schema version
  ts: number;            // Date.now() at message_end (wall clock, chart x-axis)
  provider: string;      // e.g. "anthropic"
  model: string;         // e.g. "claude-opus-4-5"
  ttftMs: number | null; // null when no delta ever arrived (aborted/empty)
  tokens: number;        // final output tokens (exact usage or chars/4 fallback)
  e2eMs: number;         // message_end − requestStart
  streamMs: number | null; // message_end − firstDelta (null if no delta)
}
```

- Store **raw values only**; TPS (e2e and stream) is derived at render time via
  the existing `measurementMode` setting — so toggling mode re-interprets
  history without re-recording.
- Write only on `message_end` (never per-delta): one JSONL line per LLM call,
  negligible I/O. Guard `role === "assistant"` as today.
- Skip samples with `tokens <= 0 && ttftMs === null` (empty/error streams add
  noise, not signal).
- `customType: "pi-gauge-sample"`. Optionally `registerEntryRenderer` later so
  the transcript doesn't render them as noise — check whether `custom` entries
  render by default during implementation.

### 2. History loading (pure, testable)

```ts
loadSamples(entries: SessionEntry[]): GaugeSample[]
```

- Filter `type === "custom" && customType === "pi-gauge-sample"`, validate
  shape defensively (`v === 1`, numeric fields), drop corrupt entries.
- Prefer `getBranch()` over `getEntries()` so forked sessions don't show
  sibling-branch samples (verify branch semantics during implementation).
- Old sessions (pre-feature) have no samples → graph shows "no samples yet"
  state. Deliberately **no reconstruction** from assistant message entries:
  tokens/model are recoverable from them, but TTFT/durations are not, and a
  half-populated chart is worse than an honest empty state. (Revisit if asked.)

### 3. `/gauge graph` TUI view

- New `GaugeGraph` component shown via `ctx.ui.custom` overlay
  (`anchor: "center"`, `width: ~72`, `maxHeight: "80%"`), same pattern as the
  existing `GaugeDialog`.
- Layout (top → bottom): title + sample count · **TPS chart** (per-sample bars
  using `▁▂▃▄▅▆▇█` sparklines or vertical bars, one column per call, scaled to
  max) · **TTFT chart** (same x-axis, separate scale — two stacked charts, not
  one, since units differ) · x-axis (call # / time) · footer
  (avg TPS, avg TTFT, min/max) · model legend + filter hint.
- **Model filter:** `←/→` or `1..n` cycles `all → <model A> → <model B> …`;
  each model gets a distinct glyph/color in the legend; filtered-out calls are
  omitted and axes rescale. Filter is session-local, not persisted.
- Keys: `←→` filter, `↑↓`/`PgUp/PgDn` scroll when samples exceed width (window
  the last N), `esc` close. Read-only — no save path.
- Pure renderer `renderGraph(samples: GaugeSample[], opts): string[]`
  (exported for tests): scaling, bucketing (>width samples → per-column max or
  average — decide in implementation, max preserves spikes), axis labels.
- Non-TUI modes (`rpc`/`json`/`print`): print a text summary via `notify`
  (n calls, avg TPS/TTFT per model) instead of the overlay.

### 4. What does NOT change

- Status-bar live rendering, throttling, `MIN_TPS_WINDOW_MS` floor: untouched.
- Settings file: no new keys (filter is ephemeral; chart respects existing
  `measurementMode` for the TPS denominator).
- `renderText` / `GaugeDialog`: untouched.

## Verification

- Unit tests (`tests/gauge.test.mjs`): `loadSamples` (filters foreign custom
  entries, drops corrupt shapes, keeps field values); `renderGraph` (empty →
  placeholder; single model; multi-model + filter keeps only matching series;
  axis scales to max; bucketing when samples > width; TTFT-null gaps render as
  blank, not zero).
- `npm test` green; `npm run build`.
- Live smoke: `pi -e ./dist/index.js`, run 3+ turns incl. a model switch if
  available, `/gauge graph` shows ≥3 columns; `grep pi-gauge-sample
  <session>.jsonl` shows one line per assistant message; resume session →
  graph still shows prior samples; `/gauge graph` in `--print` mode prints
  summary without crashing.

## Open questions / risks (to close during implementation)

1. Do `custom` entries render inline in the transcript by default (noise)?
   If yes, add `registerEntryRenderer("pi-gauge-sample", …)` returning empty.
2. Do `custom` entries survive compaction, or are they dropped with old
   messages? If dropped, history truncates at compaction — acceptable v1, note
   in README; alternative (global sidecar file keyed by session id) is a
   fallback, not the default.
3. `getBranch()` vs `getEntries()` semantics for forked sessions — pick after
   reading `session-manager.js` behavior.
4. Exact block-char width: use `visibleWidth`-safe chars only (no emoji in the
   chart grid) so CJK/wide terminals don't misalign axes.
