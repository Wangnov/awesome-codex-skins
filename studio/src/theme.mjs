// Theme package loader. A theme is a directory under themes/:
//
//   themes/<id>/
//     theme.json    required — metadata, colors, strings, asset map
//     theme.css     required — selectors scoped to html.codex-theme-studio
//     chrome.html   optional — decorative overlay fragment (pointer-events: none)
//     assets/*.png  bitmap assets referenced by theme.json "assets"
//     assets/*.mp4  optional local motion assets referenced by "motionAssets"
//
// Everything is validated and inlined; nothing is fetched at runtime.

import fs from "node:fs/promises";
import path from "node:path";
import { validateCodexTheme } from "./codex-theme-schema.mjs";

export const MAX_ASSET_BYTES = 24 * 1024 * 1024;
export const MAX_TOTAL_ASSET_BYTES = 96 * 1024 * 1024;
const ASSET_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const MOTION_ASSET_EXTENSIONS = new Set([".mp4", ".webm"]);
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const MIME_BY_EXTENSION = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

function assertInside(root, candidate, label) {
  // Absolute paths can point inside the dev checkout and still pack fine, but
  // the manifest ships verbatim — the package must stay relocatable.
  if (path.isAbsolute(candidate)) {
    throw new Error(`${label} must be a relative path inside the theme directory: ${candidate}`);
  }
  const resolved = path.resolve(root, candidate);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} must stay inside the theme directory: ${candidate}`);
  }
  return resolved;
}

export function resolvePreviewPath(themeDir, relative) {
  const segments = typeof relative === "string" ? relative.split("/") : [];
  const isCanonicalPreview = segments.length >= 2
    && segments[0] === "previews"
    && !relative.includes("\\")
    && segments.slice(1).every((segment) => segment && !segment.startsWith("."))
    && path.posix.extname(relative).toLowerCase() === ".webp";
  if (!isCanonicalPreview) {
    throw new Error(`preview must be a WebP below previews/: ${relative}`);
  }

  const previewsRoot = path.resolve(themeDir, "previews");
  return assertInside(previewsRoot, segments.slice(1).join("/"), "preview");
}

export async function inspectPreviewPath(themeDir, relative) {
  const themePath = path.resolve(themeDir);
  const previewPath = resolvePreviewPath(themePath, relative);
  try {
    const [realThemePath, realPreviewPath] = await Promise.all([
      fs.realpath(themePath),
      fs.realpath(previewPath),
    ]);
    const expectedPath = path.resolve(realThemePath, path.relative(themePath, previewPath));
    if (realPreviewPath !== expectedPath) {
      throw new Error(`preview must not escape previews/ through a symbolic link: ${relative}`);
    }
    return { path: previewPath, stat: await fs.stat(realPreviewPath) };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return { path: previewPath, stat: null };
    }
    throw error;
  }
}

const text = (value, fallback, max = 160) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback;

const color = (value, fallback) => {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return /^#[0-9a-f]{3,8}$/i.test(normalized) || /^rgba?\([0-9., %]+\)$/i.test(normalized)
    ? normalized
    : fallback;
};

export async function listThemes(themesRoot) {
  let entries = [];
  try {
    entries = await fs.readdir(themesRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const themes = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const theme = await loadTheme(path.join(themesRoot, entry.name));
      themes.push({ id: theme.config.id, name: theme.config.name, dir: theme.dir });
    } catch {
      // skip invalid theme dirs in listings
    }
  }
  return themes;
}

export async function resolveThemeDir(themesRoot, idOrPath) {
  const direct = path.resolve(idOrPath);
  try {
    await fs.access(path.join(direct, "theme.json"));
    return direct;
  } catch {
    // not a path — fall through to id lookup
  }
  const byId = path.join(themesRoot, idOrPath);
  await fs.access(path.join(byId, "theme.json"));
  return byId;
}

export async function loadTheme(themeDir) {
  const dir = path.resolve(themeDir);
  const raw = JSON.parse(await fs.readFile(path.join(dir, "theme.json"), "utf8"));
  if (raw.schemaVersion !== 2) {
    throw new Error(`theme.json schemaVersion must be 2 (got ${raw.schemaVersion})`);
  }
  const id = text(raw.id, "");
  if (!NAME_PATTERN.test(id)) throw new Error(`theme id must match ${NAME_PATTERN}: ${id}`);

  const config = {
    schemaVersion: 2,
    id,
    name: text(raw.name, id, 80),
    description: text(raw.description, "", 240),
    colors: {},
    strings: {},
  };
  // Optional native Codex theme block, applied to ~/.codex/config.toml by the
  // CLI while Codex is stopped. Old schemaVersion-2 packages without
  // codeThemeIds remain loadable; the delivery gate requires the new fields.
  const codexTheme = raw.codexTheme && typeof raw.codexTheme === "object" ? raw.codexTheme : null;
  if (codexTheme) {
    const problems = validateCodexTheme(codexTheme, { requireCodeThemeIds: false });
    if (problems.length) throw new Error(`invalid codexTheme: ${problems.join("; ")}`);
  }
  for (const [key, value] of Object.entries(raw.colors ?? {})) {
    if (!NAME_PATTERN.test(key)) throw new Error(`invalid color key: ${key}`);
    const validated = color(value, null);
    if (validated) config.colors[key] = validated;
  }
  for (const [key, value] of Object.entries(raw.strings ?? {})) {
    if (!NAME_PATTERN.test(key)) throw new Error(`invalid string key: ${key}`);
    config.strings[key] = text(value, "", 200);
  }

  const cssPath = assertInside(dir, text(raw.css, "theme.css", 120), "css");
  const css = await fs.readFile(cssPath, "utf8");

  let chromeHtml = null;
  if (raw.chrome) {
    const chromePath = assertInside(dir, text(raw.chrome, "chrome.html", 120), "chrome");
    chromeHtml = await fs.readFile(chromePath, "utf8");
  }

  const assets = {};
  let totalBytes = 0;
  for (const [key, relative] of Object.entries(raw.assets ?? {})) {
    if (!NAME_PATTERN.test(key)) throw new Error(`invalid asset key: ${key}`);
    const assetPath = assertInside(dir, String(relative), `asset ${key}`);
    const extension = path.extname(assetPath).toLowerCase();
    if (!ASSET_EXTENSIONS.has(extension)) throw new Error(`unsupported asset format for ${key}: ${extension}`);
    const stat = await fs.stat(assetPath);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_ASSET_BYTES) {
      throw new Error(`asset ${key} must be a non-empty file up to ${MAX_ASSET_BYTES} bytes`);
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_TOTAL_ASSET_BYTES) throw new Error("combined theme assets exceed the size budget");
    assets[key] = { path: assetPath, mime: MIME_BY_EXTENSION[extension], bytes: stat.size };
  }

  // Motion assets are an additive Studio extension. They stay separate from
  // the WebP-only `assets` contract so existing package managers can ignore
  // them and retain the static fallback while this runtime plays the richer
  // version when available.
  const motionAssets = {};
  for (const [key, relative] of Object.entries(raw.motionAssets ?? {})) {
    if (!NAME_PATTERN.test(key)) throw new Error(`invalid motion asset key: ${key}`);
    // The two maps merge into one data-URL namespace downstream; a shared key
    // would let the video silently shadow the static asset's CSS variable.
    if (Object.hasOwn(assets, key)) {
      throw new Error(`motion asset ${key} collides with a static asset of the same name`);
    }
    const assetPath = assertInside(dir, String(relative), `motion asset ${key}`);
    const extension = path.extname(assetPath).toLowerCase();
    if (!MOTION_ASSET_EXTENSIONS.has(extension)) {
      throw new Error(`unsupported motion asset format for ${key}: ${extension}`);
    }
    const stat = await fs.stat(assetPath);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_ASSET_BYTES) {
      throw new Error(`motion asset ${key} must be a non-empty file up to ${MAX_ASSET_BYTES} bytes`);
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_TOTAL_ASSET_BYTES) throw new Error("combined theme assets exceed the size budget");
    motionAssets[key] = { path: assetPath, mime: MIME_BY_EXTENSION[extension], bytes: stat.size };
  }

  return { dir, config, css, chromeHtml, assets, motionAssets, codexTheme };
}

export async function inlineAssets(theme) {
  const dataUrls = {};
  for (const [key, asset] of Object.entries({ ...theme.assets, ...theme.motionAssets })) {
    const buffer = await fs.readFile(asset.path);
    dataUrls[key] = `data:${asset.mime};base64,${buffer.toString("base64")}`;
  }
  return dataUrls;
}
