# The `.codexskin` Specification · 规范

**Version 1.0 · schemaVersion 2**

A `.codexskin` is a zip archive carrying an asset-based UI theme for the official OpenAI Codex desktop app. Skins are injected into the running app over the Chrome DevTools Protocol (loopback only) — **no app file is modified, the code signature stays intact, and turning a skin off restores stock instantly**.

`.codexskin` 是官方 Codex 桌面应用的「素材化 UI」主题包（zip 容器）。皮肤通过回环 CDP 注入运行中的应用——**不改任何应用文件、签名完好、关闭即刻还原**。

## 1. Archive layout · 包结构

Contents sit at the **zip root** (installers place the package by manifest `id`, never by folder name):

```
<id>-<version>.codexskin        # naming convention for the archive file
├── theme.json                  # required — manifest (see §2)
├── theme.css                   # required — all selectors scoped to html.codex-theme-studio
├── chrome.html                 # optional — decorative overlay fragment (pointer-events: none)
├── previews/
│   └── home.webp               # required for distribution — cover screenshot (see §3)
└── assets/*.webp               # bitmap assets referenced by theme.json
```

## 2. Manifest (`theme.json`) · 清单

```jsonc
{
  "schemaVersion": 2,               // required, literally 2
  "id": "guts-terminal",            // required, ^[a-z0-9][a-z0-9-]{0,63}$, unique
  "name": "TPC GUTS Command Terminal",
  "description": "…",               // ≤ 240 chars

  // —— delivery metadata (loader-optional, REQUIRED by the pack gate) ——
  "version": "1.0.0",               // the skin's own semver
  "author": "wangnov",              // string or { "name", "url" }
  "codexVerified": "26.707.91948",  // Codex version verified against (read it, don't guess)
  "appearance": "dual",             // "dark" | "light" | "dual"
  "license": "personal-use",        // see DISCLAIMER.md
  "tags": ["tokusatsu"],            // optional, ≤ 8, same charset as id
  "previews": ["previews/home.webp"], // first entry is the cover

  // —— render payload ——
  "colors":  { "amber": "#e8a33d" },   // → CSS vars --cts-color-<key>
  "strings": { "hero-title": "…" },    // → --cts-str-<key> + [data-cts-text]
  "assets":  { "wall": "assets/wall.webp" }, // → --cts-asset-<key> (data URL)
  "codexTheme": { … }               // optional native appearance block, written
                                    // to ~/.codex/config.toml on apply-with-restart
}
```

**Hard limits · 硬限制**

| Rule | Value | Why |
|---|---|---|
| Single asset size | ≤ **1.4 MB** raw | Chromium silently invalidates `data:` URLs over 2 MB (base64 ≈ ×1.34) |
| Asset formats | webp / png / jpg | webp preferred |
| Text on bitmaps | **forbidden** | all copy must be live DOM (brand-logo art is the sole exception) |
| CSS scope | every selector under `html.codex-theme-studio` | single-class full reversal |
| Overlay layers | `pointer-events: none`, only `#cts-stage` / `#cts-chrome` | never intercept interaction |
| Archive | ≤ 50 MB, ≤ 500 entries | importer caps |

## 3. Previews · 预览图

Previews are **real screenshots taken from a running, themed Codex** — concept art or mockups are not acceptable as previews. 预览必须是注入后真机截图，概念图/效果图不得充当预览。

- Cover `previews/home.webp`: home route, sidebar sections (pinned / projects / tasks) collapsed, intro finished, **1280×800** WebP, ≤ 500 KB recommended (1 MB hard cap).
- Optional extra shots (`chat`, `alt`, …) up to 4 total.
- Tooling: `node studio/bin/codex-theme.mjs preview-shot <id>` frames and registers the cover automatically (asserts route & intro, captures at 2×, downsamples).

## 4. Quality gate · 质量门（`pack`）

`node studio/bin/codex-theme.mjs pack <id>` is the delivery gate. It refuses to produce an archive unless:

1. full structural validation passes (schema, asset budgets, path containment);
2. `version`, `codexVerified` and at least one existing preview are present;
3. the directory name equals the manifest `id`.

Output: `dist/<id>-<version>.codexskin`. The same gate runs in CI for every registry submission.

## 5. Runtime contract · 运行时契约

Injection is idempotent and reversible. The injected runtime stamps `window.__CODEX_THEME_STUDIO__.stamp = "<engineVersion>:<id>:<sha1(runtime+css+chrome+config)[..12]>"`; reconcilers (the studio watcher, Codex App Manager's daemon) re-inject only on stamp mismatch. Removal restores a byte-identical stock DOM (`class`/`style`/overlay/attribute zero-residue).

## 6. Consumers · 消费端

- **[Codex App Manager](https://github.com/Wangnov/Codex-App-Manager)** — gallery, one-click try-on (live hot-swap), apply-with-restart, full restore, `.codexskin` import via picker / drag-and-drop.
- **studio CLI** (this repo) — `start` / `use` / `off` / `verify` / `screenshot` for development and manual use.

Anything that honors this spec is a valid consumer. 遵循本规范者皆为合法消费端。
