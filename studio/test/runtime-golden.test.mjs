// DOM-behavior test: builds a real payload through buildPayload() (the exact
// code path `pack`/`verify`/`preview-shot` use) and executes it against real
// DOM snapshots of the four host shapes the vendored runtime must support —
// legacy and 26.727+ main-surface markup, each with a legacy and a CSS-module
// (26.730.61309+) Composer surface, plus a decoy <main> ahead of the real
// shell main (the exact upstream bug this port fixes: studio used to fall
// through to that decoy).
//
// This file's own hand-written fixture (writeFixtureTheme(), below) is
// deliberately NOT the shared golden fixture used across repos — it carries
// no `assets`/`motionAssets` and its chrome.html has only a `stage` layer, so
// it stays minimal and fast for the thing this file actually exercises: main-
// surface/composer-surface *selection behavior* against a real DOM (Node has
// no DOM, so this can't run in Rust). It never touches asset inlining or
// motion-asset substitution — for that, see the separate
// "golden fixture payload matches the shared structural contract" test in
// payload.test.mjs, which builds from studio/test/fixtures/golden/, the same
// fixture bytes as Manager's crates/codex-theme-engine/tests/fixtures/golden/,
// and asserts on the same normalized structural contract as payload.rs's
// golden_fixture_payload_matches_contract test.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { JSDOM } from "jsdom";

import { buildPayload, verifyExpression } from "../src/payload.mjs";

async function writeFixtureTheme() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cts-golden-"));
  const manifest = {
    schemaVersion: 2,
    id: "golden-fixture",
    name: "Golden fixture",
    colors: { accent: "#abc" },
    strings: {},
    chrome: "chrome.html",
  };
  await fs.writeFile(path.join(dir, "theme.json"), JSON.stringify(manifest));
  await fs.writeFile(path.join(dir, "theme.css"), "html.codex-theme-studio body {}\n");
  // A non-empty stage layer so the runtime actually mounts `#cts-stage`.
  await fs.writeFile(
    path.join(dir, "chrome.html"),
    '<div data-cts-layer="stage"><span id="cts-scenery"></span></div>',
  );
  return dir;
}

const EDITOR = '<div class="ProseMirror" data-codex-composer contenteditable="true"></div>';
const COMPOSER_SNAPSHOTS = {
  legacy: `<div class="composer-surface-chrome">${EDITOR}</div>`,
  cssModule: `<div data-composer-surface-variant="default" data-composer-layout="single-line">${EDITOR}</div>`,
};

const SHELL_SNAPSHOTS = {
  legacy: (composer) => `
    <aside class="app-shell-left-panel"></aside>
    <main class="main-surface">${composer}</main>
  `,
  current: (composer) => `
    <!-- Codex 26.727+: an unrelated full-window <main> the shell mounts
         BEFORE the real one. This is exactly what generic
         document.querySelector("main") used to latch onto. -->
    <main class="unrelated-full-window-main"></main>
    <aside class="app-shell-left-panel"></aside>
    <main data-app-shell-main-surface>${composer}</main>
  `,
};

function domFor(shellHtml) {
  const dom = new JSDOM(
    `<!doctype html><html><head></head><body>${shellHtml}</body></html>`,
    { pretendToBeVisual: true, runScripts: "outside-only" },
  );
  dom.window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  return dom;
}

for (const [mainLabel, mainSnapshot] of Object.entries(SHELL_SNAPSHOTS)) {
  for (const [composerLabel, composerSnapshot] of Object.entries(COMPOSER_SNAPSHOTS)) {
    test(`runtime attaches to the real shell main and skins the composer (main=${mainLabel}, composer=${composerLabel})`, async (t) => {
      const dir = await writeFixtureTheme();
      t.after(() => fs.rm(dir, { recursive: true, force: true }));
      const { payload } = await buildPayload(dir);

      const dom = domFor(mainSnapshot(composerSnapshot));
      t.after(() => dom.window.close());
      dom.window.innerWidth = 1280;
      dom.window.innerHeight = 800;

      dom.window.eval(payload);
      const document = dom.window.document;

      const realMain = mainLabel === "legacy"
        ? document.querySelector("main.main-surface")
        : document.querySelector("main[data-app-shell-main-surface]");
      const decoyMain = [...document.querySelectorAll("main")].find((m) => m !== realMain) ?? null;

      const stage = document.getElementById("cts-stage");
      assert.ok(stage, "stage element must be created");
      assert.equal(stage.parentElement, realMain, "stage must attach to the real shell main, not a decoy");
      if (decoyMain) {
        assert.equal(
          decoyMain.querySelector("#cts-stage"),
          null,
          "the unrelated decoy <main> must never receive the stage — this is the bug studio shipped with",
        );
      }
      // Legacy compat shim: the runtime tags the real main with the legacy
      // `.main-surface` class too, so old skin CSS keeps matching either way.
      assert.equal(realMain.classList.contains("main-surface"), true);

      const composerHost = document.querySelector(".composer-surface-chrome");
      assert.ok(composerHost, "composer surface must be tagged (legacy class or CSS-module alias)");
      assert.equal(composerHost.getAttribute("data-cts-composer-overflow"), "shell");
      // jsdom has no layout engine, so every box measures 0x0 and the
      // annotator classifies this minimal fixture as single-line (no
      // scrollable editor lane needed) rather than scrolling — the
      // composer-overflow.test.mjs unit tests already cover both modes'
      // editor-annotation contract with a mocked layout. What matters here
      // is that annotation ran at all (a mode got assigned) and the
      // composer surface itself — legacy class or CSS-module alias alike —
      // is what received it.
      assert.ok(
        ["single-line", "scrolling"].includes(composerHost.getAttribute("data-cts-composer-mode")),
        "composer must be classified into a known overflow mode",
      );

      const result = dom.window.eval(verifyExpression());
      assert.equal(result.installed, true);
      assert.equal(result.mainSurfaceMode, mainLabel === "current" ? "current" : "legacy");
      assert.equal(result.mainSurfaceCompatible, true);
      assert.equal(result.stageAttachedToMainSurface, true);
      assert.equal(result.composerSurfaceMode, composerLabel === "cssModule" ? "current" : "legacy");
      assert.equal(result.composerSurfaceCompatible, true);

      dom.window.__CODEX_THEME_STUDIO__.cleanup();
      assert.equal(document.getElementById("cts-stage"), null, "cleanup must remove the stage");
      assert.equal(realMain.classList.contains("main-surface"), mainLabel === "legacy",
        "cleanup must release the compat shim it added, but never a class the host owns");
    });
  }
}
