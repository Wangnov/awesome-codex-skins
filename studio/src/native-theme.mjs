// Native Codex theme sync: a theme package may carry a `codexTheme` block
// that maps onto ~/.codex/config.toml's [desktop.appearance*ChromeTheme]
// sections plus the appearanceTheme switch. We only ever touch those exact
// sections, always snapshot the originals first, and only write while Codex
// is NOT running (it persists its in-memory config on exit and would clobber
// external edits).

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { STATE_ROOT } from "./state.mjs";

export const CONFIG_PATH = path.join(os.homedir(), ".codex", "config.toml");
export const BACKUP_PATH = path.join(STATE_ROOT, "native-theme-backup.json");

const SECTION_PREFIXES = [
  "desktop.appearanceDarkChromeTheme",
  "desktop.appearanceLightChromeTheme",
];

function findSections(text, prefix) {
  // A section spans from its [header] line to the line before the next [header].
  const lines = text.split("\n");
  const sections = [];
  let current = null;
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index].match(/^\[([^\]]+)\]\s*$/);
    if (header) {
      if (current) { current.endLine = index; sections.push(current); current = null; }
      if (header[1] === prefix || header[1].startsWith(`${prefix}.`)) {
        current = { startLine: index, endLine: lines.length };
      }
    }
  }
  if (current) sections.push(current);
  return { lines, sections };
}

function stripSections(text, prefix) {
  const { lines, sections } = findSections(text, prefix);
  if (!sections.length) return { text, removed: "" };
  const keep = [];
  const removed = [];
  const cut = new Set();
  for (const section of sections) {
    for (let i = section.startLine; i < section.endLine; i += 1) cut.add(i);
  }
  lines.forEach((line, index) => (cut.has(index) ? removed.push(line) : keep.push(line)));
  return { text: keep.join("\n"), removed: removed.join("\n") };
}

const tomlString = (value) => {
  const raw = String(value);
  return raw.includes('"') ? `'${raw}'` : `"${raw}"`;
};

// Codex reads appearanceTheme from the [desktop] table; stray top-level
// copies exist in older configs and must be left untouched.
function desktopSpan(text) {
  const header = text.match(/^\[desktop\]\s*$/m);
  if (!header) return null;
  const bodyStart = header.index + header[0].length;
  const next = text.slice(bodyStart).match(/^\[/m);
  return { bodyStart, bodyEnd: next ? bodyStart + next.index : text.length };
}

function desktopAppearanceLine(text) {
  const span = desktopSpan(text);
  if (!span) return null;
  const match = text.slice(span.bodyStart, span.bodyEnd).match(/^appearanceTheme\s*=\s*.*$/m);
  return match ? match[0] : null;
}

// Replace, insert or (line === null) delete appearanceTheme inside [desktop].
function setDesktopAppearance(text, line) {
  const span = desktopSpan(text);
  if (span) {
    const body = text.slice(span.bodyStart, span.bodyEnd);
    if (/^appearanceTheme\s*=/m.test(body)) {
      const newBody = line === null
        ? body.replace(/^appearanceTheme\s*=\s*.*\n?/m, "")
        : body.replace(/^appearanceTheme\s*=\s*.*$/m, line);
      return text.slice(0, span.bodyStart) + newBody + text.slice(span.bodyEnd);
    }
    if (line === null) return text;
    return `${text.slice(0, span.bodyStart)}\n${line}${text.slice(span.bodyStart)}`;
  }
  if (line === null) return text;
  // No [desktop] table yet — create it before the first desktop.* subtable
  // (defining [desktop] after [desktop.x] would re-define the table).
  const sub = text.match(/^\[desktop\./m);
  const block = `[desktop]\n${line}\n`;
  return sub
    ? `${text.slice(0, sub.index)}${block}\n${text.slice(sub.index)}`
    : `${text.trimEnd()}\n\n${block}`;
}

function chromeThemeToToml(sectionName, theme) {
  const lines = [`[desktop.${sectionName}]`];
  for (const key of ["accent", "contrast", "ink", "opaqueWindows", "surface"]) {
    if (theme[key] === undefined) continue;
    const value = typeof theme[key] === "string" ? tomlString(theme[key]) : theme[key];
    lines.push(`${key} = ${value}`);
  }
  if (theme.fonts) {
    lines.push("", `[desktop.${sectionName}.fonts]`);
    for (const [key, value] of Object.entries(theme.fonts)) {
      // null/omitted = keep the Codex default font — never write "null".
      if (value == null) continue;
      lines.push(`${key} = ${tomlString(value)}`);
    }
  }
  if (theme.semanticColors) {
    lines.push("", `[desktop.${sectionName}.semanticColors]`);
    for (const [key, value] of Object.entries(theme.semanticColors)) lines.push(`${key} = ${tomlString(value)}`);
  }
  return lines.join("\n");
}

async function readConfig() {
  return fs.readFile(CONFIG_PATH, "utf8");
}

export async function hasBackup() {
  try { await fs.access(BACKUP_PATH); return true; } catch { return false; }
}

// Snapshot current appearance sections once. An existing backup is the real
// user baseline — never overwrite it with themed state.
export async function backupNativeTheme() {
  if (await hasBackup()) return false;
  const text = await readConfig();
  const backup = { savedAt: new Date().toISOString(), sections: {}, appearanceTheme: null };
  for (const prefix of SECTION_PREFIXES) {
    backup.sections[prefix] = stripSections(text, prefix).removed;
  }
  backup.appearanceTheme = desktopAppearanceLine(text);
  await fs.mkdir(path.dirname(BACKUP_PATH), { recursive: true });
  await fs.writeFile(BACKUP_PATH, `${JSON.stringify(backup, null, 2)}\n`, "utf8");
  return true;
}

export async function applyNativeTheme(codexTheme) {
  if (!codexTheme || typeof codexTheme !== "object") return false;
  await backupNativeTheme();
  let text = await readConfig();

  for (const [variant, prefix] of [["dark", SECTION_PREFIXES[0]], ["light", SECTION_PREFIXES[1]]]) {
    const themeBlock = codexTheme[variant];
    if (!themeBlock) continue;
    const sectionName = prefix.replace("desktop.", "");
    ({ text } = stripSections(text, prefix));
    text = `${text.trimEnd()}\n\n${chromeThemeToToml(sectionName, themeBlock)}\n`;
  }

  if (typeof codexTheme.appearanceTheme === "string") {
    text = setDesktopAppearance(text, `appearanceTheme = ${tomlString(codexTheme.appearanceTheme)}`);
  }

  const tmp = `${CONFIG_PATH}.cts-tmp`;
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, CONFIG_PATH);
  return true;
}

export async function restoreNativeTheme() {
  if (!(await hasBackup())) return false;
  const backup = JSON.parse(await fs.readFile(BACKUP_PATH, "utf8"));
  let text = await readConfig();
  for (const prefix of SECTION_PREFIXES) {
    ({ text } = stripSections(text, prefix));
    const original = backup.sections?.[prefix];
    if (original && original.trim()) text = `${text.trimEnd()}\n\n${original.trim()}\n`;
  }
  // Symmetric with apply: restore the pristine [desktop] value, or drop the
  // key we inserted when the baseline had none.
  text = setDesktopAppearance(text, backup.appearanceTheme || null);
  const tmp = `${CONFIG_PATH}.cts-tmp`;
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, CONFIG_PATH);
  await fs.rm(BACKUP_PATH);
  return true;
}
