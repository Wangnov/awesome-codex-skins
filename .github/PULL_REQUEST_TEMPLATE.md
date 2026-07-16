<!-- Skin submission checklist · 皮肤投稿清单 -->

## Skin

- Id / directory: `skins/<id>/`
- One-line pitch:

## Checklist

- [ ] `theme.json` carries `version`, `author`, `codexVerified` (read from your Codex, not guessed), `license`
- [ ] `previews/home.webp` is a **real screenshot** of the themed, running Codex (home route, sidebar sections collapsed, 1280×800) — not concept art
- [ ] All bitmap assets are text-free (live DOM carries every string)
- [ ] `node studio/bin/codex-theme.mjs pack <id>` succeeds locally
- [ ] `off` leaves zero residue (class/style/overlay all restored)
- [ ] IP-referencing content: `"license": "personal-use"` set, and you accept the repo [DISCLAIMER](../DISCLAIMER.md) takedown terms
