# 002 — `/gauge` settings dialog (TUI overlay)

Status: done.

## Scope

Bare `/gauge` in TUI mode opens a bordered settings dialog (overlay) instead of
just notifying the current settings line. Subcommands (`/gauge tps off`, …)
keep working unchanged, and bare `/gauge` outside TUI mode keeps notifying.

## Design

- Opened via `ctx.ui.custom<boolean>(factory, { overlay: true,
  overlayOptions: { anchor: "center", width: DIALOG_WIDTH + 4 } })`
  (pattern from pi's `examples/extensions/tools.ts` + `overlay-test.ts`).
- `GaugeDialog implements Component` from `@earendil-works/pi-tui`
  (already a peer dep): manual `╭─╮│╰─╯` border so borders run all the way
  around; `visibleWidth()` for padding math; `matchesKey()` for input.
- 5 rows, all editable in the box: throughput on/off, latency (TTFT) on/off,
  measurement mode e2e/stream, display pill/icon, icons emoji/nerd.
  `↑/↓` move, `←/→`/`space`/`enter` cycle the focused value.
- Edits mutate a `draft` copy; committed to `settings` + `saveSettings()`
  only on save. Header shows `● unsaved` (warning color) when draft differs.
- Demo preview at the bottom uses mocked values via pure exported
  `demoPreview(settings)` = `renderText(s, 84.2, 412, 2000, 0, 412)`
  → `[⚡ 42.1 t/s ⏱ 412ms]` under defaults; `(hidden)` when both off.
- `ctrl+s` (`"ctrl+s"` / `\x13` fallback) → `done(true)` = save + notify +
  re-render status. `esc` → `done(false)` = discard (+ notify only if dirty).

## Verification

1. `npm run build` clean (tsc, NodeNext, strict).
2. `npm test` green (existing 27 tests + new `demoPreview` tests).
3. Manual: `pi -e ./dist/index.js`, run `/gauge`, toggle rows, check demo
   updates + `● unsaved` appears, `ctrl+s` persists to
   `~/.pi/agent/pi-gauge.json`, `esc` discards.
4. `dist/` rebuilt + committed (pi installs with `--omit=dev`, no build step).
