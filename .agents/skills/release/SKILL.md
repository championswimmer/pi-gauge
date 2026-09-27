---
name: release
description: Cut a pi-gauge release (major, minor, or patch) by bumping the version, rebuilding dist, committing, tagging, and pushing so GitHub Actions publishes to npm via trusted publishing. Use when asked to do a major, minor, or patch release, or when the user invokes /release major, /release minor, or /release patch.
---

# Release

Use this skill when asked to release this package, especially through `/release major`, `/release minor`, or `/release patch`.

## Repository release model

npm publishing is tag-driven in CI for this repo:

- Workflow: `.github/workflows/release.yml`
- Trigger: pushing a semver tag like `v1.2.3` (the tag must match `package.json` version)
- Publish: `npm publish` via npm trusted publishing (GitHub OIDC — no `NPM_TOKEN`)

Because of that, **do not run `npm publish` locally during a normal release**. The correct way to "make npm publish happen" is to bump, rebuild `dist/`, commit, tag, push `main`, and push the tag. A local `npm publish` would race with or duplicate the CI release.

## Inputs

Accepted release types: `major`, `minor`, `patch`. Anything else — ask for clarification.

## Safety checks before releasing

- the working tree is clean
- releases go from `main`, fast-forwarded from `origin/main`
- `.github/workflows/release.yml` and `scripts/release.mjs` exist

If any check fails, stop and explain why.

## Preferred execution path

```bash
node scripts/release.mjs <major|minor|patch>
```

The script is the authoritative release path. It:

1. validates the bump type
2. requires a clean tree and the `main` branch
3. `git fetch` + `git pull --ff-only origin main`
4. `npm run build` (so the tracked `dist/` output is fresh)
5. `npm test` (build + unit tests must pass)
6. commits fresh build output first if the rebuild changed `dist/` (`npm version` refuses a dirty tree)
7. `npm pack --dry-run` (validates the tarball file list)
8. `npm version <type> -m "release v%s"` (version commit + `vX.Y.Z` tag)
9. `git push origin main` and `git push origin <tag>`
10. prints old/new versions and reminds you CI publishes to npm

## After the release succeeds

Report the old version, new version, created tag, pushed refs, and that npm publication runs in `.github/workflows/release.yml` after the tag push. If `gh` is available and verification was asked for, watch the `Release to npm` workflow run.

## Failure handling

Do not guess. Quote the failing command/stderr, state what already completed (e.g. commit/tag created but push failed), and give exact recovery steps before attempting cleanup.
