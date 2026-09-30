<!-- Skin submission checklist · 皮肤投稿清单 -->

## Skin

- Id / directory: `skins/<id>/`
- One-line pitch:

## Checklist

- [ ] `theme.json` carries `version`, `author`, `codexVerified` (read from your Codex, not guessed), `license`
- [ ] `previews/home.webp` is a **real screenshot** of the themed, running Codex (home route, sidebar sections collapsed, 1280×800) — not concept art; produced by `preview-shot` without `--allow-visible-sidebar`, and I looked at the WebP myself: no private chats/projects/tasks or workspace names anywhere (the check covers only the sidebar, not the composer selector or header)
- [ ] All bitmap assets are text-free (live DOM carries every string)
- [ ] `node studio/bin/codex-theme.mjs pack <id>` succeeds locally
- [ ] `off` leaves zero residue (class/style/overlay all restored)
- [ ] IP-referencing content: `"license": "personal-use"` set, and you accept the repo [DISCLAIMER](../DISCLAIMER.md) takedown terms
