// Discover, launch and stop the official Codex desktop app with a loopback
// CDP endpoint. Never modifies, unpacks or replaces anything inside the app.

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import fs from "node:fs/promises";

const run = promisify(execFile);

export const CODEX_BUNDLE_ID = "com.openai.codex";
export const DEFAULT_PORT = 9345;
export const PORT_SCAN_LIMIT = 100;

export class CodexAppNotFoundError extends Error {}

export function standardBundlePaths(env = process.env) {
  const roots = ["/Applications"];
  if (env.HOME) roots.push(path.join(env.HOME, "Applications"));
  return roots.flatMap((root) => ["Codex.app", "ChatGPT.app"].map((name) => path.join(root, name)));
}

export function candidateBundlePaths(env = process.env) {
  const override = env.CODEX_APP_PATH?.trim();
  if (override) return [path.resolve(override)];
  return standardBundlePaths(env);
}

async function readPlistString(plist, key) {
  const { stdout } = await run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist]);
  const value = stdout.trim();
  if (!value) throw new Error(`${key} is empty`);
  return value;
}

export async function inspectCodexApp(bundle) {
  const resolvedBundle = await fs.realpath(bundle);
  const plist = path.join(resolvedBundle, "Contents", "Info.plist");
  await fs.access(plist);
  const bundleId = await readPlistString(plist, "CFBundleIdentifier");
  if (bundleId !== CODEX_BUNDLE_ID) return null;

  const [version, executableName] = await Promise.all([
    readPlistString(plist, "CFBundleShortVersionString"),
    readPlistString(plist, "CFBundleExecutable"),
  ]);
  const executable = path.join(resolvedBundle, "Contents", "MacOS", executableName);
  await fs.access(executable);
  return { bundle: resolvedBundle, bundleId, executable, version };
}

export async function discoverCodexApp({
  env = process.env,
  candidates = candidateBundlePaths(env),
  inspect = inspectCodexApp,
  findPids = codexMainPids,
} = {}) {
  const override = env.CODEX_APP_PATH?.trim();
  const apps = [];
  for (const bundle of candidates) {
    try {
      const app = await inspect(bundle);
      if (app) {
        apps.push(app);
        if (override) return app;
        continue;
      }
      if (override) {
        throw new Error(`${bundle} has a different CFBundleIdentifier (expected ${CODEX_BUNDLE_ID})`);
      }
    } catch (error) {
      if (override) {
        throw new Error(`CODEX_APP_PATH does not point to the Codex app: ${error.message}`, { cause: error });
      }
      // keep scanning
    }
  }
  if (apps.length === 1) return apps[0];
  if (apps.length > 1) {
    const running = [];
    for (const app of apps) {
      if ((await findPids(app)).length > 0) running.push(app);
    }
    if (running.length === 1) return running[0];
    throw new Error(
      `Multiple Codex app installations were found; set CODEX_APP_PATH to the one Studio should manage: ${apps.map((app) => app.bundle).join(", ")}`,
    );
  }
  throw new CodexAppNotFoundError(
    "Codex app (com.openai.codex) was not found as Codex.app or ChatGPT.app in /Applications or ~/Applications",
  );
}

export async function discoverManagedCodexApp(preferredBundle, {
  env = process.env,
  inspect = inspectCodexApp,
  ...options
} = {}) {
  // An explicit override always wins. Otherwise reuse the exact identity-gated
  // bundle selected by `start`, including nonstandard install locations.
  if (!env.CODEX_APP_PATH?.trim() && preferredBundle) {
    try {
      const app = await inspect(preferredBundle);
      if (app) return app;
    } catch {
      // The stored bundle moved or disappeared; fall back to normal discovery.
    }
  }
  return discoverCodexApp({ env, inspect, ...options });
}

export function parseRunningAppBundlePaths(stdout) {
  const bundles = new Set();
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*\d+\s+(.+?)\s*$/);
    if (!match) continue;
    const executable = match[1];
    const appMatch = executable.match(/^(.*\.app)\/Contents\/MacOS\/[^/]+$/);
    if (appMatch) bundles.add(appMatch[1]);
  }
  return [...bundles];
}

export async function runningAppBundlePaths() {
  try {
    const { stdout } = await run("/bin/ps", ["-axo", "pid=,comm="]);
    return parseRunningAppBundlePaths(stdout);
  } catch {
    return [];
  }
}

export async function findRunningCodexApps({
  env = process.env,
  additionalBundles = [],
  inspect = inspectCodexApp,
  findPids = codexMainPids,
  findRunningBundles = runningAppBundlePaths,
} = {}) {
  const override = env.CODEX_APP_PATH?.trim();
  const candidates = [
    ...(override ? [path.resolve(override)] : []),
    ...additionalBundles.filter(Boolean),
    ...standardBundlePaths(env),
    ...(await findRunningBundles()),
  ];
  const apps = new Map();
  for (const bundle of candidates) {
    try {
      const app = await inspect(bundle);
      if (app) apps.set(app.bundle, app);
    } catch {
      // Missing or unreadable candidates cannot be running from this path.
    }
  }

  const running = [];
  for (const app of apps.values()) {
    const pids = await findPids(app);
    if (pids.length > 0) running.push({ ...app, pids });
  }
  return running;
}

export function commandBelongsToApp(command, app) {
  return command === app.executable || command.startsWith(`${app.executable} `);
}

export function parseMainProcessTable(stdout, app) {
  const pids = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match || match[2].trim() !== app.executable) continue;
    const pid = Number(match[1]);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

export async function codexMainPids(app) {
  try {
    // macOS pgrep can expose only the process name for Electron's main app and
    // miss an otherwise visible argv[0]. `ps comm` consistently returns the
    // concrete executable path without the potentially huge argument list.
    const { stdout } = await run("/bin/ps", ["-axo", "pid=,comm="]);
    return parseMainProcessTable(stdout, app);
  } catch {
    return [];
  }
}

export async function cdpHttpReady(port) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal });
    if (!response.ok) return false;
    const body = await response.json();
    return typeof body?.webSocketDebuggerUrl === "string" || typeof body?.Browser === "string";
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// The CDP port must belong to a Codex process (or a descendant), not an
// arbitrary local Chromium listener.
export async function cdpBelongsToCodex(port, app) {
  try {
    const { stdout } = await run("/usr/sbin/lsof", ["-iTCP:" + port, "-sTCP:LISTEN", "-P", "-Fpc"]);
    const pids = [...stdout.matchAll(/^p(\d+)$/gm)].map((m) => Number(m[1]));
    if (!pids.length) return false;
    for (const pid of pids) {
      let current = pid;
      for (let hop = 0; hop < 6 && current > 1; hop += 1) {
        try {
          const { stdout: command } = await run("/bin/ps", ["-o", "command=", "-p", String(current)]);
          if (commandBelongsToApp(command.trim(), app)) return true;
          const { stdout: parent } = await run("/bin/ps", ["-o", "ppid=", "-p", String(current)]);
          current = Number(parent.trim());
        } catch {
          break;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

export async function verifiedCdpEndpoint(port, app) {
  return (await cdpHttpReady(port)) && (await cdpBelongsToCodex(port, app));
}

export async function portIsFree(port) {
  try {
    const { stdout } = await run("/usr/sbin/lsof", ["-iTCP:" + port, "-sTCP:LISTEN", "-P", "-t"]);
    return stdout.trim() === "";
  } catch {
    return true; // lsof exits 1 when nothing matches
  }
}

export async function selectAvailablePort(startPort) {
  for (let port = startPort; port < startPort + PORT_SCAN_LIMIT; port += 1) {
    if (await portIsFree(port)) return port;
  }
  throw new Error(`No free loopback port found in ${startPort}..${startPort + PORT_SCAN_LIMIT}`);
}

export async function launchCodexWithCdp(bundle, port) {
  await run("/usr/bin/open", [
    "-na", bundle, "--args",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
  ]);
}

export async function waitForCdp(port, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdpHttpReady(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function applescriptQuote(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export async function quitCodex(app, { force = false } = {}) {
  const pids = await codexMainPids(app);
  if (!pids.length) return true;
  try {
    await run("/usr/bin/osascript", ["-e", `tell application "${applescriptQuote(app.bundle)}" to quit`]);
  } catch {
    // fall through to signal
  }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (!(await codexMainPids(app)).length) return true;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  if (!force) return (await codexMainPids(app)).length === 0;
  for (const pid of await codexMainPids(app)) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return (await codexMainPids(app)).length === 0;
}
