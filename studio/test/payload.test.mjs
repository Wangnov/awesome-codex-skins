import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  REMOVE_EXPRESSION,
  RUNTIME_HARDENING_CSS,
  VERIFY_REMOVED_EXPRESSION,
  buildPayload,
  verifyExpression,
} from "../src/payload.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// Same fixture bytes as Codex-App-Manager's
// crates/codex-theme-engine/tests/fixtures/golden/ (theme.json/theme.css/an
// overlay+stage chrome.html/one still asset/one motion asset) — see the
// design doc's "golden fixture" mechanism. It is duplicated byte-for-byte in
// both repos rather than shared via submodule; see studio/RUNTIME_SOURCE.json
// and scripts/sync-runtime.mjs for the (separate) vendored-runtime-source pin.
const GOLDEN_FIXTURE_DIR = path.join(here, "fixtures", "golden");

// JSON.stringify()'s escaping of `raw` as it appears once inlined into the
// payload — used instead of hand-escaping expected substrings so the test
// doesn't rely on us getting backslash-counting right by eye.
const jsonEscaped = (raw) => JSON.stringify(raw).slice(1, -1);

const evaluateVerify = ({
  mode,
  editor = null,
  lanes = [],
  hostVersion = "26.715.31925",
}) => {
  const computedStyle = (overrides = {}) => ({
    display: "block",
    visibility: "visible",
    contentVisibility: "visible",
    opacity: "1",
    overflowY: "visible",
    getPropertyValue(name) {
      if (name === "content-visibility") return this.contentVisibility;
      return "";
    },
    ...overrides,
  });
  const rect = (x, y, width, height) => ({
    x, y, width, height,
    left: x, top: y,
    right: x + width, bottom: y + height,
  });
  const commentCard = {
    getBoundingClientRect: () => rect(0, 0, 180, 80),
    computedStyle: computedStyle(),
    // The vendored selectComposerSurfaces() only picks surfaces that own an
    // editor descendant — a static PR comment card must report none.
    querySelector: () => null,
  };
  const composer = {
    isConnected: true,
    hidden: false,
    parentElement: null,
    getAttribute(name) {
      if (name === "data-cts-composer-overflow") return "shell";
      if (name === "data-cts-composer-mode") return mode;
      return null;
    },
    hasAttribute: () => false,
    classList: { contains: (name) => name === "composer-surface-chrome" },
    querySelector(selector) {
      if (selector === '[data-cts-composer-overflow="editor"]') return editor;
      // ownsEditor()'s editor-presence probe (real selectComposerSurfaces()).
      if (selector.includes("data-codex-composer")) return { closest: null };
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-cts-composer-overflow="lane"]') return lanes;
      if (selector === '[data-cts-composer-overflow="editor"]') return editor ? [editor] : [];
      return [];
    },
    getBoundingClientRect: () => rect(240, 680, 640, 96),
    computedStyle: computedStyle({ overflowY: "clip" }),
  };
  const marker = { closest: () => composer };
  const cachedComposer = {
    isConnected: true,
    hidden: false,
    parentElement: null,
    getAttribute(name) {
      if (name === "data-cts-composer-overflow") return "shell";
      if (name === "data-cts-composer-mode") return "single-line";
      return null;
    },
    hasAttribute: () => false,
    classList: { contains: (name) => name === "composer-surface-chrome" },
    querySelector(selector) {
      if (selector.includes("data-codex-composer")) return { closest: null };
      return null;
    },
    querySelectorAll: () => [],
    getBoundingClientRect: () => rect(20, 620, 900, 120),
    computedStyle: computedStyle({ overflowY: "clip" }),
  };
  const cachedMarker = { closest: () => cachedComposer };
  const hiddenComposer = {
    ...cachedComposer,
    parentElement: null,
    getBoundingClientRect: () => rect(100, 640, 800, 100),
  };
  const hiddenMarker = { closest: () => hiddenComposer };
  const sidebar = {
    getBoundingClientRect: () => rect(0, 0, 240, 800),
    computedStyle: computedStyle(),
  };
  const hiddenWrapper = {
    hidden: false,
    parentElement: null,
    hasAttribute: () => false,
    getAttribute: (name) => name === "data-app-shell-active-page" ? "false" : null,
    computedStyle: computedStyle(),
  };
  const hiddenComposerWrapper = {
    hidden: false,
    parentElement: null,
    hasAttribute: () => false,
    getAttribute: () => null,
    computedStyle: computedStyle({ visibility: "hidden" }),
  };
  const cachedMainSurface = {
    isConnected: true,
    hidden: false,
    parentElement: hiddenWrapper,
    hasAttribute: (name) => name === "data-app-shell-main-surface",
    getAttribute: () => null,
    classList: { contains: () => false },
    querySelectorAll(selector) {
      if (selector === "[data-codex-composer]") return [cachedMarker];
      return [];
    },
    getBoundingClientRect: () => rect(0, 0, 1280, 800),
    computedStyle: computedStyle(),
  };
  const mainSurface = {
    isConnected: true,
    hidden: false,
    parentElement: null,
    hasAttribute: (name) => name === "data-app-shell-main-surface",
    getAttribute: () => null,
    classList: { contains: (name) => name === "main-surface" },
    querySelectorAll(selector) {
      if (selector === "[data-codex-composer]") return [hiddenMarker, marker];
      return [];
    },
    getBoundingClientRect: () => rect(240, 0, 1040, 800),
    computedStyle: computedStyle(),
  };
  const modalIsolationWrapper = {
    hidden: false,
    parentElement: null,
    hasAttribute: (name) => name === "inert",
    getAttribute: (name) => name === "aria-hidden" ? "true" : null,
    computedStyle: computedStyle(),
  };
  const documentElement = {
    hidden: false,
    parentElement: null,
    hasAttribute: () => false,
    classList: { contains: (name) => name === "codex-theme-studio" },
    getAttribute: (name) => name === "data-cts-theme" ? "test-theme" : null,
    scrollWidth: 1280,
    clientWidth: 1280,
    scrollHeight: 800,
    clientHeight: 800,
    computedStyle: computedStyle(),
  };
  mainSurface.parentElement = modalIsolationWrapper;
  modalIsolationWrapper.parentElement = documentElement;
  composer.parentElement = mainSurface;
  hiddenComposer.parentElement = hiddenComposerWrapper;
  hiddenComposerWrapper.parentElement = mainSurface;
  hiddenWrapper.parentElement = documentElement;
  cachedComposer.parentElement = cachedMainSurface;
  const document = {
    documentElement,
    querySelectorAll(selector) {
      if (selector === "[data-codex-composer]") return [cachedMarker, hiddenMarker, marker];
      if (selector === "[data-codex-composer-root] .composer-surface-chrome") return [];
      if (selector === ".composer-surface-chrome") return [commentCard, composer];
      if (selector === "main[data-app-shell-main-surface]") return [cachedMainSurface, mainSurface];
      if (selector === "main.main-surface") return [mainSurface];
      return [];
    },
    querySelector: (selector) => {
      if (selector === "aside.app-shell-left-panel") return sidebar;
      return null;
    },
    getElementById: (id) => id === "cts-style" ? {} : null,
  };
  const window = {
    electronBridge: { getSentryInitOptions: () => ({ appVersion: hostVersion }) },
    __CODEX_THEME_STUDIO__: { version: "0.1.0" },
  };
  const getComputedStyle = (node) => node.computedStyle;

  return Function(
    "document", "window", "getComputedStyle", "innerWidth", "innerHeight",
    `return ${verifyExpression()};`,
  )(document, window, getComputedStyle, 1280, 800);
};

test("composer hardening keeps only the editor scrollable", () => {
  assert.match(RUNTIME_HARDENING_CSS, /data-cts-composer-overflow="shell"/);
  assert.match(RUNTIME_HARDENING_CSS, /overflow: clip !important/);
  assert.match(RUNTIME_HARDENING_CSS, /data-cts-composer-overflow="lane"/);
  assert.match(RUNTIME_HARDENING_CSS, /overflow: visible !important/);
  assert.match(RUNTIME_HARDENING_CSS, /data-cts-composer-overflow="editor"/);
  assert.match(RUNTIME_HARDENING_CSS, /overflow-y: auto !important/);
});

test("verification selects the audited composer policy for each Codex build", () => {
  const expression = verifyExpression();
  assert.match(expression, /26\.715\.31251/);
  assert.match(expression, /composer-three-layer/);
  assert.match(expression, /composerLanePolicy: 'required'/);
  assert.match(expression, /26\.715\.31925/);
  assert.match(expression, /composer-two-or-three-layer/);
  assert.match(expression, /composerLanePolicy: 'optional'/);
  assert.match(expression, /26\.727\.51351/);
  assert.match(expression, /composer-current-multiline/);
  assert.match(expression, /lanePolicyValid/);
  assert.match(expression, /data-codex-composer/);
  assert.match(expression, /modeValid/);
  assert.match(expression, /editorValid/);
  assert.match(expression, /mainSurfaceMode/);
  assert.match(expression, /mainSurfaceCompatible/);
  assert.match(expression, /stageAttachedToMainSurface/);
  assert.match(expression, /hiddenByAncestor/);
  assert.match(expression, /data-app-shell-active-page/);
  assert.doesNotMatch(expression, /hasAttribute\?\.\('inert'\)/);
  assert.doesNotMatch(expression, /getAttribute\?\.\('aria-hidden'\)/);
  assert.match(expression, /visibleSurfaceScore/);
  assert.match(expression, /currentMainSurfaces/);
  assert.match(expression, /legacyMainSurfaces/);
  assert.match(expression, /mainSurfaceNode \? selectComposerSurfaces\(mainSurfaceNode\) : \[\]/);
  assert.match(expression, /composerNodes\.find\(\(node\) => visibleSurfaceScore\(node\) >= 0\)/);
  assert.doesNotMatch(expression, /selectComposerSurfaces\(document\)/);
  assert.doesNotMatch(expression, /composerNodes\[0\]/);
  assert.match(expression, /composerSurfaceMode/);
  assert.match(expression, /composerSurfaceCompatible/);
  assert.doesNotMatch(expression, /laneCount >= 1/);
});

test("verification accepts a correctly hardened single-line Composer", () => {
  const result = evaluateVerify({ mode: "single-line" });
  assert.equal(result.pass, true);
  assert.equal(result.composer.width, 640, "the PR comment card must not become the verify target");
  assert.equal(result.composerOverflow.modeValid, true);
  assert.equal(result.composerOverflow.editorValid, true);
  assert.equal(result.composerOverflow.editorCount, 0);
  // The main-surface bug this port fixes: studio must find the real shell
  // main (compat-tagged with .main-surface), not an unrelated decoy <main>.
  assert.equal(result.mainSurfaceCompatible, true);
  assert.equal(result.mainSurface.x, 240, "the retained hidden main must not become the verify target");
  assert.equal(result.stageAttachedToMainSurface, true);
  assert.equal(result.composerSurfaceCompatible, true);
});

test("verification ignores cached and ancestor-hidden Composers before the active one", () => {
  const result = evaluateVerify({ mode: "single-line" });
  assert.equal(result.pass, true);
  assert.equal(result.mainSurface.x, 240);
  assert.equal(result.composer.x, 240);
  assert.equal(result.composer.width, 640);
});

test("verification keeps a visible active main under modal accessibility isolation", () => {
  const result = evaluateVerify({ mode: "single-line" });
  assert.equal(result.pass, true);
  assert.equal(result.mainSurface.visible, true);
  assert.equal(result.mainSurface.x, 240);
  assert.equal(result.composer.x, 240);
});

test("verification still requires the scrolling editor contract in multiline mode", () => {
  const editor = { computedStyle: { overflowY: "auto" } };
  const result = evaluateVerify({ mode: "scrolling", editor });
  assert.equal(result.pass, true);
  assert.equal(result.composerOverflow.editorCount, 1);
  assert.equal(result.composerOverflow.editorOverflowY, "auto");
  assert.equal(result.composerOverflow.editorValid, true);
});

test("26.715.31251 requires a lane only for scrolling Composer layouts", () => {
  const singleLine = evaluateVerify({
    hostVersion: "26.715.31251",
    mode: "single-line",
  });
  assert.equal(singleLine.pass, true);
  assert.equal(singleLine.composerOverflow.laneCount, 0);
  assert.equal(singleLine.composerOverflow.lanePolicyValid, true);

  const editor = { computedStyle: { overflowY: "auto" } };
  const lane = { computedStyle: { overflowY: "visible" } };
  const scrolling = evaluateVerify({
    hostVersion: "26.715.31251",
    mode: "scrolling",
    editor,
    lanes: [lane],
  });
  assert.equal(scrolling.pass, true);
  assert.equal(scrolling.composerOverflow.lanePolicyValid, true);

  const missingLane = evaluateVerify({
    hostVersion: "26.715.31251",
    mode: "scrolling",
    editor,
  });
  assert.equal(missingLane.pass, false);
  assert.equal(missingLane.composerOverflow.lanePolicyValid, false);
});

test("removal expressions cover Composer runtime annotations", () => {
  assert.match(REMOVE_EXPRESSION, /data-cts-composer-overflow/);
  assert.match(REMOVE_EXPRESSION, /data-cts-composer-mode/);
  assert.match(REMOVE_EXPRESSION, /data-cts-composer-action/);
  assert.match(VERIFY_REMOVED_EXPRESSION, /data-cts-composer-overflow/);
  assert.match(VERIFY_REMOVED_EXPRESSION, /data-cts-composer-mode/);
  assert.match(VERIFY_REMOVED_EXPRESSION, /data-cts-composer-action/);
});

// Golden-fixture structural parity: builds a payload from the same fixture
// shape checked into Manager's crates/codex-theme-engine/tests/fixtures/golden/
// (assets + motionAssets + an overlay-and-stage chrome.html) and asserts on
// the same normalized structural contract as
// payload.rs's golden_fixture_payload_matches_contract, so a future change to
// either engine's asset-inlining, motion-asset-substitution, chrome-layer, or
// compat-shim logic that diverges between the two shows up here — not just a
// raw stamp comparison, since payload.rs and payload.mjs fingerprint
// different inputs by design (see payload.mjs's buildPayload doc comment) and
// can legitimately produce different stamps for byte-identical input.
//
// This is deliberately a separate test from runtime-golden.test.mjs: that
// file executes the built payload against real jsdom DOM snapshots to prove
// main-surface/composer-surface *selection behavior*, using its own simpler
// hand-written fixture (no assets, no overlay layer) because DOM selection
// doesn't depend on asset/motion content. This test instead proves the
// payload *text* the DOM test never inspects: that assets got inlined, that
// motion assets landed in the dedicated JSON slot instead of the CSS
// stylesheet, and that both chrome layers and both compat-shim markers
// survived substitution.
test("golden fixture payload matches the shared structural contract", async () => {
  const built = await buildPayload(GOLDEN_FIXTURE_DIR);

  // No placeholder survives substitution.
  assert.ok(!built.payload.includes("__CTS_"), "unsubstituted placeholder");

  // Exactly the assets the fixture declares: one CSS-inlined image plus one
  // dedicated-slot motion asset (assetCount sums both, matching Rust's
  // asset_count).
  assert.equal(built.assetCount, 2, "fixture declares one still asset and one motion asset");
  assert.ok(
    built.payload.includes(jsonEscaped('--cts-asset-wall: url("data:image/png;base64,')),
    "still asset must ride the CSS custom property as a data URL",
  );
  assert.ok(
    built.payload.includes('"data:video/mp4;base64,'),
    "motion asset must be present as a data URL in the dedicated motion slot",
  );
  assert.ok(
    !built.payload.includes("--cts-asset-intro-video"),
    "motion assets must never become a CSS custom property",
  );

  // Both chrome layers from the fixture's overlay+stage markup.
  assert.ok(built.payload.includes(jsonEscaped('data-cts-layer="overlay"')));
  assert.ok(built.payload.includes(jsonEscaped('data-cts-layer="stage"')));

  // Main-surface compatibility shim: current and legacy candidate lists,
  // visibility scoring, and the compat marker all survive substitution. The
  // executed selection and navigation behavior is exercised against a real
  // DOM by runtime-golden.test.mjs.
  assert.ok(built.payload.includes('document.querySelectorAll("main[data-app-shell-main-surface]")'));
  assert.ok(built.payload.includes("document.querySelectorAll(`main.${LEGACY_SHELL_MAIN_CLASS}`)"));
  assert.ok(built.payload.includes("visibleSurfaceScore"));
  assert.ok(built.payload.includes('"data-cts-main-surface-compat"'));

  // Composer-surface compatibility shim: both the current CSS-module
  // selector and the legacy-class compat marker are present.
  assert.ok(built.payload.includes('"[data-composer-surface-variant][data-composer-layout]"'));
  assert.ok(built.payload.includes('"composer-surface-chrome"'));
  assert.ok(built.payload.includes("reconcileComposerSurfaces(document)"));
  assert.ok(built.payload.includes("clearComposerSurfaceCompat(document)"));

  // Composer overflow contract markers the injected runtime relies on for
  // classification, and the hardening CSS appended after theme CSS.
  assert.ok(built.payload.includes("annotateComposerOverflow.invalidate()"));
  assert.ok(built.payload.includes(jsonEscaped('data-cts-composer-overflow="shell"')));
  assert.ok(built.payload.includes(jsonEscaped("overflow: clip !important")));

  // Stamp shape: studio version, fixture id, and a non-empty hash segment.
  // Not compared against Manager's stamp for byte-identical input — see the
  // doc comment above.
  assert.ok(built.stamp.startsWith("0.1.0:golden-fixture:"));
  const hashSegment = built.stamp.split(":").at(-1);
  assert.ok(hashSegment && hashSegment.length > 0, "stamp must carry a non-empty fingerprint segment");
});
