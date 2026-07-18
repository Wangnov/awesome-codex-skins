import assert from "node:assert/strict";
import test from "node:test";

import {
  REMOVE_EXPRESSION,
  RUNTIME_HARDENING_CSS,
  VERIFY_REMOVED_EXPRESSION,
  verifyExpression,
} from "../src/payload.mjs";

const evaluateVerify = ({ mode, editor = null, lanes = [] }) => {
  const commentCard = {
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 180, height: 80 }),
    computedStyle: { display: "block", visibility: "visible", overflowY: "visible" },
  };
  const composer = {
    getAttribute(name) {
      if (name === "data-cts-composer-overflow") return "shell";
      if (name === "data-cts-composer-mode") return mode;
      return null;
    },
    querySelector(selector) {
      return selector === '[data-cts-composer-overflow="editor"]' ? editor : null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-cts-composer-overflow="lane"]') return lanes;
      if (selector === '[data-cts-composer-overflow="editor"]') return editor ? [editor] : [];
      return [];
    },
    getBoundingClientRect: () => ({ x: 240, y: 680, width: 640, height: 96 }),
    computedStyle: { display: "block", visibility: "visible", overflowY: "clip" },
  };
  const marker = { closest: () => composer };
  const sidebar = {
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 240, height: 800 }),
    computedStyle: { display: "block", visibility: "visible", overflowY: "visible" },
  };
  const documentElement = {
    classList: { contains: (name) => name === "codex-theme-studio" },
    getAttribute: (name) => name === "data-cts-theme" ? "test-theme" : null,
    scrollWidth: 1280,
    clientWidth: 1280,
    scrollHeight: 800,
    clientHeight: 800,
  };
  const document = {
    documentElement,
    querySelectorAll(selector) {
      if (selector === "[data-codex-composer]") return [marker];
      if (selector === "[data-codex-composer-root] .composer-surface-chrome") return [];
      if (selector === ".composer-surface-chrome") return [commentCard, composer];
      return [];
    },
    querySelector: (selector) => selector === "aside.app-shell-left-panel" ? sidebar : null,
    getElementById: (id) => id === "cts-style" ? {} : null,
  };
  const window = {
    electronBridge: { getSentryInitOptions: () => ({ appVersion: "26.715.31925" }) },
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
  assert.match(expression, /lanePolicyValid/);
  assert.match(expression, /data-codex-composer/);
  assert.match(expression, /modeValid/);
  assert.match(expression, /editorValid/);
  assert.doesNotMatch(expression, /laneCount >= 1/);
});

test("verification accepts a correctly hardened single-line Composer", () => {
  const result = evaluateVerify({ mode: "single-line" });
  assert.equal(result.pass, true);
  assert.equal(result.composer.width, 640, "the PR comment card must not become the verify target");
  assert.equal(result.composerOverflow.modeValid, true);
  assert.equal(result.composerOverflow.editorValid, true);
  assert.equal(result.composerOverflow.editorCount, 0);
});

test("verification still requires the scrolling editor contract in multiline mode", () => {
  const editor = { computedStyle: { overflowY: "auto" } };
  const result = evaluateVerify({ mode: "scrolling", editor });
  assert.equal(result.pass, true);
  assert.equal(result.composerOverflow.editorCount, 1);
  assert.equal(result.composerOverflow.editorOverflowY, "auto");
  assert.equal(result.composerOverflow.editorValid, true);
});

test("removal expressions cover Composer runtime annotations", () => {
  assert.match(REMOVE_EXPRESSION, /data-cts-composer-overflow/);
  assert.match(REMOVE_EXPRESSION, /data-cts-composer-mode/);
  assert.match(VERIFY_REMOVED_EXPRESSION, /data-cts-composer-overflow/);
  assert.match(VERIFY_REMOVED_EXPRESSION, /data-cts-composer-mode/);
});
