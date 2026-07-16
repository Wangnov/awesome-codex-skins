// Studio state lives under ~/Library/Application Support/CodexThemeStudio.
// state.json records the CDP port, the watcher pid and the active theme so
// `use`/`off` can hot-swap themes against the running watcher.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export const STATE_ROOT = path.join(os.homedir(), "Library", "Application Support", "CodexThemeStudio");
export const STATE_PATH = path.join(STATE_ROOT, "state.json");
export const LOG_ROOT = path.join(STATE_ROOT, "logs");
export const WATCHER_LOG = path.join(LOG_ROOT, "watcher.log");
export const WATCHER_ERR = path.join(LOG_ROOT, "watcher.err");

export async function ensureStateRoot() {
  await fs.mkdir(LOG_ROOT, { recursive: true });
}

export async function readState() {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const state = JSON.parse(raw);
    return typeof state === "object" && state ? state : null;
  } catch {
    return null;
  }
}

export async function writeState(patch) {
  await ensureStateRoot();
  const current = (await readState()) ?? {};
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  const tmp = `${STATE_PATH}.tmp-${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await fs.rename(tmp, STATE_PATH);
  return next;
}

export async function clearState() {
  try {
    await fs.rm(STATE_PATH);
  } catch {
    // already gone
  }
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
