// Builds the Runtime.evaluate payload: the renderer runtime template with the
// theme CSS, config, chrome fragment and inlined assets substituted in.

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadTheme, inlineAssets } from "./theme.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const STUDIO_VERSION = "0.1.0";
const RUNTIME_TEMPLATE = path.join(here, "runtime", "theme-runtime.js");

export async function buildPayload(themeDir) {
  const theme = await loadTheme(themeDir);
  const [template, dataUrls] = await Promise.all([
    fs.readFile(RUNTIME_TEMPLATE, "utf8"),
    inlineAssets(theme),
  ]);
  // Asset variables ride inside the stylesheet as data: URLs — immune to the
  // blob revocation races that break late-loading images (e.g. border-image).
  const assetVariables = Object.entries(dataUrls)
    .map(([key, url]) => `  --cts-asset-${key}: url("${url}");`)
    .join("\n");
  const cssWithAssets = `:root.codex-theme-studio {\n${assetVariables}\n}\n\n${theme.css}`;
  // Fingerprint the PACKED artifacts (not the source files) so packaging
  // changes also propagate to renderers that already carry the theme.
  const stamp = crypto.createHash("sha1")
    .update(cssWithAssets).update(theme.chromeHtml ?? "")
    .update(JSON.stringify(theme.config))
    .digest("hex").slice(0, 12);
  const payload = template
    .replace("__CTS_CSS_JSON__", () => JSON.stringify(cssWithAssets))
    .replace("__CTS_THEME_JSON__", () => JSON.stringify(theme.config))
    .replace("__CTS_CHROME_JSON__", () => JSON.stringify(theme.chromeHtml))
    .replace("__CTS_VERSION_JSON__", () => JSON.stringify(STUDIO_VERSION))
    .replace("__CTS_STAMP_JSON__", () => JSON.stringify(`${STUDIO_VERSION}:${theme.config.id}:${stamp}`));
  return {
    payload,
    theme: theme.config,
    payloadBytes: Buffer.byteLength(payload),
    assetCount: Object.keys(dataUrls).length,
  };
}

export const REMOVE_EXPRESSION = `(() => {
  window.__CODEX_THEME_STUDIO_DISABLED__ = true;
  const state = window.__CODEX_THEME_STUDIO__;
  if (state?.cleanup) return state.cleanup();
  document.documentElement?.classList.remove('codex-theme-studio');
  document.documentElement?.removeAttribute('data-cts-theme');
  document.documentElement?.removeAttribute('data-cts-shell');
  document.getElementById('cts-style')?.remove();
  document.getElementById('cts-chrome')?.remove();
  delete window.__CODEX_THEME_STUDIO__;
  return true;
})()`;

export const VERIFY_REMOVED_EXPRESSION = `(() =>
  !document.documentElement.classList.contains('codex-theme-studio') &&
  !document.getElementById('cts-style') &&
  !document.getElementById('cts-chrome') &&
  !window.__CODEX_THEME_STUDIO__
)()`;

export function verifyExpression(expectedVersion = STUDIO_VERSION) {
  return `(() => {
    const box = (node) => {
      if (!node) return null;
      const r = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        x: Math.round(r.x), y: Math.round(r.y),
        width: Math.round(r.width), height: Math.round(r.height),
        visible: r.width > 0 && r.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
      };
    };
    const chrome = document.getElementById('cts-chrome');
    const state = window.__CODEX_THEME_STUDIO__;
    const composer = box(document.querySelector('.composer-surface-chrome'));
    const sidebar = box(document.querySelector('aside.app-shell-left-panel'));
    const result = {
      installed: document.documentElement.classList.contains('codex-theme-studio'),
      themeId: document.documentElement.getAttribute('data-cts-theme'),
      version: state?.version ?? null,
      stylePresent: Boolean(document.getElementById('cts-style')),
      chromePresent: Boolean(chrome),
      chromePointerEvents: chrome ? getComputedStyle(chrome).pointerEvents : null,
      composer,
      sidebar,
      viewport: { width: innerWidth, height: innerHeight },
      documentOverflow: {
        x: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        y: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      },
    };
    result.pass = Boolean(
      result.installed &&
      result.version === ${JSON.stringify(expectedVersion)} &&
      result.stylePresent &&
      (!result.chromePresent || result.chromePointerEvents === 'none') &&
      Boolean(result.composer?.visible) &&
      Boolean(result.sidebar?.visible) &&
      !result.documentOverflow.x
    );
    return result;
  })()`;
}
