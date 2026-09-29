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
// Two collapse passes run before the leak scan: first the three named
// sections (by label), then a generic sweep that clicks *any other*
// `aria-expanded="true"` toggle still visible in the sidebar. The generic
// pass exists because the named pass has no way to find a private,
// collapsible list it has no label for — a future "Recent"/history section,
// a locale-specific rename, or any other section that happens to use the
// same expand/collapse convention. It is applied generically, independent of
// label text, so it also collapses a mislabeled Pinned/Projects/Tasks
// section the named pass missed.
//
// What "fails closed" does and does not mean here. It fails closed on every
// shape it can recognize: a missing sidebar container; NO recognizable
// collapsible section at all after waiting for the sidebar to mount (a
// non-English locale or a redesign that defeats both the label match and the
// aria-expanded convention lands here — an unrecognized sidebar is refused,
// never assumed empty); a section header with no operable toggle; a toggle
// that never reports collapsed; and any element in the sidebar still matching
// a "looks like one row of a private list" pattern after every discovered
// toggle was clicked. It does NOT, and cannot, prove that no private content is
// visible: a private list whose rows match none of the row patterns *and*
// that sits beside at least one recognizable section would pass. The scan also
// covers only the sidebar container — the composer's project/workspace
// selector, header titles and the main content area are NOT scanned. The
// result therefore also returns `visibleText`, every distinct text still
// visible in the sidebar, so the caller can show it to the contributor, and
// the docs tell contributors to look at the saved WebP before submitting.
//
// Side effects on the live app: collapsing is done to the contributor's real
// Codex, so pinned/projects/tasks (and any other collapsible sidebar section)
// stay collapsed afterward — Codex may persist that state. Toggles that open a
// popup (aria-haspopup, combobox: account/workspace menus) are never clicked.

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
  '[href*="/local/" i]',
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
  {
    settleMs = 250, attempts = 8, mountAttempts = 20, scanOnly = false,
    wait, labels, rowSelector, sidebarSelector,
  },
) {
  const sleep = wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const view = doc.defaultView;
  const styleOf = (node) =>
    view && typeof view.getComputedStyle === "function" ? view.getComputedStyle(node) : node.style || {};
  const zeroSized = (rect) => !rect || rect.width <= 0 || rect.height <= 0;
  const clips = (style) =>
    [style.overflow, style.overflowX, style.overflowY].some((v) => v && v !== "visible");
  const isVisible = (node) => {
    if (!node || typeof node.getBoundingClientRect !== "function") return false;
    if (typeof node.closest === "function" && node.closest('[aria-hidden="true"]')) return false;
    const rect = node.getBoundingClientRect();
    if (zeroSized(rect)) return false;
    const style = styleOf(node);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (style.opacity !== undefined && style.opacity !== "" && Number(style.opacity) === 0) return false;
    // A node with its own non-zero box can still be invisible when an ancestor
    // clips it away (a collapse implemented as height:0 / max-height:0 with
    // overflow:hidden leaves every child's own rect intact). Walk the ancestors:
    // any clipping ancestor that is empty, or that the node lies wholly outside
    // of, hides it.
    for (let anc = node.parentElement; anc; anc = anc.parentElement) {
      const ancStyle = styleOf(anc);
      if (ancStyle.display === "none" || ancStyle.visibility === "hidden") return false;
      if (ancStyle.opacity !== undefined && ancStyle.opacity !== "" && Number(ancStyle.opacity) === 0) return false;
      if (!clips(ancStyle)) continue;
      const ar = anc.getBoundingClientRect();
      if (zeroSized(ar)) return false;
      if (rect.bottom <= ar.top || rect.top >= ar.bottom || rect.right <= ar.left || rect.left >= ar.right) return false;
    }
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
  // Account/workspace menus and comboboxes report aria-expanded too, but they
  // open popups rather than collapse a section; clicking them would open or
  // close a menu, not tidy the sidebar.
  const opensPopup = (node) => {
    const popup = node.getAttribute && node.getAttribute("aria-haspopup");
    return (popup !== null && popup !== undefined && popup !== "false") ||
      (node.getAttribute && node.getAttribute("role")) === "combobox";
  };
  const isCollapsed = (toggle) => toggle.getAttribute && toggle.getAttribute("aria-expanded") === "false";

  const sidebar = doc.querySelector(sidebarSelector);
  if (!sidebar) {
    return {
      ok: false, sidebarFound: false, sections: [], leaks: [], visibleText: [],
      reason: "sidebar container not found",
    };
  }

  const findNamedHeader = (label) => {
    const candidates = [...sidebar.querySelectorAll("*")].filter((node) => {
      if ((node.children ? node.children.length : 0) > 2) return false; // headers are short, leaf-ish nodes
      return ownText(node).toLowerCase() === label.toLowerCase();
    });
    return candidates.find(isVisible) || null;
  };
  const disclosureToggles = () =>
    [...sidebar.querySelectorAll("[aria-expanded]")].filter((node) => isVisible(node) && !opensPopup(node));
  // The sidebar's lists mount asynchronously after the home route settles, so
  // a one-shot look right after route detection can see a half-built sidebar.
  // Wait (bounded) until at least one recognizable section exists; if none
  // ever appears the recognition check below refuses to call it safe.
  const anyRecognizable = () =>
    labels.some((label) => findNamedHeader(label)) || disclosureToggles().length > 0;
  for (let i = 0; i < mountAttempts && !anyRecognizable(); i += 1) await sleep(settleMs);

  // Dispatches the real pointer/mouse/click sequence at `toggle`, stopping as
  // soon as it reports collapsed — a handler bound to both pointerdown and
  // click must not see a second event that would toggle it back open — then
  // waits up to `attempts` settle rounds. In scanOnly mode nothing is clicked.
  const clickToggleAndWaitCollapsed = async (toggle) => {
    if (scanOnly || isCollapsed(toggle)) return Boolean(isCollapsed(toggle));
    // `doc.defaultView` is `window` in both a real browser (this function
    // also ships stringified into the renderer, see below) and jsdom, so
    // this always constructs a real, dispatchable event for whichever DOM
    // is in play — never a plain object a real dispatchEvent would reject.
    const MouseEventCtor = view && view.MouseEvent;
    for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
      if (toggle.dispatchEvent) {
        toggle.dispatchEvent(
          MouseEventCtor
            ? new MouseEventCtor(type, { bubbles: true, cancelable: true, composed: true })
            : { type, bubbles: true, cancelable: true },
        );
      }
      await sleep(Math.min(settleMs, 50));
      if (isCollapsed(toggle)) break;
    }
    let collapsed = isCollapsed(toggle);
    for (let i = 0; i < attempts && !collapsed; i += 1) {
      await sleep(settleMs);
      collapsed = isCollapsed(toggle);
    }
    return Boolean(collapsed);
  };

  const sections = [];
  const handledToggles = new Set();
  for (const label of labels) {
    const headerNode = findNamedHeader(label);
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
    handledToggles.add(toggle);
    const collapsed = await clickToggleAndWaitCollapsed(toggle);
    sections.push({ label, found: true, toggleFound: true, collapsed, source: "named" });
  }

  // Generic sweep: the named pass above only ever looks for the known labels,
  // so it has no way to find (let alone collapse) a private, collapsible
  // section it has no label for — or a section whose label is localized. This
  // pass instead looks for *any* other visible disclosure toggle still
  // reporting `aria-expanded="true"` inside the sidebar — regardless of label —
  // and collapses it the same way. Runs in bounded rounds (collapsing one
  // section can reveal another) and never revisits a toggle already handled.
  for (let round = 0; round < 4; round += 1) {
    const extraToggles = disclosureToggles().filter(
      (node) => node.getAttribute("aria-expanded") === "true" && !handledToggles.has(node),
    );
    if (extraToggles.length === 0) break;
    for (const toggle of extraToggles) {
      handledToggles.add(toggle);
      const collapsed = await clickToggleAndWaitCollapsed(toggle);
      const label = ownText(toggle) || toggle.getAttribute("aria-label") || "(unlabeled section)";
      sections.push({ label, found: true, toggleFound: true, collapsed, source: "generic" });
    }
  }

  await sleep(settleMs);
  const leaks = [...sidebar.querySelectorAll(rowSelector)]
    .filter(isVisible)
    .map((node) => (ownText(node) || node.textContent || "").trim().slice(0, 40))
    .filter((text) => text.length > 0);

  // Everything textual still visible in the sidebar, for the caller to show to
  // the contributor as a last human check (the row scan is a heuristic).
  const visibleText = [];
  for (const node of sidebar.querySelectorAll("*")) {
    const text = ownText(node).slice(0, 60);
    if (text && !visibleText.includes(text) && isVisible(node)) visibleText.push(text);
    if (visibleText.length >= 80) break;
  }

  const recognizedSections =
    sections.filter((s) => s.found && s.toggleFound).length +
    disclosureToggles().filter((node) => !handledToggles.has(node)).length;
  const collapseFailures = sections.filter((s) => s.found && (!s.toggleFound || !s.collapsed));
  const ok = recognizedSections > 0 && collapseFailures.length === 0 && leaks.length === 0;
  let reason = null;
  if (!ok) {
    if (collapseFailures.some((s) => !s.toggleFound)) {
      reason = "a sidebar section header was found but has no discoverable toggle control";
    } else if (collapseFailures.length > 0) {
      reason = scanOnly
        ? "a sidebar section is expanded again after the collapse pass"
        : "a sidebar section did not report collapsed after clicking its toggle";
    } else if (leaks.length > 0) {
      reason = "private-looking rows are still visible in the sidebar after collapsing";
    } else {
      reason =
        "no collapsible sidebar section was recognized (non-English locale, still loading, or changed markup?) — " +
        "refusing to assume the sidebar is empty";
    }
  }
  return { ok, sidebarFound: true, sections, recognizedSections, leaks, visibleText, reason };
}

// CDP-evaluated form: `collapseAndVerifySidebarPrivacy` stringified and
// invoked against `document` with the canonical labels/selectors baked in as
// JSON. Runs entirely inside the renderer via Runtime.evaluate — nothing
// Node-specific crosses the boundary.
export function collapseSidebarPrivacyExpression({ settleMs = 250, attempts = 8, scanOnly = false } = {}) {
  const options = {
    settleMs,
    attempts,
    scanOnly,
    labels: SIDEBAR_PRIVACY_SECTION_LABELS,
    rowSelector: PRIVATE_ROW_SELECTORS.join(","),
    sidebarSelector: SIDEBAR_SELECTOR,
  };
  return `(${collapseAndVerifySidebarPrivacy.toString()})(document, ${JSON.stringify(options)})`;
}
