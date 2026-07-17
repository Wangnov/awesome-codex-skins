#!/usr/bin/env node
// Codex Theme Studio CLI — launch Codex with a loopback CDP endpoint and
// hot-swap asset-based UI themes without touching any app files.
//
//   codex-theme start [--theme <id>] [--port <n>] [--restart-existing]
//   codex-theme use <id>          switch theme (hot, watcher picks it up)
//   codex-theme off               remove theme, keep watcher running
//   codex-theme stop [--quit-codex]
//   codex-theme status
//   codex-theme themes
//   codex-theme verify [--screenshot <path>] [--timeout-ms <n>]
//   codex-theme screenshot <path>
//   codex-theme preview-shot <id> [--name home] [--width 1280] [--height 800]
//   codex-theme pack <id> [--out <dir>]

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  connectCodexTargets, listAppTargets, connectTarget, probeSession, captureScreenshot,
} from "../src/cdp.mjs";
import {
  CodexAppNotFoundError, discoverManagedCodexApp, findRunningCodexApps,
  codexMainPids, verifiedCdpEndpoint, cdpHttpReady,
  selectAvailablePort, launchCodexWithCdp, waitForCdp, quitCodex, DEFAULT_PORT,
} from "../src/codex-app.mjs";
import {
  STATE_PATH, WATCHER_LOG, WATCHER_ERR,
  ensureStateRoot, readState, writeState, processAlive,
} from "../src/state.mjs";
import { buildPayload, REMOVE_EXPRESSION, VERIFY_REMOVED_EXPRESSION, verifyExpression, STUDIO_VERSION } from "../src/payload.mjs";
import { listThemes, resolveThemeDir, loadTheme } from "../src/theme.mjs";
import { applyNativeTheme, restoreNativeTheme, hasBackup } from "../src/native-theme.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(here, "..");
// Skin packages: CODEX_SKINS_ROOT wins; otherwise the repo layout
// (<repo>/skins beside <repo>/studio); otherwise the legacy standalone
// layout (<studio>/themes).
import { existsSync } from "node:fs";
const REPO_SKINS = path.join(PROJECT_ROOT, "..", "skins");
const envSkinsRoot = process.env.CODEX_SKINS_ROOT?.trim();
const THEMES_ROOT =
  envSkinsRoot || (existsSync(REPO_SKINS) ? REPO_SKINS : path.join(PROJECT_ROOT, "themes"));

function parseFlags(argv, spec) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) { flags._.push(arg); continue; }
    const key = arg.slice(2);
    if (!(key in spec)) throw new Error(`Unknown flag: ${arg}`);
    if (spec[key] === Boolean) flags[key] = true;
    else flags[key] = spec[key](argv[++i]);
  }
  return flags;
}

const asPort = (value) => {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`Invalid port: ${value}`);
  return port;
};

const asInt = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid number: ${value}`);
  return n;
};

function out(data) {
  console.log(JSON.stringify(data, null, 2));
}

async function activePort() {
  const state = await readState();
  if (state?.port && (await cdpHttpReady(state.port))) return state.port;
  return null;
}

async function discoverCodexAppIfInstalled(preferredBundle) {
  try {
    return await discoverManagedCodexApp(preferredBundle);
  } catch (error) {
    if (error instanceof CodexAppNotFoundError) return null;
    throw error;
  }
}

async function requireNoRunningCodex(additionalBundle) {
  const running = await findRunningCodexApps({
    additionalBundles: additionalBundle ? [additionalBundle] : [],
  });
  if (running.length > 0) {
    throw new Error(
      `Codex is running from ${running.map((app) => app.bundle).join(", ")} — quit every Codex installation before changing the native theme configuration.`,
    );
  }
}

async function requireNoOtherRunningCodex(selectedApp) {
  const running = await findRunningCodexApps({ additionalBundles: [selectedApp.bundle] });
  const others = running.filter((app) => app.bundle !== selectedApp.bundle);
  if (others.length > 0) {
    throw new Error(
      `Another Codex installation is running from ${others.map((app) => app.bundle).join(", ")} — quit it before changing the native theme configuration.`,
    );
  }
}

async function withSessions(port, timeoutMs, fn) {
  const connected = await connectCodexTargets(port, timeoutMs);
  try {
    return await fn(connected);
  } finally {
    for (const { session } of connected) session.close();
  }
}

async function applyThemeOnce(port, themeDir, timeoutMs) {
  const { payload, theme } = await buildPayload(themeDir);
  return withSessions(port, timeoutMs, async (connected) => {
    const results = [];
    for (const { target, session } of connected) {
      const result = await session.evaluate(payload);
      results.push({ targetId: target.id, url: target.url, result });
    }
    return { theme, targets: results };
  });
}

async function removeThemeOnce(port, timeoutMs) {
  return withSessions(port, timeoutMs, async (connected) => {
    const results = [];
    for (const { target, session } of connected) {
      await session.evaluate(REMOVE_EXPRESSION);
      const removed = await session.evaluate(VERIFY_REMOVED_EXPRESSION);
      results.push({ targetId: target.id, removed });
    }
    return results;
  });
}

// ---------------------------------------------------------------- commands

async function cmdThemes() {
  const themes = await listThemes(THEMES_ROOT);
  const state = await readState();
  out({
    themesRoot: THEMES_ROOT,
    current: state?.currentTheme ?? null,
    themes: themes.map((t) => ({ id: t.id, name: t.name, active: t.id === state?.currentTheme })),
  });
}

async function cmdStatus() {
  const state = await readState();
  const app = await discoverManagedCodexApp(state?.appBundle).catch((error) => ({ error: error.message }));
  const codexPids = app.error ? [] : await codexMainPids(app);
  const port = state?.port ?? null;
  const cdpReady = port ? await cdpHttpReady(port) : false;
  out({
    studioVersion: STUDIO_VERSION,
    app,
    codexRunning: codexPids.length > 0,
    codexPids,
    state: state ?? null,
    cdpReady,
    watcherAlive: processAlive(state?.watcherPid),
    statePath: STATE_PATH,
  });
}

async function cmdStart(argv) {
  const flags = parseFlags(argv, { theme: String, port: asPort, "restart-existing": Boolean, foreground: Boolean, "no-native-theme": Boolean });
  const previousState = await readState();
  const app = await discoverManagedCodexApp(previousState?.appBundle);
  await ensureStateRoot();

  let port = flags.port ?? previousState?.port ?? DEFAULT_PORT;

  // Theme selection: explicit flag wins, otherwise keep the recorded one.
  let currentTheme = previousState?.currentTheme ?? null;
  if (flags.theme) {
    const dir = await resolveThemeDir(THEMES_ROOT, flags.theme);
    currentTheme = path.basename(dir);
  }
  let codexTheme = null;
  if (currentTheme && !flags["no-native-theme"]) {
    try {
      codexTheme = (await loadTheme(await resolveThemeDir(THEMES_ROOT, currentTheme))).codexTheme;
    } catch { /* theme dir missing — ignore */ }
  }

  let ready = await verifiedCdpEndpoint(port, app);
  // Applying a native theme requires a relaunch even if CDP is already up.
  if (ready && codexTheme && flags["restart-existing"]) {
    await requireNoOtherRunningCodex(app);
    if (!(await quitCodex(app, { force: true }))) throw new Error("Could not stop the running Codex app.");
    ready = false;
  }
  if (!ready) {
    const running = (await codexMainPids(app)).length > 0;
    if (running) {
      if (!flags["restart-existing"]) {
        throw new Error("Codex is already running without the studio CDP endpoint. Re-run with --restart-existing to relaunch it.");
      }
      if (codexTheme) await requireNoOtherRunningCodex(app);
      if (!(await quitCodex(app, { force: true }))) throw new Error("Could not stop the running Codex app.");
    }
    // Native theme must be written while Codex is down — it persists its own
    // config on exit and would clobber external edits. The exit write can
    // land shortly AFTER the main pid disappears, so give it a beat first.
    if (codexTheme) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await requireNoRunningCodex(app.bundle);
      await applyNativeTheme(codexTheme);
      console.error("[studio] native Codex theme applied to config.toml (backup kept)");
    }
    port = await selectAvailablePort(port);
    console.error(`[studio] launching ${app.bundle} (v${app.version}) with CDP on 127.0.0.1:${port}`);
    await launchCodexWithCdp(app.bundle, port);
    if (!(await waitForCdp(port))) {
      throw new Error(`Codex did not expose a loopback CDP endpoint on port ${port} within 45s`);
    }
  } else if (codexTheme) {
    console.error("[studio] note: Codex already running — native theme sync needs a relaunch (use --restart-existing)");
  }

  // Replace any previous watcher.
  if (processAlive(previousState?.watcherPid)) {
    try { process.kill(previousState.watcherPid, "SIGTERM"); } catch { /* gone */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  await writeState({
    port,
    currentTheme,
    appBundle: app.bundle,
    appVersion: app.version,
    codexPid: (await codexMainPids(app))[0] ?? null,
  });

  if (flags.foreground) {
    await writeState({ watcherPid: process.pid, watcherStartedAt: new Date().toISOString() });
    return runWatchDaemon(port);
  }

  const logOut = await fs.open(WATCHER_LOG, "a");
  const logErr = await fs.open(WATCHER_ERR, "a");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "watch-daemon", "--port", String(port)], {
    detached: true,
    stdio: ["ignore", logOut.fd, logErr.fd],
    cwd: PROJECT_ROOT,
  });
  child.unref();
  await logOut.close();
  await logErr.close();
  await new Promise((resolve) => setTimeout(resolve, 600));
  if (!processAlive(child.pid)) throw new Error(`Watcher exited during startup — see ${WATCHER_ERR}`);
  await writeState({ watcherPid: child.pid, watcherStartedAt: new Date().toISOString() });

  out({ ok: true, port, theme: currentTheme, watcherPid: child.pid, log: WATCHER_LOG });
}

async function cmdUse(argv) {
  const flags = parseFlags(argv, { "timeout-ms": asInt });
  const id = flags._[0];
  if (!id) throw new Error("Usage: codex-theme use <theme-id>");
  const dir = await resolveThemeDir(THEMES_ROOT, id);
  const themeId = path.basename(dir);
  await writeState({ currentTheme: themeId });

  const port = await activePort();
  if (!port) {
    out({ ok: true, theme: themeId, applied: false, note: "Theme recorded. Run `codex-theme start` to launch Codex with the studio endpoint." });
    return;
  }
  const result = await applyThemeOnce(port, dir, flags["timeout-ms"] ?? 15000);
  out({ ok: true, theme: themeId, applied: true, targets: result.targets.map((t) => t.result) });
}

async function cmdOff(argv) {
  const flags = parseFlags(argv, { "timeout-ms": asInt });
  await writeState({ currentTheme: null });
  const port = await activePort();
  if (!port) {
    out({ ok: true, applied: false, note: "No live CDP endpoint; theme cleared from state." });
    return;
  }
  const results = await removeThemeOnce(port, flags["timeout-ms"] ?? 10000);
  out({ ok: true, removed: results });
}

async function cmdStop(argv) {
  const flags = parseFlags(argv, { "quit-codex": Boolean });
  const state = await readState();
  if (processAlive(state?.watcherPid)) {
    try { process.kill(state.watcherPid, "SIGTERM"); } catch { /* gone */ }
  }
  const port = state?.port;
  if (port && (await cdpHttpReady(port))) {
    try { await removeThemeOnce(port, 6000); } catch { /* renderer may be gone */ }
  }
  await writeState({ watcherPid: null });
  let codexStopped = null;
  let nativeRestored = null;
  if (flags["quit-codex"]) {
    const app = await discoverCodexAppIfInstalled(state?.appBundle);
    codexStopped = app ? await quitCodex(app, { force: false }) : true;
    // With Codex down we can safely put the user's appearance config back.
    if (codexStopped && (await hasBackup())) {
      await requireNoRunningCodex(state?.appBundle);
      nativeRestored = await restoreNativeTheme();
    }
  }
  out({ ok: true, watcherStopped: true, codexStopped, nativeRestored });
}

async function cmdRestoreConfig() {
  const state = await readState();
  await requireNoRunningCodex(state?.appBundle);
  const restored = await restoreNativeTheme();
  out({ ok: true, restored, note: restored ? "config.toml appearance sections restored from backup" : "no backup to restore" });
}

async function cmdVerify(argv) {
  const flags = parseFlags(argv, { screenshot: String, "timeout-ms": asInt, theme: String });
  const state = await readState();
  const port = await activePort();
  if (!port) throw new Error("No live CDP endpoint. Run `codex-theme start` first.");
  const timeoutMs = flags["timeout-ms"] ?? 20000;

  await withSessions(port, timeoutMs, async (connected) => {
    const results = [];
    let screenshotSaved = null;
    for (const { target, session } of connected) {
      const deadline = Date.now() + timeoutMs;
      let result;
      while (Date.now() < deadline) {
        result = await session.evaluate(verifyExpression());
        if (result.pass) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      results.push({ targetId: target.id, url: target.url, result });
      if (flags.screenshot && !screenshotSaved) {
        const buffer = await captureScreenshot(session);
        const target_path = path.resolve(flags.screenshot);
        await fs.mkdir(path.dirname(target_path), { recursive: true });
        await fs.writeFile(target_path, buffer);
        screenshotSaved = target_path;
      }
    }
    const pass = results.length > 0 && results.every((item) => item.result?.pass);
    out({ pass, expectedTheme: state?.currentTheme ?? null, screenshot: screenshotSaved, targets: results });
    if (!pass) process.exitCode = 2;
  });
}

async function cmdScreenshot(argv) {
  const flags = parseFlags(argv, { "timeout-ms": asInt });
  const output = flags._[0];
  if (!output) throw new Error("Usage: codex-theme screenshot <path>");
  const port = await activePort();
  if (!port) throw new Error("No live CDP endpoint. Run `codex-theme start` first.");
  await withSessions(port, flags["timeout-ms"] ?? 15000, async (connected) => {
    const buffer = await captureScreenshot(connected[0].session);
    const target = path.resolve(output);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buffer);
    out({ ok: true, screenshot: target });
  });
}

// ------------------------------------------------------- delivery (P1.5 spec)

// Standard preview screenshot: home route, intro gone, fixed 1280×800 frame,
// WebP output registered in theme.json `previews`. The sidebar tidy-up
// (collapse projects/tasks/pinned sections) is the CALLER's job before
// running this — the DOM controls are too version-fragile to hard-code here.
async function cmdPreviewShot(argv) {
  const flags = parseFlags(argv, { name: String, width: asInt, height: asInt, "timeout-ms": asInt });
  const id = flags._[0];
  if (!id) throw new Error("Usage: codex-theme preview-shot <theme-id> [--name home]");
  const dir = await resolveThemeDir(THEMES_ROOT, id);
  const width = flags.width ?? 1280;
  const height = flags.height ?? 800;
  const name = flags.name ?? "home";
  const timeoutMs = flags["timeout-ms"] ?? 20000;

  const port = await activePort();
  if (!port) throw new Error("No live CDP endpoint. Run `codex-theme start --theme <id>` first.");

  await withSessions(port, timeoutMs, async (connected) => {
    const { session } = connected[0];

    // The theme under shoot must actually be applied to this renderer.
    const verify = await session.evaluate(verifyExpression());
    if (!verify?.installed || verify?.themeId !== path.basename(dir)) {
      throw new Error(`Theme ${path.basename(dir)} is not applied (run \`codex-theme use ${id}\`).`);
    }
    // Home route, and let the intro finish before framing.
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = await session.evaluate(
        `({ home: Boolean(document.querySelector('.cts-home')), intro: Boolean(document.getElementById('cts-intro')) })`,
      );
      if (state.home && !state.intro) break;
      if (!state.home) throw new Error("Renderer is not on the home route — navigate home, tidy the sidebar, retry.");
      if (Date.now() > deadline) throw new Error("Intro overlay never settled.");
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    // 2× capture, downscaled by Pillow for a crisp 1280×800 WebP.
    await session.send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: 2, mobile: false,
    });
    let pngBuffer;
    try {
      pngBuffer = await captureScreenshot(session, 600);
    } finally {
      await session.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    }

    const previewsDir = path.join(dir, "previews");
    await fs.mkdir(previewsDir, { recursive: true });
    const tmpPng = path.join(previewsDir, `.${name}-shot.png`);
    const outWebp = path.join(previewsDir, `${name}.webp`);
    await fs.writeFile(tmpPng, pngBuffer);
    try {
      await execPython([
        "-c",
        [
          "import sys",
          "from PIL import Image",
          "src, dst, w, h = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])",
          "im = Image.open(src).convert('RGB')",
          "im = im.resize((w, h), Image.LANCZOS) if im.size != (w, h) else im",
          "im.save(dst, 'WEBP', quality=85, method=6)",
        ].join("\n"),
        tmpPng, outWebp, String(width), String(height),
      ]);
    } finally {
      await fs.rm(tmpPng, { force: true });
    }

    // Register in theme.json previews (idempotent; cover slot for `home`).
    const manifestPath = path.join(dir, "theme.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const rel = `previews/${name}.webp`;
    const previews = Array.isArray(manifest.previews) ? manifest.previews : [];
    if (!previews.includes(rel)) {
      if (name === "home") previews.unshift(rel);
      else previews.push(rel);
      manifest.previews = previews;
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    }
    const stat = await fs.stat(outWebp);
    out({
      ok: true, preview: outWebp, bytes: stat.size,
      warning: stat.size > 500 * 1024 ? "preview exceeds the 500KB recommendation" : null,
      previews: manifest.previews ?? previews,
    });
  });
}

function execPython(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", args, { stdio: ["ignore", "inherit", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`python3 exited ${code}: ${stderr.trim()}`));
    });
  });
}

// Delivery gate + archive. Strict where the loader is lenient: a pack must
// carry version + at least one existing preview, and the id must match its
// directory. Output: dist/<id>-<version>.codexskin with theme.json at the
// zip root (installers place by manifest id, not by folder name).
async function cmdPack(argv) {
  const flags = parseFlags(argv, { out: String });
  const id = flags._[0];
  if (!id) throw new Error("Usage: codex-theme pack <theme-id> [--out <dir>]");
  const dir = await resolveThemeDir(THEMES_ROOT, id);
  const theme = await loadTheme(dir); // full structural validation
  const manifest = JSON.parse(await fs.readFile(path.join(dir, "theme.json"), "utf8"));

  const problems = [];
  if (path.basename(dir) !== theme.config.id) {
    problems.push(`directory name (${path.basename(dir)}) != theme id (${theme.config.id})`);
  }
  const version = typeof manifest.version === "string" && manifest.version.trim();
  if (!version) problems.push("missing `version` (semver) in theme.json");
  const previews = Array.isArray(manifest.previews) ? manifest.previews : [];
  if (!previews.length) {
    problems.push("missing `previews` — run `codex-theme preview-shot <id>` first");
  }
  for (const rel of previews) {
    const stat = await fs.stat(path.join(dir, rel)).catch(() => null);
    if (!stat?.isFile()) problems.push(`preview not found: ${rel}`);
    else if (stat.size > 1024 * 1024) problems.push(`preview over 1MB hard cap: ${rel}`);
  }
  if (!manifest.codexVerified) {
    problems.push("missing `codexVerified` — record the Codex version you verified against");
  }
  if (problems.length) {
    out({ ok: false, problems });
    process.exitCode = 2;
    return;
  }

  const outDir = path.resolve(flags.out ?? path.join(PROJECT_ROOT, "dist"));
  await fs.mkdir(outDir, { recursive: true });
  const archive = path.join(outDir, `${theme.config.id}-${version}.codexskin`);
  await fs.rm(archive, { force: true });
  await new Promise((resolve, reject) => {
    const child = spawn("zip", ["-r", "-X", "-q", archive, ".", "-x", ".*", "-x", "*/.*"], {
      cwd: dir, stdio: ["ignore", "inherit", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`zip exited ${code}: ${stderr.trim()}`));
    });
  });
  const stat = await fs.stat(archive);
  out({ ok: true, archive, bytes: stat.size, id: theme.config.id, version, previews });
}

// ------------------------------------------------------------- watch daemon

async function runWatchDaemon(port) {
  process.title = "codex-theme-watcher";
  const sessions = new Map(); // targetId → { session, appliedStamp }
  let payloadCache = null; // { themeId, payload }
  let lastStateMtime = 0;
  let currentTheme = (await readState())?.currentTheme ?? null;
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const log = (message) => console.log(`[watcher] ${new Date().toISOString()} ${message}`);

  const loadPayloadFor = async (themeId) => {
    if (!themeId) return null;
    if (payloadCache?.themeId === themeId) return payloadCache.payload;
    const dir = await resolveThemeDir(THEMES_ROOT, themeId);
    const { payload } = await buildPayload(dir);
    payloadCache = { themeId, payload };
    log(`payload built for theme ${themeId} (${payload.length} chars)`);
    return payload;
  };

  const applyTo = async (entry, targetId) => {
    try {
      if (currentTheme) {
        const payload = await loadPayloadFor(currentTheme);
        await entry.session.evaluate(payload);
        entry.appliedStamp = `${STUDIO_VERSION}:${currentTheme}`;
      } else if (entry.appliedStamp) {
        await entry.session.evaluate(REMOVE_EXPRESSION);
        entry.appliedStamp = null;
      }
    } catch (error) {
      log(`apply failed for ${targetId}: ${error.message}`);
    }
  };

  log(`watching 127.0.0.1:${port} (theme: ${currentTheme ?? "none"})`);
  while (!stopping) {
    // Hot theme switch: state.json is the single source of truth.
    try {
      const stat = await fs.stat(STATE_PATH);
      if (stat.mtimeMs !== lastStateMtime) {
        lastStateMtime = stat.mtimeMs;
        payloadCache = null; // theme files may have changed on disk
        const state = await readState();
        const nextTheme = state?.currentTheme ?? null;
        if (nextTheme !== currentTheme) {
          log(`theme switch: ${currentTheme ?? "none"} → ${nextTheme ?? "none"}`);
          currentTheme = nextTheme;
          for (const [targetId, entry] of sessions) await applyTo(entry, targetId);
        }
      }
    } catch {
      // state file missing — keep last known theme
    }

    let targets = [];
    try {
      targets = await listAppTargets(port);
    } catch (error) {
      log(`target list failed: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      continue;
    }

    const activeIds = new Set(targets.map((target) => target.id));
    for (const [id, entry] of sessions) {
      if (!activeIds.has(id) || entry.session.closed) {
        entry.session.close();
        sessions.delete(id);
      }
    }

    for (const target of targets) {
      if (sessions.has(target.id)) continue;
      let session;
      try {
        session = await connectTarget(target, port);
        const probe = await probeSession(session);
        if (!probe?.codex) { session.close(); continue; }
        const entry = { session, appliedStamp: null };
        session.on("Page.loadEventFired", () => {
          setTimeout(() => {
            entry.appliedStamp = null;
            applyTo(entry, target.id);
          }, 300);
        });
        sessions.set(target.id, entry);
        await applyTo(entry, target.id);
        log(`connected target ${target.id} (${target.title || target.url})`);
      } catch (error) {
        session?.close();
        log(`connect failed for ${target.id}: ${error.message}`);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 900));
  }

  for (const { session } of sessions.values()) session.close();
  log("stopped");
}

// ----------------------------------------------------------------- dispatch

const [command, ...rest] = process.argv.slice(2);
try {
  switch (command) {
    case "start": await cmdStart(rest); break;
    case "use": await cmdUse(rest); break;
    case "off": await cmdOff(rest); break;
    case "stop": await cmdStop(rest); break;
    case "restore-config": await cmdRestoreConfig(); break;
    case "status": await cmdStatus(); break;
    case "themes": await cmdThemes(); break;
    case "verify": await cmdVerify(rest); break;
    case "screenshot": await cmdScreenshot(rest); break;
    case "preview-shot": await cmdPreviewShot(rest); break;
    case "pack": await cmdPack(rest); break;
    case "watch-daemon": {
      const flags = parseFlags(rest, { port: asPort });
      await runWatchDaemon(flags.port ?? DEFAULT_PORT);
      break;
    }
    default:
      console.error("Usage: codex-theme <start|use|off|stop|status|themes|verify|screenshot> [flags]");
      process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  console.error(`[codex-theme] ${error.message}`);
  process.exitCode = 1;
}
