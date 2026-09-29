import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

import {
  collapseAndVerifySidebarPrivacy,
  SIDEBAR_PRIVACY_SECTION_LABELS,
  PRIVATE_ROW_SELECTORS,
  SIDEBAR_SELECTOR,
  collapseSidebarPrivacyExpression,
} from "../src/sidebar-privacy.mjs";

// The unit tests below call the exact function the CDP expression embeds
// (see the last test), always with the same canonical labels/selectors it
// bakes in — so a passing test here means the shipped expression behaves
// the same way against an equivalent DOM.
const defaultOptions = (overrides) => ({
  settleMs: 0,
  attempts: 3,
  labels: SIDEBAR_PRIVACY_SECTION_LABELS,
  rowSelector: PRIVATE_ROW_SELECTORS.join(","),
  sidebarSelector: SIDEBAR_SELECTOR,
  ...overrides,
});

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "fixtures", "sidebar");

// jsdom does not run layout, so getBoundingClientRect is always a zero rect.
// This models just enough of it for the visibility check under test: any
// element (or ancestor) with inline `display:none` has zero size, everything
// else gets a plausible on-screen box.
function withFakeLayout(window) {
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    for (let node = this; node; node = node.parentElement) {
      if (node.style && node.style.display === "none") {
        return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} };
      }
    }
    return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON() {} };
  };
}

// Simulates what the real Codex renderer would do on a toggle click: flip
// `aria-expanded` and hide/show the controlled list. A `data-stuck="true"`
// toggle deliberately does nothing, modeling a control our selector found
// but that doesn't actually work (or a click that silently no-ops).
function wireToggles(document) {
  for (const toggle of document.querySelectorAll("[aria-expanded][data-controls]")) {
    if (toggle.getAttribute("data-stuck") === "true") continue;
    toggle.addEventListener("click", () => {
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", expanded ? "false" : "true");
      const controlled = document.getElementById(toggle.getAttribute("data-controls"));
      if (controlled) controlled.style.display = expanded ? "none" : "";
    });
  }
}

async function loadFixture(name) {
  const html = await fs.readFile(path.join(FIXTURES, `${name}.html`), "utf8");
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { pretendToBeVisual: true });
  withFakeLayout(dom.window);
  wireToggles(dom.window.document);
  return dom;
}

test("collapses all three sections and reports ok when nothing leaks afterward", async () => {
  const dom = await loadFixture("full-expanded");
  const result = await collapseAndVerifySidebarPrivacy(dom.window.document, defaultOptions());
  assert.equal(result.ok, true);
  assert.equal(result.sidebarFound, true);
  assert.equal(result.leaks.length, 0);
  assert.deepEqual(
    result.sections.map((s) => s.label),
    [...SIDEBAR_PRIVACY_SECTION_LABELS],
  );
  for (const section of result.sections) {
    assert.equal(section.found, true, section.label);
    assert.equal(section.toggleFound, true, section.label);
    assert.equal(section.collapsed, true, section.label);
  }
  // The click handlers actually ran: the app-driven state now matches what
  // a manually-collapsed sidebar would look like, not just a synthetic hide.
  for (const id of ["pinned-list", "projects-list", "tasks-list"]) {
    assert.equal(dom.window.document.getElementById(id).style.display, "none", id);
  }
});

test("sections already collapsed on load pass without needing a click", async () => {
  const dom = await loadFixture("already-collapsed");
  const result = await collapseAndVerifySidebarPrivacy(dom.window.document, defaultOptions());
  assert.equal(result.ok, true);
  assert.equal(result.leaks.length, 0);
});

test("an account with no pinned/project/task content passes (nothing to leak)", async () => {
  const dom = await loadFixture("empty-account");
  const result = await collapseAndVerifySidebarPrivacy(dom.window.document, defaultOptions());
  assert.equal(result.ok, true);
  assert.equal(result.sidebarFound, true);
  for (const section of result.sections) assert.equal(section.found, false, section.label);
});

test("a section header with no discoverable toggle fails closed", async () => {
  const dom = await loadFixture("no-toggle");
  const result = await collapseAndVerifySidebarPrivacy(dom.window.document, defaultOptions());
  assert.equal(result.ok, false);
  assert.match(result.reason, /no discoverable toggle/);
  const pinned = result.sections.find((s) => s.label === "Pinned");
  assert.equal(pinned.found, true);
  assert.equal(pinned.toggleFound, false);
});

test("a toggle that never reports collapsed fails closed instead of timing out silently", async () => {
  const dom = await loadFixture("stuck-toggle");
  const result = await collapseAndVerifySidebarPrivacy(dom.window.document, defaultOptions({ attempts: 2 }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /did not report collapsed/);
});

test("a missing sidebar container fails closed rather than reporting nothing to check", async () => {
  const dom = await loadFixture("no-sidebar");
  const result = await collapseAndVerifySidebarPrivacy(dom.window.document, defaultOptions());
  assert.equal(result.ok, false);
  assert.equal(result.sidebarFound, false);
  assert.match(result.reason, /sidebar container not found/);
});

test("a relabeled section with no matching header still fails via the broad row scan", async () => {
  // None of the three known labels match ("Favorites" instead of
  // Pinned/Projects/Tasks) — this is the independent safety net: a private
  // row is still caught even when the label-based collapse pass finds
  // nothing to click.
  const dom = await loadFixture("relabeled-leak");
  const result = await collapseAndVerifySidebarPrivacy(dom.window.document, defaultOptions());
  assert.equal(result.ok, false);
  assert.equal(result.leaks.length, 1);
  assert.match(result.reason, /still visible/);
  for (const section of result.sections) assert.equal(section.found, false, section.label);
});

test("the CDP-evaluated expression is a syntactically valid IIFE calling document directly", () => {
  const source = collapseSidebarPrivacyExpression({ settleMs: 10, attempts: 2 });
  assert.match(source, /^\(async function collapseAndVerifySidebarPrivacy\(/);
  assert.match(source, /\(document, \{.*\}\)$/s);
  // The canonical labels/selectors are baked in as JSON, not re-derived —
  // one source of truth (the exported consts), not a second copy.
  for (const label of SIDEBAR_PRIVACY_SECTION_LABELS) assert.match(source, new RegExp(`"${label}"`));
  assert.match(source, /aside\.app-shell-left-panel/);
  // Must not reference anything outside the expression itself — it runs
  // through Runtime.evaluate in the renderer, with no Node.js closure.
  assert.doesNotMatch(source, /require\(|import /);
  // Syntax check only (no `document` global here, so it is not invoked).
  assert.doesNotThrow(() => new Function(`return ${source};`));
});
