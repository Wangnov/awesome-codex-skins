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

function setRect(node, { x, y, width, height }) {
  node.getBoundingClientRect = () => ({
    x, y, width, height,
    left: x, top: y,
    right: x + width, bottom: y + height,
    toJSON() { return this; },
  });
}

function setFixtureGeometry(dom, realMain) {
  const document = dom.window.document;
  setRect(realMain, { x: 240, y: 0, width: 1040, height: 800 });
  setRect(document.querySelector("aside.app-shell-left-panel"), {
    x: 0, y: 0, width: 240, height: 800,
  });
  const composer = realMain.querySelector(
    ".composer-surface-chrome, [data-composer-surface-variant][data-composer-layout]",
  );
  setRect(composer, { x: 400, y: 640, width: 640, height: 96 });
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

      const document = dom.window.document;
      const realMain = mainLabel === "legacy"
        ? document.querySelector("main.main-surface")
        : document.querySelector("main[data-app-shell-main-surface]");
      setFixtureGeometry(dom, realMain);

      dom.window.eval(payload);
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
      assert.equal(result.mainSurface.visible, true);
      assert.equal(result.composerSurfaceMode, composerLabel === "cssModule" ? "current" : "legacy");
      assert.equal(result.composerSurfaceCompatible, true);

      dom.window.__CODEX_THEME_STUDIO__.cleanup();
      assert.equal(document.getElementById("cts-stage"), null, "cleanup must remove the stage");
      assert.equal(realMain.classList.contains("main-surface"), mainLabel === "legacy",
        "cleanup must release the compat shim it added, but never a class the host owns");
    });
  }
}

test("runtime ignores a retained hidden main and reattaches when navigation makes it active", async (t) => {
  const dir = await writeFixtureTheme();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { payload } = await buildPayload(dir);
  const dom = domFor(`
    <aside class="app-shell-left-panel"></aside>
    <div id="cached-wrapper" data-app-shell-active-page="false">
      <main id="cached-main" data-app-shell-main-surface>
        <div id="cached-home" role="main"><div data-testid="home-icon"></div></div>
        ${COMPOSER_SNAPSHOTS.legacy}
      </main>
    </div>
    <div id="live-wrapper">
      <main id="live-main" data-app-shell-main-surface>
        <div id="live-chat" role="main">thread</div>
        ${COMPOSER_SNAPSHOTS.legacy}
      </main>
    </div>
  `);
  t.after(() => {
    dom.window.__CODEX_THEME_STUDIO__?.cleanup();
    dom.window.close();
  });
  dom.window.innerWidth = 1280;
  dom.window.innerHeight = 800;

  const document = dom.window.document;
  const cachedMain = document.getElementById("cached-main");
  const liveMain = document.getElementById("live-main");
  setRect(cachedMain, { x: 240, y: 0, width: 1040, height: 800 });
  setRect(liveMain, { x: 300, y: 0, width: 980, height: 800 });
  setRect(document.getElementById("cached-home"), { x: 240, y: 40, width: 1040, height: 600 });
  setRect(document.getElementById("live-chat"), { x: 300, y: 40, width: 980, height: 600 });
  setRect(document.querySelector("aside.app-shell-left-panel"), {
    x: 0, y: 0, width: 240, height: 800,
  });
  const cachedComposer = cachedMain.querySelector(".composer-surface-chrome");
  const liveComposer = liveMain.querySelector(".composer-surface-chrome");
  setRect(cachedComposer, { x: 260, y: 640, width: 620, height: 96 });
  setRect(liveComposer, { x: 420, y: 640, width: 640, height: 96 });

  dom.window.eval(payload);
  assert.equal(liveMain.getAttribute("data-cts-main-surface-compat"), "true");
  assert.equal(cachedMain.hasAttribute("data-cts-main-surface-compat"), false);
  assert.equal(document.getElementById("cts-stage").parentElement, liveMain);
  assert.equal(document.querySelector(".cts-home"), null, "a hidden cached home must not mark the live chat");
  let verification = dom.window.eval(verifyExpression());
  assert.equal(verification.mainSurface.x, 300);
  assert.equal(verification.composer.x, 420, "verify must use the Composer inside the live main");

  document.getElementById("cached-wrapper").removeAttribute("data-app-shell-active-page");
  document.getElementById("live-wrapper").setAttribute("data-app-shell-active-page", "false");
  dom.window.__CODEX_THEME_STUDIO__.ensure();

  assert.equal(liveMain.hasAttribute("data-cts-main-surface-compat"), false);
  assert.equal(cachedMain.getAttribute("data-cts-main-surface-compat"), "true");
  assert.equal(document.getElementById("cached-home").classList.contains("cts-home"), true);
  assert.equal(document.getElementById("cts-stage").parentElement, cachedMain);
  verification = dom.window.eval(verifyExpression());
  assert.equal(verification.mainSurface.x, 240);
  assert.equal(verification.composer.x, 260, "verify must follow the reactivated cached main");

  dom.window.__CODEX_THEME_STUDIO__.cleanup();
  assert.equal(document.querySelector("[data-cts-main-surface-compat]"), null);
});

test("modal accessibility isolation preserves the visible main, stage, and verification target", async (t) => {
  const dir = await writeFixtureTheme();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { payload } = await buildPayload(dir);
  const dom = domFor(`
    <aside class="app-shell-left-panel"></aside>
    <div id="page-wrapper" data-app-shell-active-page="true">
      <main id="main" data-app-shell-main-surface>
        <div role="main">thread</div>
        ${COMPOSER_SNAPSHOTS.legacy}
      </main>
    </div>
  `);
  t.after(() => {
    dom.window.__CODEX_THEME_STUDIO__?.cleanup();
    dom.window.close();
  });
  dom.window.innerWidth = 1280;
  dom.window.innerHeight = 800;

  const document = dom.window.document;
  const wrapper = document.getElementById("page-wrapper");
  const main = document.getElementById("main");
  const composer = main.querySelector(".composer-surface-chrome");
  setRect(main, { x: 280, y: 40, width: 920, height: 700 });
  setRect(composer, { x: 420, y: 640, width: 640, height: 96 });
  setRect(document.querySelector("aside.app-shell-left-panel"), {
    x: 0, y: 0, width: 240, height: 800,
  });

  dom.window.eval(payload);
  assert.equal(document.getElementById("cts-stage").parentElement, main);

  wrapper.setAttribute("inert", "");
  wrapper.setAttribute("aria-hidden", "true");
  await new Promise((resolve) => dom.window.setTimeout(resolve, 260));

  assert.equal(document.getElementById("cts-stage").parentElement, main);
  assert.equal(main.getAttribute("data-cts-main-surface-compat"), "true");
  const verification = dom.window.eval(verifyExpression());
  // jsdom does not compute `overflow: clip`, so the aggregate pass bit remains
  // outside this DOM fixture's scope. Assert the modal-sensitive structural
  // targets directly.
  assert.equal(verification.installed, true);
  assert.equal(verification.mainSurfaceCompatible, true);
  assert.equal(verification.stageAttachedToMainSurface, true);
  assert.equal(verification.composerSurfaceCompatible, true);
  assert.equal(verification.mainSurface.x, 280);
  assert.equal(verification.composer.x, 420);
});

test("runtime and verification prefer the later current main when visible areas tie", async (t) => {
  const dir = await writeFixtureTheme();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { payload } = await buildPayload(dir);
  const dom = domFor(`
    <aside class="app-shell-left-panel"></aside>
    <main id="first" data-app-shell-main-surface>${COMPOSER_SNAPSHOTS.legacy}</main>
    <main id="last" data-app-shell-main-surface>${COMPOSER_SNAPSHOTS.legacy}</main>
  `);
  t.after(() => {
    dom.window.__CODEX_THEME_STUDIO__?.cleanup();
    dom.window.close();
  });
  dom.window.innerWidth = 1280;
  dom.window.innerHeight = 800;
  const document = dom.window.document;
  const first = document.getElementById("first");
  const last = document.getElementById("last");
  setRect(first, { x: 240, y: 0, width: 1000, height: 700 });
  setRect(last, { x: 280, y: 0, width: 1000, height: 700 });
  setRect(document.querySelector("aside"), { x: 0, y: 0, width: 240, height: 800 });
  setRect(first.querySelector(".composer-surface-chrome"), {
    x: 360, y: 640, width: 600, height: 96,
  });
  setRect(last.querySelector(".composer-surface-chrome"), {
    x: 500, y: 640, width: 620, height: 96,
  });

  dom.window.eval(payload);
  assert.equal(document.getElementById("cts-stage").parentElement, last);
  assert.equal(first.hasAttribute("data-cts-main-surface-compat"), false);
  assert.equal(last.getAttribute("data-cts-main-surface-compat"), "true");
  const verification = dom.window.eval(verifyExpression());
  assert.equal(verification.mainSurface.x, 280);
  assert.equal(verification.composer.x, 500);
});
