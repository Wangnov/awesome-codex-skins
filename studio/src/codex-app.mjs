// Discover, launch and stop the official Codex desktop app with a loopback
// CDP endpoint. Never modifies, unpacks or replaces anything inside the app.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";

const run = promisify(execFile);

export const CODEX_BUNDLE_ID = "com.openai.codex";
export const DEFAULT_PORT = 9345;
export const PORT_SCAN_LIMIT = 100;

export async function discoverCodexApp() {
  const candidates = ["/Applications/Codex.app", `${process.env.HOME}/Applications/Codex.app`];
  for (const bundle of candidates) {
    try {
      const plist = `${bundle}/Contents/Info.plist`;
      await fs.access(plist);
      const { stdout } = await run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plist]);
      if (stdout.trim() === CODEX_BUNDLE_ID) {
        const { stdout: version } = await run("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist]);
        return { bundle, version: version.trim() };
      }
    } catch {
      // keep scanning
    }
  }
  throw new Error("Codex.app (com.openai.codex) was not found in /Applications or ~/Applications");
}

export async function codexMainPids() {
  try {
    const { stdout } = await run("/usr/bin/pgrep", ["-f", "Codex.app/Contents/MacOS/"]);
    return stdout.split("\n").map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0);
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
export async function cdpBelongsToCodex(port) {
  try {
    const { stdout } = await run("/usr/sbin/lsof", ["-iTCP:" + port, "-sTCP:LISTEN", "-P", "-Fpc"]);
    const pids = [...stdout.matchAll(/^p(\d+)$/gm)].map((m) => Number(m[1]));
    if (!pids.length) return false;
    for (const pid of pids) {
      let current = pid;
      for (let hop = 0; hop < 6 && current > 1; hop += 1) {
        try {
          const { stdout: command } = await run("/bin/ps", ["-o", "command=", "-p", String(current)]);
          if (command.includes("Codex.app/Contents/MacOS/")) return true;
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

export async function verifiedCdpEndpoint(port) {
  return (await cdpHttpReady(port)) && (await cdpBelongsToCodex(port));
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

export async function quitCodex({ force = false } = {}) {
  const pids = await codexMainPids();
  if (!pids.length) return true;
  try {
    await run("/usr/bin/osascript", ["-e", `tell application id "${CODEX_BUNDLE_ID}" to quit`]);
  } catch {
    // fall through to signal
  }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (!(await codexMainPids()).length) return true;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  if (!force) return (await codexMainPids()).length === 0;
  for (const pid of await codexMainPids()) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return (await codexMainPids()).length === 0;
}
