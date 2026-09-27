# Plan 000 — pi-gauge v0.1.0 scaffold

**Status:** in progress
**Goal:** Scaffold the `pi-gauge` repo so a basic status-bar latency + throughput extension can be built, tested, and installed.

## Scope (v0.1.0)

1. **Package basics.** `package.json` (`name: "pi-gauge"`, version `0.1.0`, `pi.extensions: ["./dist/index.js"]`), `tsconfig.json` (`src/*.ts` → `dist/`), `.gitignore`/`.npmignore`, MIT `LICENSE`, `README.md`.
2. **Basic extension.** `src/*.ts` exporting `default function (pi: ExtensionAPI)`, compiled via `tsc` to tracked `dist/index.js` (tracked because pi installs git packages with `--omit=dev` and no build step).
3. **Default measurement: e2e.** Anchor TTFT start at `before_provider_request`, first `*_delta` ends TTFT, `message_end` ends the run; re-anchor per LLM call in the tool loop; provider usage quirks (Anthropic cumulative, OpenAI final-only + chars/4 estimate, Google per-chunk); throttle `setStatus` ~4/sec.
4. **Display.** Status-bar pill-or-icon rendering with emoji/nerd-font glyph sets.
5. **` /gauge` command.** No args → show settings; subcommands toggle `showLatency`/`showThroughput`, `displayMode`, `iconSet`, `measurementMode` (persisted to `~/.pi/agent/pi-gauge.json`).
6. **CI + release.** `.github/workflows/` for tests and tag-driven npm release (`vX.Y.Z` tag must match `package.json` version); `tests/*.test.mjs` via `node --test`.

Out of scope: full stream/e2e mode toggle UX details (follow-up plan), npm publish.

## Verification

- [ ] `npm run build` — `tsc` compiles `src/` → `dist/` cleanly
- [ ] `npm test` — `node --test` passes
- [ ] `pi -e ./dist/index.js -p "..."` smoke test — extension loads clean, LLM call succeeds
- [ ] `npm pack --dry-run` — only runtime files included (`dist/`, `package.json`, `README.md`)
