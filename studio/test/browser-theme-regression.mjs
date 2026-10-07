#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "playwright";

import { buildPayload, verifyExpression } from "../src/payload.mjs";
import { loadTheme } from "../src/theme.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const studioRoot = path.resolve(here, "..");
const repoRoot = path.resolve(studioRoot, "..");
const skinsRoot = path.join(repoRoot, "skins");
const fixtureUrl = pathToFileURL(path.join(here, "fixtures", "browser-shell.html")).href;
const defaultChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function parseArguments(argv) {
  const options = {
    extraThemeDirs: [],
    themeIds: [],
    headed: false,
    reportDir: process.env.CTS_BROWSER_REPORT_DIR || "",
    executablePath: process.env.CTS_BROWSER_EXECUTABLE || "",
    concurrency: Number(process.env.CTS_BROWSER_CONCURRENCY || "2"),
  };
  const envExtras = process.env.CTS_EXTRA_THEME_DIRS;
  if (envExtras) options.extraThemeDirs.push(...envExtras.split(path.delimiter).filter(Boolean));

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--headed") options.headed = true;
    else if (argument === "--theme") options.themeIds.push(argv[++index]);
    else if (argument === "--extra-theme-dir") options.extraThemeDirs.push(argv[++index]);
    else if (argument === "--report-dir") options.reportDir = argv[++index];
    else if (argument === "--browser-executable") options.executablePath = argv[++index];
    else if (argument === "--concurrency") options.concurrency = Number(argv[++index]);
    else if (argument === "--help") {
      console.log(`Usage: npm run test:browser -- [options]

Options:
  --theme ID                 Run one public skin (repeatable)
  --extra-theme-dir PATH     Also run one local theme directory (repeatable)
  --report-dir PATH          Write JSON evidence and failure screenshots here
  --browser-executable PATH  Use an installed Chromium-compatible executable
  --concurrency N            Run 1-4 isolated theme pages at once (default: 2)
  --headed                   Show the browser window

Environment equivalents: CTS_EXTRA_THEME_DIRS, CTS_BROWSER_REPORT_DIR,
CTS_BROWSER_EXECUTABLE, CTS_BROWSER_CONCURRENCY.`);
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 4) {
    throw new Error("--concurrency must be an integer between 1 and 4");
  }
  return options;
}

async function directoryExists(candidate) {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(candidate) {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

async function discoverThemes(options) {
  const publicEntries = (await fs.readdir(skinsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ dir: path.join(skinsRoot, entry.name), source: "public" }));

  const extras = [];
  for (const candidate of options.extraThemeDirs) {
    const resolved = path.resolve(candidate);
    if (!(await directoryExists(resolved))) throw new Error(`extra theme directory does not exist: ${resolved}`);
    extras.push({ dir: resolved, source: "extra" });
  }

  const themes = [];
  for (const entry of [...publicEntries, ...extras]) {
    const loaded = await loadTheme(entry.dir);
    if (options.themeIds.length && !options.themeIds.includes(loaded.config.id)) continue;
    themes.push({ ...entry, id: loaded.config.id, name: loaded.config.name });
  }

  if (options.themeIds.length) {
    const found = new Set(themes.map((theme) => theme.id));
    const missing = options.themeIds.filter((id) => !found.has(id));
    if (missing.length) throw new Error(`requested theme not found: ${missing.join(", ")}`);
  }
  return themes.sort((left, right) => left.id.localeCompare(right.id));
}

async function auditBaseSurface(page, themeId) {
  return page.evaluate(async (expectedThemeId) => {
    const checks = [];
    const add = (name, pass, details = {}) => checks.push({ name, pass: Boolean(pass), details });
    const tick = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const imageCache = new Map();

    const extractUrl = (backgroundImage) => {
      const match = String(backgroundImage || "").match(/url\((?:"([^"]*)"|'([^']*)'|([^)]*))\)/);
      return (match?.[1] || match?.[2] || match?.[3] || "").trim();
    };
    const imageInfo = async (backgroundImage) => {
      const src = extractUrl(backgroundImage);
      if (!src) return { present: false, decoded: false, mime: null, bytes: 0, width: 0, height: 0 };
      if (!imageCache.has(src)) {
        imageCache.set(src, new Promise((resolve) => {
          const image = new Image();
          const done = (decoded) => resolve({
            present: true,
            decoded,
            mime: src.match(/^data:([^;,]+)/)?.[1] || "url",
            bytes: src.length,
            width: image.naturalWidth || 0,
            height: image.naturalHeight || 0,
          });
          image.onload = () => done(true);
          image.onerror = () => done(false);
          image.src = src;
          image.decode?.().then(() => done(true), () => {});
        }));
      }
      return imageCache.get(src);
    };
    const rectObject = (rect) => ({
      x: Math.round(rect.x * 10) / 10,
      y: Math.round(rect.y * 10) / 10,
      width: Math.round(rect.width * 10) / 10,
      height: Math.round(rect.height * 10) / 10,
      left: Math.round(rect.left * 10) / 10,
      top: Math.round(rect.top * 10) / 10,
      right: Math.round(rect.right * 10) / 10,
      bottom: Math.round(rect.bottom * 10) / 10,
    });
    const backgroundSignature = (node) => {
      const style = getComputedStyle(node);
      const compact = (value) => String(value || "").replace(
        /url\((?:"[^"]*"|'[^']*'|[^)]*)\)/g,
        (token) => {
          const url = extractUrl(token);
          return `url(${url.match(/^data:([^;,]+)/)?.[1] || "external"}:${url.length})`;
        },
      );
      return {
        image: compact(style.backgroundImage),
        color: style.backgroundColor,
        size: style.backgroundSize,
        position: style.backgroundPosition,
      };
    };

    const runtime = window.__CODEX_THEME_STUDIO__;
    const logo = document.querySelector(".qa-workspace-switcher");
    add("runtime installed requested theme", runtime?.themeId === expectedThemeId, {
      expected: expectedThemeId,
      actual: runtime?.themeId || null,
    });
    add("runtime annotates the workspace wordmark", logo?.dataset.ctsLogo === "codex", {
      actual: logo?.dataset.ctsLogo || null,
    });

    const logoCases = [];
    for (const mode of ["dark", "light"]) {
      document.documentElement.setAttribute("data-theme", mode);
      runtime?.ensure();
      await tick();
      for (const width of [240, 280, 340, 420]) {
        document.documentElement.style.setProperty("--fixture-sidebar-width", `${width}px`);
        await tick();
        for (const variant of ["codex", "chatgpt", "chatgpt-work"]) {
          logo.dataset.ctsLogo = variant;
          const result = await window.__CTS_BROWSER_FIXTURE__.measureLogo({
            mode, width, variant, state: "normal",
          });
          logoCases.push(result);
          add(`logo ${variant} ${mode} ${width}px normal`, result.pass, result);
        }
      }
    }

    document.documentElement.style.setProperty("--fixture-sidebar-width", "340px");
    document.documentElement.setAttribute("data-theme", "dark");
    runtime?.ensure();
    await tick();

    const expectedGlyphs = [
      "new-task", "home", "space", "scheduled", "plugins", "pull-request",
      "sites", "chat", "settings", "search", "folder", "explore", "build",
      "review", "fix", "attach", "model",
    ];
    const glyphs = [];
    for (const name of expectedGlyphs) {
      const glyph = document.querySelector(`svg[data-cts-glyph="${name}"]`);
      const style = glyph ? getComputedStyle(glyph) : null;
      const image = await imageInfo(style?.backgroundImage);
      const visible = Boolean(glyph && glyph.getBoundingClientRect().width > 0 &&
        style.display !== "none" && style.visibility !== "hidden" && Number.parseFloat(style.opacity) > .05);
      const result = {
        name,
        annotated: Boolean(glyph),
        visible,
        image,
        rect: glyph ? rectObject(glyph.getBoundingClientRect()) : null,
        display: style?.display || null,
        visibility: style?.visibility || null,
        opacity: style?.opacity || null,
        backgroundSize: style?.backgroundSize || null,
        pass: Boolean(glyph && visible && image.decoded),
      };
      glyphs.push(result);
      add(`glyph ${name} is annotated and decodes`, result.pass, result);
    }

    const stage = document.getElementById("cts-stage");
    const chrome = document.getElementById("cts-chrome");
    const homeMain = document.getElementById("qa-home-main");
    const taskMain = document.getElementById("qa-task-main");
    const layerDetails = {
      stage: stage ? {
        parent: stage.parentElement?.id || null,
        pointerEvents: getComputedStyle(stage).pointerEvents,
        zIndex: getComputedStyle(stage).zIndex,
      } : null,
      overlay: chrome ? {
        parent: chrome.parentElement?.tagName || null,
        pointerEvents: getComputedStyle(chrome).pointerEvents,
        zIndex: getComputedStyle(chrome).zIndex,
      } : null,
    };
    add("stage mounts below the active home surface", Boolean(
      stage && stage.parentElement === homeMain && getComputedStyle(stage).pointerEvents === "none" &&
      Number.parseFloat(getComputedStyle(stage).zIndex) <= 0
    ), layerDetails);
    if (chrome) {
      add("optional overlay remains non-interactive above the stage", Boolean(
        chrome.parentElement === document.body && getComputedStyle(chrome).pointerEvents === "none" &&
        Number.parseFloat(getComputedStyle(chrome).zIndex) > Number.parseFloat(getComputedStyle(stage).zIndex)
      ), layerDetails);
    }

    const backgroundBefore = backgroundSignature(document.body);
    const portal = document.createElement("div");
    portal.className = "qa-portal-menu";
    portal.setAttribute("role", "menu");
    portal.setAttribute("data-radix-menu-content", "");
    portal.textContent = "Fixture menu";
    document.body.appendChild(portal);
    runtime?.ensure();
    await tick();
    const backgroundWithPortal = backgroundSignature(document.body);
    const portalStable = homeMain.classList.contains("cts-home-shell") &&
      document.querySelector('[role="main"].cts-home')?.getAttribute("aria-label") === "Home route" &&
      document.getElementById("cts-stage")?.parentElement === homeMain &&
      JSON.stringify(backgroundBefore) === JSON.stringify(backgroundWithPortal);
    add("portal mount preserves home route and background", portalStable, {
      before: backgroundBefore,
      withPortal: backgroundWithPortal,
      homeClass: homeMain.classList.contains("cts-home-shell"),
    });
    portal.remove();
    runtime?.ensure();
    await tick();
    add("portal removal preserves the background", JSON.stringify(backgroundBefore) === JSON.stringify(backgroundSignature(document.body)), {
      before: backgroundBefore,
      after: backgroundSignature(document.body),
    });

    window.__CTS_BROWSER_FIXTURE__.showRoute("task");
    await tick();
    add("task route replaces the cached home as the active surface", Boolean(
      document.getElementById("cts-stage")?.parentElement === taskMain &&
      !homeMain.classList.contains("main-surface") &&
      taskMain.classList.contains("main-surface") &&
      !document.querySelector('[role="main"].cts-home')
    ), {
      stageParent: document.getElementById("cts-stage")?.parentElement?.id || null,
      homeMainCompatible: homeMain.classList.contains("main-surface"),
      taskMainCompatible: taskMain.classList.contains("main-surface"),
    });

    const taskWrapper = document.getElementById("qa-task-wrapper");
    const modal = document.getElementById("qa-modal-root");
    taskWrapper.setAttribute("inert", "");
    taskWrapper.setAttribute("aria-hidden", "true");
    modal.hidden = false;
    runtime?.ensure();
    await tick();
    const modalButton = document.getElementById("qa-modal-action");
    const modalBox = modalButton.getBoundingClientRect();
    const modalHit = document.elementFromPoint(modalBox.left + modalBox.width / 2, modalBox.top + modalBox.height / 2);
    add("modal isolation keeps the active task surface and interactive dialog", Boolean(
      document.getElementById("cts-stage")?.parentElement === taskMain &&
      (modalHit === modalButton || modalButton.contains(modalHit))
    ), {
      stageParent: document.getElementById("cts-stage")?.parentElement?.id || null,
      hit: modalHit?.id || modalHit?.tagName || null,
    });
    modal.hidden = true;
    taskWrapper.removeAttribute("inert");
    taskWrapper.removeAttribute("aria-hidden");
    window.__CTS_BROWSER_FIXTURE__.showRoute("home");
    await tick();
    add("returning home restores its stage and background", Boolean(
      document.getElementById("cts-stage")?.parentElement === homeMain &&
      homeMain.classList.contains("cts-home-shell") &&
      JSON.stringify(backgroundBefore) === JSON.stringify(backgroundSignature(document.body))
    ), {
      stageParent: document.getElementById("cts-stage")?.parentElement?.id || null,
      background: backgroundSignature(document.body),
    });

    const neighbour = document.querySelector('[data-qa-neighbour="attachment"]');
    const neighbourBox = neighbour.getBoundingClientRect();
    const neighbourHit = document.elementFromPoint(
      neighbourBox.left + neighbourBox.width / 2,
      neighbourBox.top + neighbourBox.height / 2,
    );
    add("decorative layers do not intercept composer controls", Boolean(
      neighbourHit === neighbour || neighbour.contains(neighbourHit)
    ), {
      hit: neighbourHit?.getAttribute?.("data-qa-neighbour") || neighbourHit?.tagName || null,
      stagePointerEvents: stage ? getComputedStyle(stage).pointerEvents : null,
      overlayPointerEvents: chrome ? getComputedStyle(chrome).pointerEvents : null,
    });

    return {
      pass: checks.every((check) => check.pass),
      checks,
      logoCases,
      glyphs,
      layers: layerDetails,
      background: backgroundBefore,
    };
  }, themeId);
}

async function settleWorkspaceLogo(page) {
  let previous = "";
  let stableSamples = 0;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await page.waitForTimeout(35);
    const signature = await page.evaluate(() => {
      const logo = document.querySelector(".qa-workspace-switcher");
      const before = getComputedStyle(logo, "::before");
      return [before.transform, before.filter, before.opacity, JSON.stringify(logo.getBoundingClientRect().toJSON())].join("|");
    });
    if (signature === previous) stableSamples += 1;
    else stableSamples = 0;
    if (stableSamples >= 2) return;
    previous = signature;
  }
}

async function configureWorkspaceLogo(page, { mode, width, variant }) {
  return page.evaluate(async ({ nextMode, nextWidth, nextVariant }) => {
    document.documentElement.setAttribute("data-theme", nextMode);
    document.documentElement.style.setProperty("--fixture-sidebar-width", `${nextWidth}px`);
    document.activeElement?.blur();
    const annotated = window.__CTS_BROWSER_FIXTURE__.setWorkspaceVariant(nextVariant);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return annotated;
  }, { nextMode: mode, nextWidth: width, nextVariant: variant });
}

async function focusWorkspaceLogoWithKeyboard(page) {
  await page.evaluate(() => document.activeElement?.blur());
  for (let index = 0; index < 24; index += 1) {
    await page.keyboard.press("Tab");
    if (await page.evaluate(() => document.activeElement?.matches(".qa-workspace-switcher"))) return true;
  }
  return false;
}

async function auditLogoInteractions(page, variants) {
  const checks = [];
  for (const mode of ["dark", "light"]) {
    for (const width of [240, 280, 340, 420]) {
      for (const variant of variants) {
        await page.mouse.move(1276, 796);
        await configureWorkspaceLogo(page, { mode, width, variant });

        await page.hover(".qa-workspace-switcher");
        await settleWorkspaceLogo(page);
        const hovered = await page.evaluate((metadata) =>
          window.__CTS_BROWSER_FIXTURE__.measureLogo(metadata), {
          mode, width, variant, state: "hover",
        });
        checks.push({ name: `logo ${variant} ${mode} ${width}px hover`, pass: hovered.pass, details: hovered });

        await page.mouse.move(1276, 796);
        const reachedByKeyboard = await focusWorkspaceLogoWithKeyboard(page);
        await settleWorkspaceLogo(page);
        const focused = await page.evaluate((metadata) =>
          window.__CTS_BROWSER_FIXTURE__.measureLogo(metadata), {
          mode, width, variant, state: "focus",
        });
        focused.reachedByKeyboard = reachedByKeyboard;
        const focusPass = reachedByKeyboard && focused.pass;
        checks.push({ name: `logo ${variant} ${mode} ${width}px focus`, pass: focusPass, details: focused });
      }
    }
  }
  await page.mouse.move(1276, 796);
  await page.evaluate(() => document.activeElement?.blur());
  return { pass: checks.every((check) => check.pass), checks };
}

async function configureComposer(page, action, width, disabled = false) {
  return page.evaluate(({ nextAction, nextWidth, nextDisabled }) =>
    window.__CTS_BROWSER_FIXTURE__.setComposerState(nextAction, nextWidth, nextDisabled), {
    nextAction: action,
    nextWidth: width,
    nextDisabled: disabled,
  });
}

async function probeComposer(page, { action, width, state }) {
  return page.evaluate(async ({ expectedAction, expectedWidth, expectedState }) => {
    const extractUrl = (backgroundImage) => {
      const match = String(backgroundImage || "").match(/url\((?:"([^"]*)"|'([^']*)'|([^)]*))\)/);
      return (match?.[1] || match?.[2] || match?.[3] || "").trim();
    };
    const imageInfo = async (backgroundImage) => {
      const src = extractUrl(backgroundImage);
      if (!src) return { present: false, decoded: false, mime: null, bytes: 0, width: 0, height: 0 };
      return new Promise((resolve) => {
        const image = new Image();
        const done = (decoded) => resolve({
          present: true,
          decoded,
          mime: src.match(/^data:([^;,]+)/)?.[1] || "url",
          bytes: src.length,
          width: image.naturalWidth || 0,
          height: image.naturalHeight || 0,
        });
        image.onload = () => done(true);
        image.onerror = () => done(false);
        image.src = src;
        image.decode?.().then(() => done(true), () => {});
      });
    };
    const number = (value) => {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const roundRect = (rect) => rect ? ({
      left: Math.round(rect.left * 10) / 10,
      top: Math.round(rect.top * 10) / 10,
      right: Math.round(rect.right * 10) / 10,
      bottom: Math.round(rect.bottom * 10) / 10,
      width: Math.round(rect.width * 10) / 10,
      height: Math.round(rect.height * 10) / 10,
    }) : null;
    const pseudoRect = (element, pseudo) => {
      const host = element.getBoundingClientRect();
      const style = getComputedStyle(element, pseudo);
      const left = number(style.left);
      const right = number(style.right);
      const top = number(style.top);
      const bottom = number(style.bottom);
      let boxWidth = number(style.width);
      let boxHeight = number(style.height);
      if (boxWidth === null && left !== null && right !== null) boxWidth = host.width - left - right;
      if (boxHeight === null && top !== null && bottom !== null) boxHeight = host.height - top - bottom;
      if (!(boxWidth > 0 && boxHeight > 0)) return null;
      const x = left !== null ? host.left + left : host.right - (right || 0) - boxWidth;
      const y = top !== null ? host.top + top : host.bottom - (bottom || 0) - boxHeight;
      const origin = style.transformOrigin.split(/\s+/).map(number);
      const ox = origin[0] ?? boxWidth / 2;
      const oy = origin[1] ?? boxHeight / 2;
      let matrix;
      try { matrix = style.transform === "none" ? new DOMMatrix() : new DOMMatrix(style.transform); }
      catch { matrix = new DOMMatrix(); }
      const points = [[0, 0], [boxWidth, 0], [boxWidth, boxHeight], [0, boxHeight]].map(([px, py]) => {
        const transformed = matrix.transformPoint(new DOMPoint(px - ox, py - oy));
        return { x: x + ox + transformed.x, y: y + oy + transformed.y };
      });
      const xs = points.map((point) => point.x);
      const ys = points.map((point) => point.y);
      return {
        left: Math.min(...xs), top: Math.min(...ys),
        right: Math.max(...xs), bottom: Math.max(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
      };
    };
    const intersection = (left, right) => {
      if (!left || !right) return { width: 0, height: 0, area: 0 };
      const width = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
      const height = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
      return { width, height, area: width * height };
    };

    const wrap = document.querySelector("[data-qa-composer-wrap]");
    const surface = wrap.querySelector(".composer-surface-chrome");
    const actionButton = wrap.querySelector("[data-qa-composer-action]");
    const svg = actionButton.querySelector("svg");
    const path = svg.querySelector("path");
    const after = getComputedStyle(wrap, "::after");
    const buttonStyle = getComputedStyle(actionButton);
    const content = after.content;
    const propRect = pseudoRect(wrap, "::after");
    const backgroundImage = after.backgroundImage;
    const background = await imageInfo(backgroundImage);
    const buttonBackground = await imageInfo(buttonStyle.backgroundImage);
    const afterOpacity = Number.parseFloat(after.opacity);
    const generated = !["none", "normal"].includes(content) && Boolean(propRect) &&
      after.display !== "none" && after.visibility !== "hidden" && afterOpacity > .05;
    const hasPaint = background.present || !["", '""', "''", "none", "normal"].includes(content);
    const afterVisible = generated && hasPaint;
    const buttonVisual = buttonBackground.present && buttonBackground.decoded;
    const propVisible = afterVisible || buttonVisual;
    const visualRect = afterVisible ? propRect : buttonVisual ? actionButton.getBoundingClientRect() : null;
    const neighbours = [...wrap.querySelectorAll("[data-qa-neighbour]")].map((button) => {
      const rect = button.getBoundingClientRect();
      const overlap = intersection(visualRect, rect);
      return {
        name: button.dataset.qaNeighbour,
        rect: roundRect(rect),
        overlap: {
          width: Math.round(overlap.width * 10) / 10,
          height: Math.round(overlap.height * 10) / 10,
          area: Math.round(overlap.area * 10) / 10,
        },
      };
    });
    const svgOpacity = Number.parseFloat(getComputedStyle(svg).opacity);
    const pathOpacity = Number.parseFloat(getComputedStyle(path).opacity);
    const glyphVisible = svgOpacity > .05 && pathOpacity > .05 && getComputedStyle(svg).visibility !== "hidden";
    const noOverlap = neighbours.every((item) => item.overlap.area <= .5);
    const noScroll = surface.scrollWidth - surface.clientWidth <= 1 && surface.scrollHeight - surface.clientHeight <= 1;
    const marker = actionButton.getAttribute("data-cts-composer-action");

    return {
      action: expectedAction,
      state: expectedState,
      width: expectedWidth,
      marker,
      markerCorrect: marker === expectedAction,
      glyphVisible,
      svgOpacity,
      pathOpacity,
      prop: {
        visible: propVisible,
        source: afterVisible ? "wrapper-after" : buttonVisual ? "button-background" : "none",
        content,
        opacity: Number.isFinite(afterOpacity) ? afterOpacity : null,
        pointerEvents: afterVisible ? after.pointerEvents : buttonStyle.pointerEvents,
        nonBlocking: afterVisible ? after.pointerEvents === "none" : buttonVisual,
        background: afterVisible ? background : buttonBackground,
        rect: roundRect(visualRect),
        transform: after.transform,
      },
      neighbours,
      noOverlap,
      noScroll,
      overflow: {
        width: surface.scrollWidth - surface.clientWidth,
        height: surface.scrollHeight - surface.clientHeight,
      },
    };
  }, { expectedAction: action, expectedWidth: width, expectedState: state });
}

async function auditComposerStates(page) {
  const checks = [];
  const widths = [360, 640];

  for (const width of widths) {
    await configureComposer(page, "send", width, false);
    await page.mouse.move(4, 4);
    await page.waitForTimeout(220);
    const normal = await probeComposer(page, { action: "send", width, state: "normal" });
    const normalPass = normal.markerCorrect && normal.prop.visible && normal.prop.nonBlocking &&
      (!normal.prop.background.present || normal.prop.background.decoded) && !normal.glyphVisible &&
      normal.noOverlap && normal.noScroll;
    checks.push({ name: `composer send normal ${width}px`, pass: normalPass, details: normal });

    await page.hover("[data-qa-composer-action]");
    await page.waitForTimeout(220);
    const hovered = await probeComposer(page, { action: "send", width, state: "hover" });
    const hoverPass = hovered.markerCorrect && hovered.prop.visible && hovered.prop.nonBlocking &&
      (!hovered.prop.background.present || hovered.prop.background.decoded) && !hovered.glyphVisible &&
      hovered.noOverlap && hovered.noScroll;
    checks.push({ name: `composer send hover ${width}px`, pass: hoverPass, details: hovered });

    await page.mouse.move(4, 4);
    await configureComposer(page, "send", width, true);
    await page.waitForTimeout(220);
    const disabled = await probeComposer(page, { action: "send", width, state: "disabled" });
    const disabledPass = disabled.markerCorrect && disabled.prop.visible && disabled.prop.nonBlocking &&
      (!disabled.prop.background.present || disabled.prop.background.decoded) && !disabled.glyphVisible &&
      disabled.noOverlap && disabled.noScroll;
    checks.push({ name: `composer send disabled ${width}px`, pass: disabledPass, details: disabled });

    for (const action of ["voice", "stop"]) {
      await configureComposer(page, action, width, false);
      await page.mouse.move(4, 4);
      await page.waitForTimeout(80);
      const state = await probeComposer(page, { action, width, state: "native" });
      const pass = state.markerCorrect && state.glyphVisible && !state.prop.visible && state.noScroll;
      checks.push({ name: `composer ${action} keeps native glyph ${width}px`, pass, details: state });
    }
  }

  return { pass: checks.every((check) => check.pass), checks };
}

function safeName(value) {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "theme";
}

async function installThemeOnFixture(page, built, themeId, appVersion) {
  const url = new URL(fixtureUrl);
  if (appVersion) url.searchParams.set("appVersion", appVersion);
  await page.goto(url.href, { waitUntil: "load" });
  const title = await page.title();
  if (title !== "Codex skin browser regression fixture") throw new Error(`fixture identity mismatch: ${title}`);
  const fixtureReady = await page.evaluate(() =>
    typeof window.__CTS_BROWSER_FIXTURE__?.measureLogo === "function");
  if (!fixtureReady) throw new Error("fixture logo measurement helper did not load");
  const installResult = await page.evaluate(built.payload);
  if (!installResult?.installed || installResult.themeId !== themeId) {
    throw new Error(`payload installation failed: ${JSON.stringify(installResult)}`);
  }
  await page.waitForTimeout(80);
}

async function runTheme(browser, entry, index, total, reportDir) {
  const startedAt = Date.now();
  const result = {
    id: entry.id,
    name: entry.name,
    source: entry.source,
    dir: entry.source === "public" ? path.relative(repoRoot, entry.dir) : entry.dir,
    pass: false,
    checks: [],
    console: [],
    pageErrors: [],
  };
  const consoleMessages = [];
  const pageErrors = [];
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
    colorScheme: "dark",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type())) {
      consoleMessages.push({ type: message.type(), text: message.text() });
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    try {
      const loaded = await loadTheme(entry.dir);
      const built = await buildPayload(entry.dir);
      if (loaded.config.id !== built.theme.id) throw new Error("loadTheme/buildPayload theme identity mismatch");

      await installThemeOnFixture(page, built, entry.id, "26.1002.51308");
      const base = await auditBaseSurface(page, entry.id);
      const currentLogos = await auditLogoInteractions(page, ["codex", "chatgpt"]);
      await configureWorkspaceLogo(page, { mode: "dark", width: 340, variant: "codex" });
      const composer = await auditComposerStates(page);
      const runtimeVerify = await page.evaluate(verifyExpression());
      const runtimeCheck = {
        name: "runtime structural verification",
        pass: runtimeVerify.pass === true,
        details: {
          pass: runtimeVerify.pass,
          installed: runtimeVerify.installed,
          theme: runtimeVerify.theme,
          mainSurfaceMode: runtimeVerify.mainSurfaceMode,
          mainSurfaceCompatible: runtimeVerify.mainSurfaceCompatible,
          composerSurfaceMode: runtimeVerify.composerSurfaceMode,
          composerSurfaceCompatible: runtimeVerify.composerSurfaceCompatible,
          stageAttachedToMainSurface: runtimeVerify.stageAttachedToMainSurface,
          documentOverflow: runtimeVerify.documentOverflow,
          composerOverflow: runtimeVerify.composerOverflow,
        },
      };

      // The runtime selects the legacy work wordmark from the Codex version,
      // so exercise it in a fresh old-shell fixture instead of forcing the
      // semantic data attribute and masking recognition regressions.
      await installThemeOnFixture(page, built, entry.id, "26.700.0");
      const legacyLogos = await auditLogoInteractions(page, ["chatgpt-work"]);

      result.checks = [
        ...base.checks,
        ...currentLogos.checks,
        ...legacyLogos.checks,
        ...composer.checks,
        runtimeCheck,
      ];
      result.pass = result.checks.every((check) => check.pass) && pageErrors.length === 0;
      result.payload = { bytes: built.payloadBytes, assets: built.assetCount, stamp: built.stamp };
      result.assertions = result.checks.length;
    } catch (error) {
      result.error = error?.stack || String(error);
    }

    result.console = consoleMessages;
    result.pageErrors = pageErrors;
    result.durationMs = Date.now() - startedAt;
    if (!result.pass) {
      const screenshotPath = path.join(reportDir, `${safeName(entry.id)}.png`);
      try {
        await page.screenshot({ path: screenshotPath, fullPage: false });
        result.screenshot = screenshotPath;
      } catch (error) {
        result.screenshotError = error.message;
      }
    }
    const resultPath = path.join(reportDir, `${safeName(entry.id)}.json`);
    await fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);

    const failedChecks = result.checks.filter((check) => !check.pass).map((check) => check.name);
    console.log(`[${index + 1}/${total}] ${result.pass ? "PASS" : "FAIL"} ${entry.id} (${result.assertions || 0} checks, ${result.durationMs}ms)${failedChecks.length ? `: ${failedChecks.join("; ")}` : ""}`);
    return result;
  } finally {
    await context.close();
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const themes = await discoverThemes(options);
  if (!themes.length) throw new Error("no themes selected");

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportDir = path.resolve(options.reportDir || path.join(os.tmpdir(), `skin-batch-browser-${timestamp}`));
  await fs.mkdir(reportDir, { recursive: true });

  if (!options.executablePath && await fileExists(defaultChrome)) options.executablePath = defaultChrome;
  const launchOptions = { headless: !options.headed };
  if (options.executablePath) launchOptions.executablePath = options.executablePath;

  console.log(`The flow under test is: sanitized Codex shell fixture -> real theme payload injection -> responsive logos, glyphs, composer states, routes and modal remain usable.`);
  console.log(`Browser plugin not available; using Playwright with ${options.executablePath || "the pinned Chromium"}.`);
  const concurrency = Math.min(options.concurrency, themes.length);
  console.log(`Running ${themes.length} theme(s) in one browser process with ${concurrency} isolated page worker(s). Reports: ${reportDir}`);

  const browser = await chromium.launch(launchOptions);
  const results = new Array(themes.length);
  let nextIndex = 0;
  try {
    const workers = Array.from({ length: concurrency }, async () => {
      while (nextIndex < themes.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await runTheme(browser, themes[index], index, themes.length, reportDir);
      }
    });
    await Promise.all(workers);
  } finally {
    await browser.close();
  }

  const publicResults = results.filter((result) => result.source === "public");
  const extraResults = results.filter((result) => result.source === "extra");
  const summary = {
    generatedAt: new Date().toISOString(),
    flow: "sanitized Codex shell fixture -> real loadTheme/buildPayload injection -> rendered compatibility checks",
    environment: {
      fixture: path.relative(repoRoot, fileURLToPath(fixtureUrl)),
      browser: options.executablePath || "playwright chromium",
      concurrency,
      viewport: { width: 1280, height: 800 },
      colorSchemes: ["dark", "light"],
      sidebarWidths: [240, 280, 340, 420],
      workspaceStates: ["normal", "hover", "focus"],
      fixtureAppVersions: ["26.1002.51308", "26.700.0"],
      composerWidths: [360, 640],
      reducedMotion: true,
    },
    counts: {
      themes: results.length,
      publicThemes: publicResults.length,
      extraThemes: extraResults.length,
      passed: results.filter((result) => result.pass).length,
      failed: results.filter((result) => !result.pass).length,
      assertions: results.reduce((sum, result) => sum + (result.assertions || 0), 0),
    },
    public: publicResults.map(({ id, pass, assertions, durationMs }) => ({ id, pass, assertions, durationMs })),
    extra: extraResults.map(({ id, pass, assertions, durationMs, dir }) => ({ id, pass, assertions, durationMs, dir })),
    failures: results.filter((result) => !result.pass).map((result) => ({
      id: result.id,
      source: result.source,
      error: result.error || null,
      checks: result.checks.filter((check) => !check.pass).map((check) => check.name),
      screenshot: result.screenshot || null,
    })),
  };
  const summaryPath = path.join(reportDir, "summary.json");
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Summary: ${summary.counts.passed}/${summary.counts.themes} themes passed, ${summary.counts.assertions} assertions. ${summaryPath}`);
  if (summary.counts.failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
