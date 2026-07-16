# Awesome Codex Skins

> **The `.codexskin` standard, toolchain & gallery** — asset-based UI themes for the official OpenAI Codex desktop app. Injected live over CDP: no app files touched, signature intact, one command to revert.
>
> **`.codexskin` 标准、工具链与画廊** —— 官方 Codex 桌面应用的素材化 UI 主题。CDP 实时注入：不改应用文件、签名完好、一条命令完全还原。

**Every preview below is a real screenshot of a themed, running Codex, taken under an automated quality gate. No mockups, no concept art.**
**以下每张预览都是注入后真机截图，经自动化质量门产出——没有效果图，没有概念稿。**

## Gallery · 画廊

| | |
|:---:|:---:|
| ![GUTS Terminal](skins/guts-terminal/previews/home.webp) **TPC GUTS Command Terminal** `guts-terminal` — Ultraman Tiga command-deck terminal · 迪迦奥特曼 TPC/GUTS 指挥终端 | ![Asuka EVA-02](skins/asuka-eva02/previews/home.webp) **NERV EVA-02 Asuka** `asuka-eva02` — Unit-02 console, hazard-striped · 明日香与二号机 |
| ![Rei EVA-00](skins/rei-eva00/previews/home.webp) **NERV EVA-00 Rei** `rei-eva00` — pale-blue LCL calm · 绫波丽与零号机 | ![Kaworu Mark.06](skins/kaworu-mark06/previews/home.webp) **Mark.06 Kaworu** `kaworu-mark06` — moonlit SEELE tones · 渚薰与 Mark.06 |
| ![Shinji EVA-01](skins/shinji-eva01/previews/home.webp) **NERV EVA-01 Shinji** `shinji-eva01` — Test Type purple/green · 碇真嗣与初号机 | *Your skin here — see [Contributing](#contributing--投稿收录)* |

## Use a skin · 使用皮肤

**Option A — [Codex App Manager](https://github.com/Wangnov/Codex-App-Manager)（recommended · 推荐）**
The desktop manager ships a skin gallery with one-click **try-on** (live hot-swap on a running Codex), **apply** (persistent, incl. native accent/font config), full restore, and `.codexskin` import via drag-and-drop. 桌面管理器内置皮肤画廊：一键试穿（运行中热切换）、持久应用、完全还原、拖入 `.codexskin` 即装。

**Option B — studio CLI（this repo · 本仓库）**

```bash
git clone https://github.com/Wangnov/awesome-codex-skins
cd awesome-codex-skins/studio
node bin/codex-theme.mjs start --theme guts-terminal   # launch Codex (loopback CDP) + inject
node bin/codex-theme.mjs use rei-eva00                 # hot-swap, no restart
node bin/codex-theme.mjs off                           # back to stock, instantly
```

Requirements: macOS, Node ≥ 20, official Codex.app. Windows support tracks [Codex App Manager](https://github.com/Wangnov/Codex-App-Manager).

## Make a skin · 制作皮肤

The repo ships the full production line — an agent skill that takes a concept image / IP style all the way to a packed `.codexskin`, for **both Claude Code and Codex** (plain `SKILL.md`, no plugin required):

仓库内置完整生产线——把一张概念图/一种 IP 风格做成成品 `.codexskin` 的 Agent Skill，**Claude Code 与 Codex 通用**（纯 SKILL.md，无需插件）：

```bash
# Claude Code
cp -r skills/codex-theme-maker ~/.claude/skills/
# Codex — place it in your skills directory likewise
```

Then just ask your agent: *"做一个 XX 风格的 Codex 皮肤"*. The skill drives asset generation (magenta-matte cutouts, alpha gates), CSS assembly against the DOM recipe book, live CDP iteration, a structural acceptance suite, and the final `pack` delivery gate. See [skills/codex-theme-maker/SKILL.md](skills/codex-theme-maker/SKILL.md) and [SPEC.md](SPEC.md).

## Contributing · 投稿收录

Submissions are PRs adding `skins/<id>/` (source, not just the archive). The CI gate runs the same `pack` validation as local dev — schema, asset budgets, real-screenshot previews, `version`/`codexVerified` present. 投稿即 PR：提交 `skins/<id>/` 源目录，CI 自动跑与本地一致的 `pack` 质量门。

| Tier | Meaning |
|---|---|
| **Certified** | CI green **+** maintainer verified on a real Codex |
| **Community** | CI green (format-valid), not yet hand-verified |

See [REGISTRY.md](REGISTRY.md) for the full list.

## Spec & principles · 规范与原则

- [SPEC.md](SPEC.md) — the `.codexskin` format, hard limits, preview standard, quality gate
- [DISCLAIMER.md](DISCLAIMER.md) — unofficial status, fan-art licensing, takedown process
- Core principles: **asset-based UI, not a palette swap** · all text stays live DOM · fully reversible · zero interaction interception · previews are verified screenshots

---

*Unofficial project; not affiliated with OpenAI. IP-referencing skins are non-commercial fan art — see [DISCLAIMER.md](DISCLAIMER.md).*
