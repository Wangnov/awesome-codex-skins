// Builds the Runtime.evaluate payload: the renderer runtime template with the
// theme CSS, config, chrome fragment and inlined assets substituted in.

import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadTheme, inlineAssets } from "./theme.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const STUDIO_VERSION = "0.1.0";
const RUNTIME_TEMPLATE_PATH = path.join(here, "runtime", "theme-runtime.js");
// The runtime template and this module are both vendored/kept in lockstep
// with codex-theme-engine's payload.rs (see studio/RUNTIME_SOURCE.json): the
// composer-overflow module is embedded as source text — not via
// Function.prototype.toString() on an imported function — and consumed
// through a single __CTS_COMPOSER_OVERFLOW_HELPERS__ placeholder, exactly
// like Rust's `composer_overflow_helpers_expression()`. This is required
// because the vendored theme-runtime.js template only exposes that one
// placeholder; Manager's older two-placeholder convention no longer exists
// in the source runtime.
const COMPOSER_OVERFLOW_MODULE_PATH = path.join(here, "composer-overflow.mjs");
// Read once at module load (mirrors Rust's compile-time `include_str!`);
// verifyExpression() stays synchronous and buildPayload() avoids re-reading
// the same ~8KB file on every call.
const COMPOSER_OVERFLOW_MODULE_SOURCE = readFileSync(COMPOSER_OVERFLOW_MODULE_PATH, "utf8");

/** Builds the `(() => { ...; return { ... }; })()` expression the runtime
 * template destructures its four composer-overflow helpers from. */
function composerOverflowHelpersExpression(moduleSource) {
  const body = moduleSource.replace(/export function /g, "function ");
  return `(() => {\n${body}\nreturn { clearComposerSurfaceCompat, createComposerOverflowAnnotator, reconcileComposerSurfaces, selectComposerSurfaces };\n})()`;
}

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
    fs.readFile(RUNTIME_TEMPLATE_PATH, "utf8"),
    inlineAssets(theme),
  ]);
  // Motion assets skip the stylesheet: multi-megabyte videos blow past the
  // CSS data-URL budget, so they ride a dedicated JSON slot consumed by the
  // runtime's <video> mount instead.
  const motionDataUrls = {};
  for (const key of Object.keys(theme.motionAssets ?? {})) {
    if (dataUrls[key]) motionDataUrls[key] = dataUrls[key];
  }
  // Asset variables ride inside the stylesheet as data: URLs — immune to the
  // blob revocation races that break late-loading images (e.g. border-image).
  const assetVariables = Object.entries(dataUrls)
    .filter(([key]) => !Object.hasOwn(motionDataUrls, key))
    .map(([key, url]) => `  --cts-asset-${key}: url("${url}");`)
    .join("\n");
  const cssWithAssets = `:root.codex-theme-studio {\n${assetVariables}\n}\n\n${theme.css}\n\n${RUNTIME_HARDENING_CSS}`;
  const configJson = JSON.stringify(theme.config);
  const chromeHtml = theme.chromeHtml ?? null;
  const motionJson = JSON.stringify(motionDataUrls);

  // Substitute the composer-overflow helpers first, matching payload.rs:
  // the fingerprint below hashes the runtime template *with* the composer
  // module already inlined, so a composer-overflow-only change still
  // re-stamps even though it never touches theme-runtime.js itself.
  const runtimeTemplate = template.replace(
    "__CTS_COMPOSER_OVERFLOW_HELPERS__",
    () => composerOverflowHelpersExpression(COMPOSER_OVERFLOW_MODULE_SOURCE),
  );

  // Fingerprint the executable payload, including the renderer runtime and
  // packed CSS, so runtime-only compatibility fixes re-inject into renderers
  // that already carry the same theme.
  const short = crypto.createHash("sha1")
    .update(runtimeTemplate)
    .update(cssWithAssets)
    .update(chromeHtml ?? "")
    .update(configJson)
    .update(motionJson)
    .digest("hex").slice(0, 12);
  const stamp = `${STUDIO_VERSION}:${theme.config.id}:${short}`;

  const payload = runtimeTemplate
    .replace("__CTS_CSS_JSON__", () => JSON.stringify(cssWithAssets))
    .replace("__CTS_THEME_JSON__", () => configJson)
    .replace("__CTS_CHROME_JSON__", () => JSON.stringify(chromeHtml))
    .replace("__CTS_MOTION_JSON__", () => motionJson)
    .replace("__CTS_VERSION_JSON__", () => JSON.stringify(STUDIO_VERSION))
    .replace("__CTS_STAMP_JSON__", () => JSON.stringify(stamp));
  return {
    payload,
    theme: theme.config,
    stamp,
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
  document.querySelectorAll('[data-cts-main-surface-compat]').forEach((node) => {
    node.classList.remove('main-surface');
    node.removeAttribute('data-cts-main-surface-compat');
  });
  document.querySelectorAll('.cts-windows-menu-bar').forEach((node) => node.classList.remove('cts-windows-menu-bar'));
  document.querySelectorAll('[data-cts-menu-region]').forEach((node) => node.removeAttribute('data-cts-menu-region'));
  document.querySelectorAll('[data-cts-composer-overflow]').forEach((node) => node.removeAttribute('data-cts-composer-overflow'));
  document.querySelectorAll('[data-cts-composer-mode]').forEach((node) => node.removeAttribute('data-cts-composer-mode'));
  document.querySelectorAll('[data-cts-composer-action]').forEach((node) => node.removeAttribute('data-cts-composer-action'));
  document.querySelectorAll('[data-cts-composer-surface-compat]').forEach((node) => {
    node.classList.remove('composer-surface-chrome');
    node.removeAttribute('data-cts-composer-surface-compat');
  });
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
  !document.querySelector('[data-cts-composer-action]') &&
  !document.querySelector('[data-cts-composer-surface-compat]') &&
  !document.documentElement.style.getPropertyValue('--cts-windows-menu-height') &&
  !document.documentElement.style.getPropertyValue('--cts-windows-sidebar-padding-top') &&
  !document.documentElement.style.getPropertyValue('--cts-windows-main-padding-top') &&
  !document.documentElement.style.getPropertyValue('--cts-windows-sidebar-foreground') &&
  !document.documentElement.style.getPropertyValue('--cts-windows-main-foreground') &&
  !document.getElementById('cts-style') &&
  !document.getElementById('cts-chrome') &&
  !document.getElementById('cts-stage') &&
  !document.getElementById('cts-intro') &&
  !document.querySelector('[data-cts-main-surface-compat]') &&
  !window.__CODEX_THEME_STUDIO__
)()`;

export function verifyExpression(expectedVersion = STUDIO_VERSION) {
  const composerHelpers = composerOverflowHelpersExpression(COMPOSER_OVERFLOW_MODULE_SOURCE);
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
    const hiddenByAncestor = (node) => {
      for (let current = node; current; current = current.parentElement) {
        if (current.hidden ||
            current.getAttribute?.('data-app-shell-active-page') === 'false') return true;
        const style = getComputedStyle(current);
        const contentVisibility = style.contentVisibility || style.getPropertyValue?.('content-visibility');
        if (style.display === 'none' || style.visibility === 'hidden' ||
            style.visibility === 'collapse' || contentVisibility === 'hidden' ||
            Number.parseFloat(style.opacity) === 0) return true;
      }
      return false;
    };
    const visibleSurfaceScore = (node) => {
      if (!node?.isConnected || hiddenByAncestor(node)) return -1;
      const r = node.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return -1;
      const viewportWidth = Math.max(document.documentElement?.clientWidth || 0, innerWidth || 0);
      const viewportHeight = Math.max(document.documentElement?.clientHeight || 0, innerHeight || 0);
      const width = Math.max(0, Math.min(r.right, viewportWidth) - Math.max(r.left, 0));
      const height = Math.max(0, Math.min(r.bottom, viewportHeight) - Math.max(r.top, 0));
      return width > 0 && height > 0 ? width * height : -1;
    };
    const bestVisibleSurface = (nodes) => nodes.reduce((best, node) => {
      const score = visibleSurfaceScore(node);
      return score >= 0 && score >= best.score ? { node, score } : best;
    }, { node: null, score: -1 }).node;
    const chrome = document.getElementById('cts-chrome');
    const stage = document.getElementById('cts-stage');
    const currentMainSurfaces = [...document.querySelectorAll('main[data-app-shell-main-surface]')];
    const legacyMainSurfaces = [...document.querySelectorAll('main.main-surface')]
      .filter((node) => !node.hasAttribute('data-app-shell-main-surface'));
    const mainSurfaceNode = bestVisibleSurface(currentMainSurfaces) ||
      bestVisibleSurface(legacyMainSurfaces);
    const mainSurface = box(mainSurfaceNode);
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
        : hostVersion === '26.727.51351'
          ? { audited: true, profile: 'composer-current-multiline', composerLanePolicy: 'required' }
          : { audited: false, profile: 'capability-adaptive', composerLanePolicy: 'optional' };
    const { selectComposerSurfaces } = ${composerHelpers};
    const composerNodes = mainSurfaceNode ? selectComposerSurfaces(mainSurfaceNode) : [];
    const composerNode = composerNodes.find((node) => visibleSurfaceScore(node) >= 0) ?? null;
    const composer = box(composerNode);
    const composerEditor = composerNode?.querySelector('[data-cts-composer-overflow="editor"]') ?? null;
    const composerLanes = composerNode
      ? [...composerNode.querySelectorAll('[data-cts-composer-overflow="lane"]')]
      : [];
    const composerMode = composerNode?.getAttribute('data-cts-composer-mode') ?? null;
    const composerOverflow = composerNode ? {
      shellRole: composerNode.getAttribute('data-cts-composer-overflow'),
      mode: composerMode,
      shellOverflowY: getComputedStyle(composerNode).overflowY,
      laneCount: composerLanes.length,
      laneOverflowYs: composerLanes.map((node) => getComputedStyle(node).overflowY),
      lanesValid: composerLanes.every((node) => getComputedStyle(node).overflowY === 'visible'),
      lanePolicyValid: hostCompatibility.composerLanePolicy !== 'required' ||
        composerMode === 'single-line' || composerLanes.length >= 1,
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
      mainSurface,
      mainSurfaceMode: mainSurfaceNode?.hasAttribute('data-app-shell-main-surface') ? 'current' : (mainSurfaceNode ? 'legacy' : null),
      mainSurfaceCompatible: Boolean(mainSurfaceNode?.classList.contains('main-surface')),
      stageAttachedToMainSurface: !stage || stage.parentElement === mainSurfaceNode,
      composer,
      composerSurfaceMode: composerNode?.hasAttribute('data-composer-surface-variant') ? 'current' : (composerNode ? 'legacy' : null),
      composerSurfaceCompatible: Boolean(composerNode?.classList.contains('composer-surface-chrome')),
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
      Boolean(result.mainSurface?.visible) &&
      result.mainSurfaceCompatible &&
      result.stageAttachedToMainSurface &&
      Boolean(result.composer?.visible) &&
      result.composerSurfaceCompatible &&
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
