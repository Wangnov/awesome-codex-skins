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

function chromeThemeToToml(sectionName, theme) {
  const lines = [`[desktop.${sectionName}]`];
  for (const key of ["accent", "contrast", "ink", "opaqueWindows", "surface"]) {
    if (theme[key] === undefined) continue;
    const value = typeof theme[key] === "string" ? tomlString(theme[key]) : theme[key];
    lines.push(`${key} = ${value}`);
  }
  if (theme.fonts) {
    lines.push("", `[desktop.${sectionName}.fonts]`);
    for (const [key, value] of Object.entries(theme.fonts)) lines.push(`${key} = ${tomlString(value)}`);
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
  const themeLine = text.match(/^appearanceTheme\s*=\s*.*$/m);
  backup.appearanceTheme = themeLine ? themeLine[0] : null;
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
    const line = `appearanceTheme = ${tomlString(codexTheme.appearanceTheme)}`;
    if (/^appearanceTheme\s*=/m.test(text)) {
      text = text.replace(/^appearanceTheme\s*=\s*.*$/m, line);
    } else {
      // Top-level keys must sit before the first TOML table; a config with no
      // appearanceTheme yet still has to end up with the requested value.
      const firstSection = text.match(/^\[/m);
      text = firstSection
        ? `${text.slice(0, firstSection.index)}${line}\n${text.slice(firstSection.index)}`
        : `${text.trimEnd()}\n${line}\n`;
    }
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
  if (backup.appearanceTheme) {
    text = /^appearanceTheme\s*=/m.test(text)
      ? text.replace(/^appearanceTheme\s*=\s*.*$/m, backup.appearanceTheme)
      : text;
  } else {
    // The pristine baseline had no appearanceTheme — drop the one we inserted.
    text = text.replace(/^appearanceTheme\s*=\s*.*\n?/m, "");
  }
  const tmp = `${CONFIG_PATH}.cts-tmp`;
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, CONFIG_PATH);
  await fs.rm(BACKUP_PATH);
  return true;
}
