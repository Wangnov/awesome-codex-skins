// Builds the Runtime.evaluate payload: the renderer runtime template with the
// theme CSS, config, chrome fragment and inlined assets substituted in.

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadTheme, inlineAssets } from "./theme.mjs";
import {
  createComposerOverflowAnnotator,
  selectComposerSurfaces,
} from "./composer-overflow.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const STUDIO_VERSION = "0.1.0";
const RUNTIME_TEMPLATE = path.join(here, "runtime", "theme-runtime.js");
const COMPOSER_ANNOTATOR_SOURCE = `(${createComposerOverflowAnnotator.toString()})`;
const COMPOSER_SURFACE_SELECTOR_SOURCE = `(${selectComposerSurfaces.toString()})`;

// Runtime-owned composer overflow contract. Theme art is allowed to extend
// beyond the shell without turning the shell into a scroll container; only the
// finite-height editor root may scroll vertically. Appended after theme CSS so
// old packages and theme-local `overflow-x` rules cannot reintroduce the bug.
export const RUNTIME_HARDENING_CSS = `
html.codex-theme-studio [data-cts-composer-overflow="shell"] {
  overflow: clip !important;
  overflow-clip-margin: 64px !important;
}

html.codex-theme-studio [data-cts-composer-overflow="lane"] {
  overflow: visible !important;
}

html.codex-theme-studio [data-cts-composer-overflow="editor"] {
  overflow-x: hidden !important;
  overflow-y: auto !important;
  overscroll-behavior: contain !important;
}
`;

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
  const cssWithAssets = `:root.codex-theme-studio {\n${assetVariables}\n}\n\n${theme.css}\n\n${RUNTIME_HARDENING_CSS}`;
  // Fingerprint the executable payload, including the renderer runtime and
  // packed CSS, so runtime-only compatibility fixes re-inject into renderers
  // that already carry the same theme.
  const stamp = crypto.createHash("sha1")
    .update(template).update(COMPOSER_ANNOTATOR_SOURCE)
    .update(COMPOSER_SURFACE_SELECTOR_SOURCE)
    .update(cssWithAssets).update(theme.chromeHtml ?? "")
    .update(JSON.stringify(theme.config))
    .digest("hex").slice(0, 12);
  const payload = template
    .replace("__CTS_CREATE_COMPOSER_OVERFLOW_ANNOTATOR__", () => COMPOSER_ANNOTATOR_SOURCE)
    .replace("__CTS_SELECT_COMPOSER_SURFACES__", () => COMPOSER_SURFACE_SELECTOR_SOURCE)
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
  document.querySelectorAll('.cts-windows-menu-bar').forEach((node) => node.classList.remove('cts-windows-menu-bar'));
  document.querySelectorAll('[data-cts-menu-region]').forEach((node) => node.removeAttribute('data-cts-menu-region'));
  document.querySelectorAll('[data-cts-composer-overflow]').forEach((node) => node.removeAttribute('data-cts-composer-overflow'));
  document.querySelectorAll('[data-cts-composer-mode]').forEach((node) => node.removeAttribute('data-cts-composer-mode'));
  document.documentElement?.style.removeProperty('--cts-windows-menu-height');
  document.documentElement?.style.removeProperty('--cts-windows-sidebar-padding-top');
  document.documentElement?.style.removeProperty('--cts-windows-main-padding-top');
  document.documentElement?.style.removeProperty('--cts-windows-sidebar-foreground');
  document.documentElement?.style.removeProperty('--cts-windows-main-foreground');
  document.getElementById('cts-style')?.remove();
  document.getElementById('cts-chrome')?.remove();
  document.getElementById('cts-stage')?.remove();
  document.getElementById('cts-intro')?.remove();
  delete window.__CODEX_THEME_STUDIO__;
  return true;
})()`;

export const VERIFY_REMOVED_EXPRESSION = `(() =>
  !document.documentElement.classList.contains('codex-theme-studio') &&
  !document.querySelector('.cts-windows-menu-bar') &&
  !document.querySelector('[data-cts-menu-region]') &&
  !document.querySelector('[data-cts-composer-overflow]') &&
  !document.querySelector('[data-cts-composer-mode]') &&
  !document.documentElement.style.getPropertyValue('--cts-windows-menu-height') &&
  !document.documentElement.style.getPropertyValue('--cts-windows-sidebar-padding-top') &&
  !document.documentElement.style.getPropertyValue('--cts-windows-main-padding-top') &&
  !document.documentElement.style.getPropertyValue('--cts-windows-sidebar-foreground') &&
  !document.documentElement.style.getPropertyValue('--cts-windows-main-foreground') &&
  !document.getElementById('cts-style') &&
  !document.getElementById('cts-chrome') &&
  !document.getElementById('cts-stage') &&
  !document.getElementById('cts-intro') &&
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
    const hostVersion = (() => {
      try {
        const value = window.electronBridge?.getSentryInitOptions?.()?.appVersion;
        return typeof value === 'string' && /^\\d+\\./.test(value) ? value : null;
      } catch {
        return null;
      }
    })();
    const hostCompatibility = hostVersion === '26.715.31251'
      ? { audited: true, profile: 'composer-three-layer', composerLanePolicy: 'required' }
      : hostVersion === '26.715.31925'
        ? { audited: true, profile: 'composer-two-or-three-layer', composerLanePolicy: 'optional' }
        : { audited: false, profile: 'capability-adaptive', composerLanePolicy: 'optional' };
    const selectComposerSurfaces = ${COMPOSER_SURFACE_SELECTOR_SOURCE};
    const composerNodes = selectComposerSurfaces(document);
    const composerNode = composerNodes.find((node) => {
      const r = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return r.width > 0 && r.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }) ?? composerNodes[0] ?? null;
    const composer = box(composerNode);
    const composerEditor = composerNode?.querySelector('[data-cts-composer-overflow="editor"]') ?? null;
    const composerLanes = composerNode
      ? [...composerNode.querySelectorAll('[data-cts-composer-overflow="lane"]')]
      : [];
    const composerOverflow = composerNode ? {
      shellRole: composerNode.getAttribute('data-cts-composer-overflow'),
      mode: composerNode.getAttribute('data-cts-composer-mode'),
      shellOverflowY: getComputedStyle(composerNode).overflowY,
      laneCount: composerLanes.length,
      laneOverflowYs: composerLanes.map((node) => getComputedStyle(node).overflowY),
      lanesValid: composerLanes.every((node) => getComputedStyle(node).overflowY === 'visible'),
      lanePolicyValid: hostCompatibility.composerLanePolicy !== 'required' || composerLanes.length >= 1,
      editorCount: composerNode.querySelectorAll('[data-cts-composer-overflow="editor"]').length,
      editorOverflowY: composerEditor ? getComputedStyle(composerEditor).overflowY : null,
    } : null;
    if (composerOverflow) {
      composerOverflow.modeValid = composerOverflow.mode === 'single-line' ||
        composerOverflow.mode === 'scrolling';
      composerOverflow.editorValid = composerOverflow.mode === 'single-line'
        ? composerOverflow.editorCount === 0
        : composerOverflow.mode === 'scrolling' &&
          composerOverflow.editorCount === 1 &&
          composerOverflow.editorOverflowY === 'auto';
    }
    const sidebar = box(document.querySelector('aside.app-shell-left-panel'));
    const result = {
      installed: document.documentElement.classList.contains('codex-theme-studio'),
      themeId: document.documentElement.getAttribute('data-cts-theme'),
      version: state?.version ?? null,
      hostVersion,
      hostCompatibility,
      stylePresent: Boolean(document.getElementById('cts-style')),
      chromePresent: Boolean(chrome),
      chromePointerEvents: chrome ? getComputedStyle(chrome).pointerEvents : null,
      composer,
      composerOverflow,
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
      result.composerOverflow?.shellRole === 'shell' &&
      result.composerOverflow?.shellOverflowY === 'clip' &&
      result.composerOverflow?.lanesValid === true &&
      result.composerOverflow?.lanePolicyValid === true &&
      result.composerOverflow?.modeValid === true &&
      result.composerOverflow?.editorValid === true &&
      Boolean(result.sidebar?.visible) &&
      !result.documentOverflow.x
    );
    return result;
  })()`;
}
