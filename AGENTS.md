# AGENTS.md

Guide for AI coding agents working in this repository.

## What this repo is

`awesome-codex-skins` is the `.codexskin` standard, toolchain, and gallery for
the official OpenAI Codex desktop app. A `.codexskin` is a zip archive that
carries an asset-based UI theme; it is injected into a running Codex over the
Chrome DevTools Protocol (loopback only) — no app file is modified, the code
signature stays intact, and turning a skin off restores stock instantly.

Layout:

- `SPEC.md` — the `.codexskin` format: archive layout, manifest schema, hard
  limits, preview standard, and the quality gate.
- `studio/` — the `codex-theme` CLI (Node, ESM, `bin/codex-theme.mjs` +
  `src/`) that launches/attaches to Codex over CDP, hot-swaps themes, and
  packs skins. Tests live in `studio/test/*.test.mjs`.
- `skins/<id>/` — one directory per skin (currently 50): `theme.json`,
  `theme.css`, optional `chrome.html`, `previews/home.webp`, `assets/*`.
- `skills/codex-theme-maker/` — the agent skill that drives skin production
  end to end (see below).
- `scripts/build-catalog.mjs` — builds the published catalog
  (`dist-catalog/`: `index.json`, `packs/`, `previews/`).
- `.github/workflows/validate-skins.yml` — CI: pack gate on every PR/push,
  catalog publish to `skins.agentsmirror.com` on push to `main`.
- `REGISTRY.md`, `DISCLAIMER.md`, `LICENSE` — registry/tiering, non-official
  fan-use disclaimer, MIT (code; skins carry their own `license` field).

## The spec and the quality gate

Read `SPEC.md` before touching anything under `skins/` or the pack logic in
`studio/`. Key rules a skin must satisfy:

- Manifest `theme.json` is `schemaVersion: 2`; `id` matches
  `^[a-z0-9][a-z0-9-]{0,63}$` and must equal the containing directory name.
- Delivery metadata is required for packing: `version` (semver), `author`,
  `codexVerified`, `appearance` (must be `"dual"` for pack-ready skins),
  `license`, and at least one real preview under `previews/`.
- Every CSS selector is scoped under `html.codex-theme-studio`; overlay
  layers (`#cts-stage` / `#cts-chrome`) are `pointer-events: none`.
- Static assets: WebP/PNG/JPG, ≤ 1.4 MB each, ≤ 24 MB combined; no text baked
  into bitmaps (all copy is live DOM). Optional `motionAssets.intro-video`
  (mp4/webm) ≤ 24 MB, must ship a static `assets.intro` fallback.
- Previews are real screenshots of a running, themed Codex — never mockups —
  1280×800 WebP cover at `previews/home.webp`.
- Archive caps: ≤ 50 MB, ≤ 500 entries.

The gate: `node studio/bin/codex-theme.mjs pack <id> --out <dir>` is the
single source of truth for whether a skin is submittable. It runs full
structural validation, asset-budget checks, path containment, and native
`codexTheme` validation, and refuses to produce an archive if anything is
missing. CI runs the exact same command for every skin on every PR — no gate,
no merge.

## Studio CLI: commands and tests

Working directory for these commands is `studio/`.

```bash
npm run check   # node --check over every src/*.mjs + bin/codex-theme.mjs
npm test        # node --test test/*.test.mjs
```

CLI subcommands (see the header comment in `bin/codex-theme.mjs` for the
current list): `start`, `use`, `off`, `stop`, `status`, `themes`, `verify`,
`screenshot`, `preview-shot`, `pack`. Skin directories resolve via
`CODEX_SKINS_ROOT`, else `<repo>/skins`, else a legacy `<studio>/themes`
fallback.

Requirements: macOS, Node ≥ 20, the official Codex app (`Codex.app` or the
post-rebrand `ChatGPT.app`); `CODEX_APP_PATH` overrides a nonstandard
install location.

## CI: validation and publishing

`.github/workflows/validate-skins.yml`, triggered on PRs and pushes touching
`skins/**`, `studio/**`, `scripts/**`, or the workflow itself (plus manual
dispatch):

- `pack-gate` job: runs `npm run check` and `npm test` in `studio/`, then
  packs every directory under `skins/*/` through the gate and uploads the
  resulting `.codexskin` archives as a build artifact. Any pack failure fails
  the job.
- `publish-catalog` job: runs only on push to `main` (never for fork PRs,
  since it needs R2 secrets), after `pack-gate` passes. It packs every skin
  to `dist/`, builds the catalog with `scripts/build-catalog.mjs`, and syncs
  `dist-catalog/` to Cloudflare R2, which serves `skins.agentsmirror.com`.
  `main` is treated as the catalog's source of truth — every push
  republishes the live site.

## The `codex-theme-maker` skill

`skills/codex-theme-maker/` is a portable Agent Skill (plain `SKILL.md`, no
plugin needed) usable from both Claude Code and Codex, installable via
`npx skills add wangnov/awesome-codex-skins --skill codex-theme-maker -g`. It
walks an agent through turning a concept image or IP style into a finished,
packed `.codexskin`, using `skins/guts-terminal` as the acceptance baseline.
Layout:

- `SKILL.md` — the phase-by-phase playbook (asset design, generation, theme
  assembly, CDP iteration, acceptance checks, delivery packing).
- `references/` — `asset-pipeline.md` (generation/cutout/validation),
  `css-recipes.md` (DOM map and CSS recipes), `reuse-and-validation.md`.
- `scripts/` — asset tooling: `asset_contact_sheet.py`, `normalize_alpha.py`,
  `verify-alpha.py`, `audit-theme.mjs`.
- `agents/openai.yaml` — Codex-specific agent wiring for the skill.

## Runtime source of truth is moving

The CDP injection runtime that ships in `studio/` is being unified with
Codex App Manager's `crates/codex-theme-engine` on a separate branch
(`refactor/single-theme-runtime`, not yet on `main`). Once that work lands,
Codex App Manager becomes the canonical runtime implementation; treat that
migration as in progress and do not assume its details until it merges.

## Contributing: PRs and commits

- Submissions are PRs adding a full `skins/<id>/` source directory (not just
  a built archive). CI must pass the same `pack` gate as local dev.
- Skins are tiered in `REGISTRY.md`: **Certified** (CI green + maintainer
  verified on a real Codex) vs. **Community** (CI green only).
- Commit messages in this repo's history follow Conventional Commits
  (`feat(skins): …`, `fix(studio): …`, `docs: …`, `ci: …`), often referencing
  a PR number.
