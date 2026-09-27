# AGENTS.md — pi-gauge

Project context for AI coding agents working in this repo. Keep this file up to date as the project evolves.

## What this project is

`pi-gauge` is a **pi extension** (for the pi coding agent, `@earendil-works/pi-coding-agent`) that measures and displays live LLM performance in the status bar:

- **Latency (TTFT)** — time to first token (request sent → first content delta)
- **Throughput** — tokens/sec of the assistant response stream

The metrics are shown in the pi status bar, and a `/gauge` command configures what is displayed.

Display:

- **Pill or icon** mode (`displayMode: "pill" | "icon"`) with **emoji or nerd-font glyphs** (`iconSet: "emoji" | "nerd"`).
- **Measurement modes** (toggleable): `e2e` (request → `message_end`) vs `stream` (first delta → `message_end`). See `.agents/plans/` for the measurement-modes plan doc; details there are authoritative.

## Housekeeping rules (follow these)

1. **Keep this AGENTS.md current.** When you learn something durable about the codebase, pi APIs, or project decisions, record it here.
2. **Plans live in `.agents/plans/`.** Before any non-trivial task, write a numbered plan file (e.g. `.agents/plans/001-measurement-modes.md`) describing scope, design decisions, and verification steps. Update the plan's status when done.
3. **Delegate subtasks to subagents.** Use the `Agent` tool for self-contained implementation/research subtasks instead of doing everything in the main loop. Verify subagent output before accepting it.

## Repo layout

```
pi-gauge/
├── AGENTS.md                  ← this file
├── package.json               ← pi package manifest ("pi": { "extensions": ["./dist/index.js"] })
├── tsconfig.json              ← TypeScript config (src/*.ts → dist/)
├── README.md                  ← user-facing docs
├── LICENSE
├── src/
│   └── *.ts                   ← the extension (built via tsc to dist/)
├── dist/                      ← TRACKED build output (see below)
├── tests/
│   └── *.test.mjs             ← run via node --test
├── .agents/
│   ├── plans/                 ← task plans (see housekeeping rules)
│   └── skills/                ← agent skills (e.g. release)
└── .github/
    └── workflows/             ← CI + release workflows
```

**Why `dist/` is tracked:** pi installs git packages with `--omit=dev` and performs no build step, so the compiled `./dist/index.js` referenced by the pi manifest must be committed.

## Key technical facts (researched, don't re-derive)

### How pi extensions work

- Entry point: `export default function (pi: ExtensionAPI) { ... }`.
- Status bar: `ctx.ui.setStatus(key: string, text: string | undefined)`. Pass `undefined` to clear.
- Commands: `pi.registerCommand("gauge", { description, handler: async (args: string, ctx) => {...} })`. The handler receives raw args string; parse subcommands manually.
- Local testing: `pi -e ./dist/index.js` for quick tests (note: `dist/`, not `src/` — must `npm run build` first), or symlink/copy into `~/.pi/agent/extensions/` (global, hot-reloadable with `/reload`) or `.pi/extensions/` (project-local, requires project trust).
- Package distribution: `package.json` with `"pi": { "extensions": ["./dist/index.js"] }`, installable via `pi install npm:pi-gauge`.

### Where the measurements come from

- **Request anchor (TTFT start):** `pi.on("before_provider_request", ...)` — fires right before the HTTP request is sent, once per LLM call.
- **Stream events:** `pi.on("message_update", (event) => ...)` — content-bearing deltas have types like `text_delta` (first `*_delta` of any kind ends TTFT).
- **Stream end:** `pi.on("message_end", ...)` (assistant message) — final usage for exact totals.

### Provider differences in streamed usage (important!)

- **Anthropic:** usage is cumulative during streaming. Live throughput is exact.
- **OpenAI:** usage usually arrives only in the **final** chunk — mid-stream counts stay 0, so use a character-based estimate (chars / 4) for the live readout, snap to real value at `message_end`.
- **Google:** usage metadata is often sent per chunk (cumulative).

### Timing model

```
before_provider_request ──► first *_delta ──► ...deltas... ──► message_end
        │                        │                                  │
        └──────── TTFT ──────────┘                                  │
        └────────────────── e2e duration ───────────────────────────┘
                              └────── stream duration ──────────────┘
```

- Multiple LLM calls happen per agent run (tool loop) → re-anchor state on each `before_provider_request`.
- Throttle `setStatus` calls during streaming (~4/sec) — deltas arrive fast.
- Aborted/error streams: keep whatever partial metrics exist; don't crash on missing data.

## Settings (implemented — see `.agents/plans/001-measurement-modes.md` for rationale)

- Stored globally at `~/.pi/agent/pi-gauge.json` (created on first write).
- Tentative keys:
  - `showLatency: boolean` (default true)
  - `showThroughput: boolean` (default true)
  - `displayMode: "pill" | "icon"` (default `"pill"`)
  - `iconSet: "emoji" | "nerd"` (default `"emoji"`)
  - `measurementMode: "e2e" | "stream"` (default `"e2e"`)
- `/gauge` command: no args → show current settings; subcommands toggle visibility, display/icon sets, and measurement mode + persist.

## Status

- [x] Scaffold repo (package.json, tsconfig.json, README, LICENSE, CI + release workflows)
- [x] Plan written (`.agents/plans/000-gauge-scaffold.md`)
- [x] Measurement-modes design researched (`.agents/plans/001-measurement-modes.md` — response-JSON mode not feasible, toggle is TPS denominator `e2e`|`stream`)
- [x] Extension implemented (`src/index.ts` → `dist/index.js`, 6 pure helpers exported for tests)
- [x] Unit tests (`tests/gauge.test.mjs`, 27 tests, `npm test` green)
- [x] Smoke-tested (`pi -e ./dist/index.js -p "..."` loads clean; harness-driven event test renders `[⚡ 71.2 t/s ⏱ 50ms]` + nerd/icon variants, `/gauge` toggles persist)
- [x] Git repo initialized + pushed to `championswimmer/pi-gauge`
- [x] Published v0.1.0 to npm (`pi-gauge@0.1.0`, `latest`; first publish manual — future releases via trusted publishing + `node scripts/release.mjs`)
