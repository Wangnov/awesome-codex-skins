// Sidebar privacy guard for `preview-shot`.
//
// SPEC.md has always required the cover screenshot to have the sidebar's
// "pinned / projects / tasks" sections collapsed before capture, because
// those three sections render a contributor's real, private workspace
// content (their own pinned chats, project names, task titles). Until now
// that collapsing was a manual, unverified step the contributor did by hand
// — `preview-shot`'s own source said so explicitly ("the CALLER's job...").
// That is the barrier this module removes: it drives the collapse through
// Codex's *real* UI (dispatching real click events on the real toggle
// controls, over the same CDP connection used to inject the skin) and then
// verifies nothing private-shaped is still visibly rendered, refusing to let
// `preview-shot` capture a frame otherwise.
//
// Codex's renderer is closed-source and not vendored anywhere in this repo,
// so this module has no ground truth for the sidebar's internal markup
// beyond the three section labels SPEC.md itself has documented for years.
// It is deliberately asymmetric about how it fails: it will happily report
// "nothing found to collapse" (a section that doesn't render at all — e.g.
// an empty account — has nothing to leak), but it will never call a capture
// safe just because it could not *check*. A missing sidebar container, a
// section header with no operable toggle, or any element anywhere in the
// sidebar that still matches a "this looks like one row of a private list"
// pattern after every discovered toggle was clicked — all of those fail the
// whole check and the caller must not take the screenshot.

// The exact three labels SPEC.md's preview requirement has always named.
// Keeping this list short and literal (rather than guessing synonyms) means
// a false match is very unlikely; the broad, independent leak scan below is
// what carries the actual safety guarantee if Codex ever renames, relabels,
// or localizes these headers.
export const SIDEBAR_PRIVACY_SECTION_LABELS = Object.freeze(["Pinned", "Projects", "Tasks"]);

export const SIDEBAR_SELECTOR = "aside.app-shell-left-panel";

// Anything inside the sidebar that plausibly renders one item of a private
// list, independent of which (if any) named section it lives under. This is
// the actual safety net: even if none of the three labels above match (a
// relabel, a locale, a future redesign), a row still matching one of these
// after the collapse pass fails the capture.
export const PRIVATE_ROW_SELECTORS = Object.freeze([
  '[role="listitem"]',
  '[role="option"]',
  "li",
  '[data-testid*="thread" i]',
  '[data-testid*="conversation" i]',
  '[data-testid*="project" i]',
  '[data-testid*="task" i]',
  '[href*="/thread" i]',
  '[href*="/conversation" i]',
  '[href*="/project" i]',
  '[href*="/task" i]',
]);

// The one implementation, shared byte-for-byte between the unit tests (which
// call it directly against a jsdom fixture) and the CDP-evaluated expression
// (which embeds it via `.toString()`, the same technique composer-overflow.mjs
// uses for `createComposerOverflowAnnotator`). It takes `labels`,
// `rowSelector` and `sidebarSelector` as required arguments rather than
// defaulting to the consts above, so the function body has *no* free
// variables and stays valid after being re-stringified and evaluated in the
// renderer, with no risk of the two call sites' data silently drifting apart
// — there is only one place (the consts above) where that data lives.
export async function collapseAndVerifySidebarPrivacy(
  doc,
  { settleMs = 250, attempts = 8, wait, labels, rowSelector, sidebarSelector },
) {
  const sleep = wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const isVisible = (node) => {
    if (!node || typeof node.getBoundingClientRect !== "function") return false;
    if (typeof node.closest === "function" && node.closest('[aria-hidden="true"]')) return false;
    const rect = node.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const view = doc.defaultView;
    const style = view && typeof view.getComputedStyle === "function"
      ? view.getComputedStyle(node)
      : node.style || {};
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (style.opacity !== undefined && style.opacity !== "" && Number(style.opacity) === 0) return false;
    return true;
  };
  const ownText = (node) => {
    const kids = node.childNodes ? [...node.childNodes] : [];
    return kids
      .filter((n) => n.nodeType === 3 /* TEXT_NODE */)
      .map((n) => (n.textContent || "").trim())
      .join(" ")
      .trim();
  };

  const sidebar = doc.querySelector(sidebarSelector);
  if (!sidebar) {
    return { ok: false, sidebarFound: false, sections: [], leaks: [], reason: "sidebar container not found" };
  }

  const sections = [];
  for (const label of labels) {
    const all = [...sidebar.querySelectorAll("*")];
    const candidates = all.filter((node) => {
      if ((node.children ? node.children.length : 0) > 2) return false; // headers are short, leaf-ish nodes
      return ownText(node).toLowerCase() === label.toLowerCase();
    });
    const headerNode = candidates.find(isVisible) || null;
    if (!headerNode) {
      sections.push({ label, found: false, toggleFound: false, collapsed: false });
      continue;
    }
    const toggle =
      (typeof headerNode.closest === "function" &&
        headerNode.closest('button,[role="button"],[aria-expanded]')) ||
      (typeof headerNode.querySelector === "function" &&
        headerNode.querySelector('button,[role="button"],[aria-expanded]')) ||
      null;
    if (!toggle) {
      sections.push({ label, found: true, toggleFound: false, collapsed: false });
      continue;
    }
    let collapsed = toggle.getAttribute && toggle.getAttribute("aria-expanded") === "false";
    if (!collapsed) {
      // `doc.defaultView` is `window` in both a real browser (this function
      // also ships stringified into the renderer, see below) and jsdom, so
      // this always constructs a real, dispatchable event for whichever DOM
      // is in play — never a plain object a real dispatchEvent would reject.
      const MouseEventCtor = doc.defaultView && doc.defaultView.MouseEvent;
      for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
        if (toggle.dispatchEvent) {
          toggle.dispatchEvent(
            MouseEventCtor
              ? new MouseEventCtor(type, { bubbles: true, cancelable: true, composed: true })
              : { type, bubbles: true, cancelable: true },
          );
        }
      }
      for (let i = 0; i < attempts && !collapsed; i += 1) {
        await sleep(settleMs);
        collapsed = toggle.getAttribute && toggle.getAttribute("aria-expanded") === "false";
      }
    }
    sections.push({ label, found: true, toggleFound: true, collapsed: Boolean(collapsed) });
  }

  await sleep(settleMs);
  const leaks = [...sidebar.querySelectorAll(rowSelector)]
    .filter(isVisible)
    .map((node) => (ownText(node) || node.textContent || "").trim().slice(0, 40))
    .filter((text) => text.length > 0);

  const collapseFailures = sections.filter((s) => s.found && (!s.toggleFound || !s.collapsed));
  const ok = collapseFailures.length === 0 && leaks.length === 0;
  let reason = null;
  if (!ok) {
    if (collapseFailures.some((s) => !s.toggleFound)) {
      reason = "a sidebar section header was found but has no discoverable toggle control";
    } else if (collapseFailures.length > 0) {
      reason = "a sidebar section did not report collapsed after clicking its toggle";
    } else {
      reason = "private-looking rows are still visible in the sidebar after collapsing";
    }
  }
  return { ok, sidebarFound: true, sections, leaks, reason };
}

// CDP-evaluated form: `collapseAndVerifySidebarPrivacy` stringified and
// invoked against `document` with the canonical labels/selectors baked in as
// JSON. Runs entirely inside the renderer via Runtime.evaluate — nothing
// Node-specific crosses the boundary.
export function collapseSidebarPrivacyExpression({ settleMs = 250, attempts = 8 } = {}) {
  const options = {
    settleMs,
    attempts,
    labels: SIDEBAR_PRIVACY_SECTION_LABELS,
    rowSelector: PRIVATE_ROW_SELECTORS.join(","),
    sidebarSelector: SIDEBAR_SELECTOR,
  };
  return `(${collapseAndVerifySidebarPrivacy.toString()})(document, ${JSON.stringify(options)})`;
}
