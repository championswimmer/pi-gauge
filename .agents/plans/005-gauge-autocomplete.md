# Plan 005 — Tab-complete `/gauge` subcommands

Status: **done** (implemented + tested, 56 tests green)

## Goal

Make `/gauge <subcommand>` arguments autocompletable (tab completion in pi's TUI input).

## Research (done, pi-coding-agent 0.87.1)

- `RegisteredCommand` (`dist/core/extensions/types.d.ts:963-968`) supports:
  `getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null | Promise<...>`
- `AutocompleteItem = { value, label, description? }`, exported from `@earendil-works/pi-tui`
  (`dist/autocomplete.d.ts`) — already a peer dep, already imported from in `src/index.ts`.
- Runtime (`CombinedAutocompleteProvider.getSuggestions`): after `/gauge `, the full
  argument text is passed as `argumentPrefix`; returned items replace the prefix on apply.
  No ctx is passed, so dynamic values (model names for `/gauge graph [model]`) are unavailable —
  return `null` in that position.
- Example: `examples/extensions/commands.ts:15-21` (filter by `startsWith`, `null` when empty).

## Design

- Pure, exported, tested helper `gaugeCompletions(prefix: string): AutocompleteItem[] | null`:
  - 1st token → subcommands: `tps ttft mode display icons graph` (+ legacy aliases
    `throughput latency`), each with a short `description`.
  - 2nd token → per-subcommand values (`on|off`, `e2e|stream`, `pill|icon`, `emoji|nerd`);
    `graph` 2nd position → `null` (model names unknowable without ctx).
  - 3rd+ token → `null`. Case-insensitive `startsWith` filter; `null` when nothing matches.
- Wire as `getArgumentCompletions: (prefix) => gaugeCompletions(prefix)` in `registerCommand`.

## Verification

1. `npm run build` + `npm test` green (new tests for 1st/2nd position, aliases, trailing-space,
   unknown subcommand, 3rd-token-null).
2. Manual: load via `pi -e ./dist/index.js`, type `/gauge t` + tab etc. (TUI check if feasible).
3. Docs: README `/gauge` table gets a tab-completion note; AGENTS.md status updated.
4. Release: `node scripts/release.mjs patch` (0.3.0 → 0.3.1).
