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
    // Models a clip-style collapse: height:0 zeroes only the element's OWN box,
    // its children keep theirs (exactly why an ancestor-aware check is needed).
    if (this.style && this.style.height === "0px") {
      return { width: 100, height: 0, top: 0, left: 0, right: 100, bottom: 0, x: 0, y: 0, toJSON() {} };
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
    const flip = () => {
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", expanded ? "false" : "true");
      const controlled = document.getElementById(toggle.getAttribute("data-controls"));
      if (!controlled) return;
      if (toggle.getAttribute("data-collapse") === "clip") {
        controlled.style.height = expanded ? "0px" : "";
        controlled.style.overflow = expanded ? "hidden" : "";
      } else {
        controlled.style.display = expanded ? "none" : "";
      }
    };
    toggle.addEventListener("click", flip);
    // data-double models a handler bound to pointerdown as well as click.
    if (toggle.getAttribute("data-double") === "true") toggle.addEventListener("pointerdown", flip);
  }
  // Popup triggers must never be clicked by the sweep.
  popupClicks.length = 0;
  navClicks.length = 0;
  for (const nav of document.querySelectorAll("[data-nav]")) {
    nav.addEventListener("click", () => navClicks.push(nav.id));
  }
  for (const popup of document.querySelectorAll("[aria-haspopup]")) {
    popup.addEventListener("click", () => popupClicks.push(popup.id));
  }
}
const popupClicks = [];
const navClicks = [];

async function loadFixture(name) {
  const html = await fs.readFile(path.join(FIXTURES, `${name}.html`), "utf8");
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { pretendToBeVisual: true, runScripts: "outside-only" });
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

test("a sidebar with no recognizable collapsible section fails closed instead of assuming it is empty", async () => {
  const dom = await loadFixture("empty-account");
  const result = await collapseAndVerifySidebarPrivacy(dom.window.document, defaultOptions());
  assert.equal(result.ok, false);
  assert.equal(result.sidebarFound, true);
  assert.equal(result.recognizedSections, 0);
  assert.match(result.reason, /no collapsible sidebar section was recognized/);
});

test("an account whose sections exist but hold no rows passes", async () => {
  const dom = await loadFixture("empty-sections");
  const result = await collapseAndVerifySidebarPrivacy(dom.window.document, defaultOptions());
  assert.equal(result.ok, true);
  assert.equal(result.leaks.length, 0);
  assert.ok(result.recognizedSections >= 2);
});

test("a localized sidebar (labels match nothing) is still collapsed by the aria-expanded sweep", async () => {
  const dom = await loadFixture("localized-aria");
  const result = await collapseAndVerifySidebarPrivacy(dom.window.document, defaultOptions());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.sections.filter((s) => s.source === "generic").map((s) => s.label).sort(), ["置顶", "项目"]);
  assert.equal(dom.window.document.getElementById("pinned-list").style.display, "none");
});

test("a localized sidebar with no toggle convention and plain-div rows fails closed (used to pass silently)", async () => {
  const dom = await loadFixture("localized-no-aria");
  const result = await collapseAndVerifySidebarPrivacy(dom.window.document, defaultOptions());
  assert.equal(result.ok, false);
  assert.equal(result.recognizedSections, 0);
  assert.match(result.reason, /no collapsible sidebar section was recognized/);
  // The remaining visible text is surfaced so a human can see what is left.
  assert.ok(result.visibleText.includes("季度预算谈判笔记"));
});

test("waits for a late-mounting sidebar instead of judging a half-built one", async () => {
  const dom = await loadFixture("empty-account");
  const document = dom.window.document;
  setTimeout(() => {
    const section = document.createElement("section");
    section.innerHTML =
      '<button aria-expanded="true" data-controls="late-list">Pinned</button>' +
      '<ul id="late-list"><li>Late thread</li></ul>';
    document.querySelector("aside").appendChild(section);
    wireToggles(document);
  }, 40);
  const result = await collapseAndVerifySidebarPrivacy(
    document,
    defaultOptions({ settleMs: 10, mountAttempts: 100 }),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(document.getElementById("late-list").style.display, "none");
});

test("a collapse implemented by clipping (height:0 + overflow:hidden) is not reported as a leak", async () => {
  const dom = await loadFixture("clip-collapse");
  const result = await collapseAndVerifySidebarPrivacy(dom.window.document, defaultOptions());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.leaks.length, 0);
  assert.equal(dom.window.document.getElementById("pinned-wrap").style.height, "0px");
  assert.ok(!result.visibleText.includes("Q3 budget negotiation notes"));
});

test("a handler bound to both pointerdown and click ends collapsed, not toggled back open", async () => {
  const dom = await loadFixture("double-handler");
  const result = await collapseAndVerifySidebarPrivacy(dom.window.document, defaultOptions());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(dom.window.document.querySelector("[data-double]").getAttribute("aria-expanded"), "false");
});

test("popup triggers (aria-haspopup) are never clicked by the generic sweep", async () => {
  const dom = await loadFixture("popup-toggle");
  const result = await collapseAndVerifySidebarPrivacy(dom.window.document, defaultOptions());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(popupClicks, []);
  assert.equal(dom.window.document.getElementById("account-menu").getAttribute("aria-expanded"), "true");
  assert.ok(!result.sections.some((s) => s.label === "Account"));
});

test("a popup trigger whose label matches a named section is never clicked and fails closed", async () => {
  const dom = await loadFixture("named-popup-toggle");
  const result = await collapseAndVerifySidebarPrivacy(dom.window.document, defaultOptions());
  assert.deepEqual(popupClicks, []);
  assert.equal(dom.window.document.getElementById("projects-popup").getAttribute("aria-expanded"), "true");
  assert.equal(result.ok, false);
  assert.match(result.reason, /no discoverable toggle/);
  const projects = result.sections.find((s) => s.label === "Projects");
  assert.equal(projects.toggleFound, false);
  assert.equal(projects.why, "popup-trigger");
});

test("a plain button without aria-expanded that is labeled like a section is never clicked (it could navigate)", async () => {
  const dom = await loadFixture("named-nav-button");
  const result = await collapseAndVerifySidebarPrivacy(dom.window.document, defaultOptions());
  assert.deepEqual(navClicks, []);
  assert.equal(result.ok, false);
  const tasks = result.sections.find((s) => s.label === "Tasks");
  assert.equal(tasks.toggleFound, false);
  assert.equal(tasks.why, "no-aria-expanded");
});

test("scanOnly re-verifies without clicking, and catches a section that re-expanded after the collapse", async () => {
  const dom = await loadFixture("full-expanded");
  const document = dom.window.document;
  // Nothing has been collapsed yet: scanOnly must refuse and must not click.
  const before = await collapseAndVerifySidebarPrivacy(document, defaultOptions({ scanOnly: true }));
  assert.equal(before.ok, false);
  assert.match(before.reason, /expanded again/);
  assert.equal(document.querySelector('[data-controls="pinned-list"]').getAttribute("aria-expanded"), "true");

  const collapsed = await collapseAndVerifySidebarPrivacy(document, defaultOptions());
  assert.equal(collapsed.ok, true);
  const still = await collapseAndVerifySidebarPrivacy(document, defaultOptions({ scanOnly: true }));
  assert.equal(still.ok, true, JSON.stringify(still));

  // Simulate a post-resize re-render that re-mounts a section expanded.
  const toggle = document.querySelector('[data-controls="tasks-list"]');
  toggle.setAttribute("aria-expanded", "true");
  document.getElementById("tasks-list").style.display = "";
  const after = await collapseAndVerifySidebarPrivacy(document, defaultOptions({ scanOnly: true }));
  assert.equal(after.ok, false);
  assert.ok(after.leaks.length > 0);
  assert.equal(toggle.getAttribute("aria-expanded"), "true", "scanOnly must not click");
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

test("a relabeled section with no matching header and no toggle still fails via the broad row scan", async () => {
  // None of the three known labels match ("Favorites" instead of
  // Pinned/Projects/Tasks), and this fixture has no aria-expanded toggle at
  // all (unlike extra-collapsible-section.html below) — nothing for either
  // the named pass or the generic sweep to click. This is the case where
  // failing closed is the actually-correct outcome: a private row is still
  // caught even when there is no real-UI action left to try.
  const dom = await loadFixture("relabeled-leak");
  const result = await collapseAndVerifySidebarPrivacy(dom.window.document, defaultOptions());
  assert.equal(result.ok, false);
  assert.equal(result.leaks.length, 1);
  assert.match(result.reason, /still visible/);
  for (const section of result.sections) assert.equal(section.found, false, section.label);
});

test("an unnamed but collapsible section is found and collapsed by the generic sweep", async () => {
  // "Recent" isn't one of the three known labels, but it uses the same
  // aria-expanded toggle convention as Pinned/Projects/Tasks — the generic
  // sweep (not the named, label-based pass) is what finds and collapses it.
  const dom = await loadFixture("extra-collapsible-section");
  const result = await collapseAndVerifySidebarPrivacy(dom.window.document, defaultOptions());
  assert.equal(result.ok, true);
  assert.equal(result.leaks.length, 0);
  const recent = result.sections.find((s) => s.label === "Recent");
  assert.ok(recent, "expected a 'Recent' entry from the generic sweep");
  assert.equal(recent.source, "generic");
  assert.equal(recent.toggleFound, true);
  assert.equal(recent.collapsed, true);
  assert.equal(dom.window.document.getElementById("recent-list").style.display, "none");
  // The three named sections are still handled by the named pass, not
  // rediscovered by the generic sweep.
  for (const label of SIDEBAR_PRIVACY_SECTION_LABELS) {
    const section = result.sections.find((s) => s.label === label);
    assert.equal(section.source, "named", label);
  }
});

test("a generic-sweep toggle that never reports collapsed fails closed instead of hanging", async () => {
  const dom = await loadFixture("stuck-generic-toggle");
  const result = await collapseAndVerifySidebarPrivacy(dom.window.document, defaultOptions({ attempts: 2 }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /did not report collapsed/);
  const recent = result.sections.find((s) => s.label === "Recent");
  assert.ok(recent, "expected a 'Recent' entry from the generic sweep");
  assert.equal(recent.source, "generic");
  assert.equal(recent.collapsed, false);
});

test("a spent time budget stops clicking and still returns diagnostics instead of running on", async () => {
  const dom = await loadFixture("stuck-generic-toggle");
  const started = Date.now();
  // Real timers here: 40ms settle, generous attempts, tiny budget.
  const result = await collapseAndVerifySidebarPrivacy(
    dom.window.document,
    defaultOptions({ settleMs: 40, attempts: 500, budgetMs: 120, mountAttempts: 500 }),
  );
  assert.ok(Date.now() - started < 2000, "must return shortly after the budget, not after all attempts");
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.match(result.reason, /ran out of its 120ms time budget/);
  assert.ok(Array.isArray(result.sections) && Array.isArray(result.visibleText), "diagnostics still present");
});

test("the shipped expression carries a finite budget below the 15s CDP command timeout", () => {
  const match = collapseSidebarPrivacyExpression().match(/"budgetMs":(\d+)/);
  assert.ok(match, "budgetMs baked into the expression");
  assert.ok(Number(match[1]) > 0 && Number(match[1]) <= 12000, match[1]);
});

test("the CDP-evaluated expression is a syntactically valid IIFE calling document directly", () => {
  const source = collapseSidebarPrivacyExpression({ settleMs: 10, attempts: 2 });
  assert.match(source, /^\(async function collapseAndVerifySidebarPrivacy\(/);
  assert.match(source, /\(document, \{.*\}\)$/s);
  for (const label of SIDEBAR_PRIVACY_SECTION_LABELS) assert.match(source, new RegExp(`"${label}"`));
  assert.match(source, /aside\.app-shell-left-panel/);
  assert.doesNotMatch(source, /require\(|import /);
  assert.doesNotThrow(() => new Function(`return ${source};`));
});

// Actually evaluates the exact string shipped over CDP inside a jsdom window
// (whose only globals are the window's own, as in the renderer), so a closure
// reference or helper accidentally left outside the function body fails here
// with a ReferenceError instead of at runtime in the contributor's Codex.
test("the CDP-evaluated expression really runs in an isolated window and produces the same verdicts", async () => {
  for (const [fixture, expectOk] of [
    ["full-expanded", true],
    ["clip-collapse", true],
    ["localized-aria", true],
    ["relabeled-leak", false],
    ["localized-no-aria", false],
  ]) {
    const dom = await loadFixture(fixture);
    const result = await dom.window.eval(collapseSidebarPrivacyExpression({ settleMs: 0, attempts: 3 }));
    assert.equal(result.ok, expectOk, `${fixture}: ${JSON.stringify(result)}`);
  }
  const dom = await loadFixture("full-expanded");
  const collapsed = await dom.window.eval(collapseSidebarPrivacyExpression({ settleMs: 0, attempts: 3 }));
  assert.equal(collapsed.ok, true);
  const rescan = await dom.window.eval(collapseSidebarPrivacyExpression({ settleMs: 0, scanOnly: true }));
  assert.equal(rescan.ok, true);
});
