#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const MAX_DATA_URL_CHARS = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 96 * 1024 * 1024;
const ASSET_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: audit-theme.mjs <theme-dir> [--forbid token,token,...] [--json]");
  process.exit(2);
}

function parseArgs(argv) {
  const result = { themeDir: null, forbid: [], json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") result.json = true;
    else if (arg === "--forbid") {
      const value = argv[++i];
      if (!value) usage("--forbid requires a comma-separated value");
      result.forbid.push(...value.split(",").map((item) => item.trim()).filter(Boolean));
    } else if (arg.startsWith("--")) usage(`Unknown option: ${arg}`);
    else if (!result.themeDir) result.themeDir = arg;
    else usage(`Unexpected argument: ${arg}`);
  }
  if (!result.themeDir) usage();
  return result;
}

function unique(values) {
  return [...new Set(values)];
}

function stripCssNoise(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "");
}

function checkBraces(css) {
  const clean = stripCssNoise(css);
  let depth = 0;
  let minDepth = 0;
  for (const char of clean) {
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    minDepth = Math.min(minDepth, depth);
  }
  return { depth, minDepth };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const themeDir = path.resolve(args.themeDir);
  const themePath = path.join(themeDir, "theme.json");
  const errors = [];
  const warnings = [];

  let raw;
  try {
    raw = JSON.parse(await fs.readFile(themePath, "utf8"));
  } catch (error) {
    errors.push(`theme.json cannot be read: ${error.message}`);
    return report({ themeDir, errors, warnings }, args.json);
  }

  if (raw.schemaVersion !== 2) errors.push(`schemaVersion must be 2 (got ${raw.schemaVersion})`);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(raw.id ?? "")) errors.push(`invalid theme id: ${raw.id ?? "<missing>"}`);
  if (raw.id && path.basename(themeDir) !== raw.id) warnings.push(`directory name ${path.basename(themeDir)} differs from theme id ${raw.id}`);

  const cssRelative = typeof raw.css === "string" ? raw.css : "theme.css";
  const cssPath = path.resolve(themeDir, cssRelative);
  let css = "";
  if (cssPath !== themeDir && !cssPath.startsWith(`${themeDir}${path.sep}`)) errors.push(`css escapes theme directory: ${cssRelative}`);
  else {
    try { css = await fs.readFile(cssPath, "utf8"); }
    catch (error) { errors.push(`CSS cannot be read: ${error.message}`); }
  }

  let chrome = "";
  if (raw.chrome) {
    const chromePath = path.resolve(themeDir, String(raw.chrome));
    if (chromePath !== themeDir && !chromePath.startsWith(`${themeDir}${path.sep}`)) errors.push(`chrome escapes theme directory: ${raw.chrome}`);
    else {
      try { chrome = await fs.readFile(chromePath, "utf8"); }
      catch (error) { errors.push(`chrome cannot be read: ${error.message}`); }
    }
  }

  const activeThemeCode = `${css.replace(/\/\*[\s\S]*?\*\//g, "")}\n${chrome}`;
  const assetRefs = unique([...activeThemeCode.matchAll(/--cts-asset-([a-z0-9-]+)/g)].map((match) => match[1]));
  const colorRefs = unique([...activeThemeCode.matchAll(/--cts-color-([a-z0-9-]+)/g)].map((match) => match[1]));
  const assets = raw.assets && typeof raw.assets === "object" ? raw.assets : {};
  const colors = raw.colors && typeof raw.colors === "object" ? raw.colors : {};
  for (const key of Object.keys(assets)) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(key)) errors.push(`invalid asset key: ${key}`);
  }
  for (const key of Object.keys(colors)) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(key)) errors.push(`invalid color key: ${key}`);
  }
  const missingAssets = assetRefs.filter((key) => !(key in assets));
  const missingColors = colorRefs.filter((key) => !(key in colors));
  if (missingAssets.length) errors.push(`CSS references undefined assets: ${missingAssets.join(", ")}`);
  if (missingColors.length) errors.push(`CSS references undefined colors: ${missingColors.join(", ")}`);

  const unusedAssets = Object.keys(assets).filter((key) => !assetRefs.includes(key));
  if (unusedAssets.length) warnings.push(`theme.json assets not referenced by CSS: ${unusedAssets.join(", ")}`);
  const unusedColors = Object.keys(colors).filter((key) => !colorRefs.includes(key));
  if (unusedColors.length) warnings.push(`theme.json colors not referenced by CSS: ${unusedColors.join(", ")}`);

  let totalAssetBytes = 0;
  const referencedFiles = new Set();
  const assetStats = [];
  for (const [key, relative] of Object.entries(assets)) {
    const assetPath = path.resolve(themeDir, String(relative));
    if (assetPath !== themeDir && !assetPath.startsWith(`${themeDir}${path.sep}`)) {
      errors.push(`asset ${key} escapes theme directory: ${relative}`);
      continue;
    }
    const extension = path.extname(assetPath).toLowerCase();
    if (!ASSET_EXTENSIONS.has(extension)) errors.push(`asset ${key} has unsupported extension: ${extension || "<none>"}`);
    try {
      const stat = await fs.stat(assetPath);
      if (!stat.isFile() || stat.size < 1) errors.push(`asset ${key} is not a non-empty file`);
      totalAssetBytes += stat.size;
      referencedFiles.add(assetPath);
      const dataUrlChars = `data:${MIME[extension] ?? "application/octet-stream"};base64,`.length + 4 * Math.ceil(stat.size / 3);
      if (dataUrlChars >= MAX_DATA_URL_CHARS) errors.push(`asset ${key} data URL is ${dataUrlChars} chars (must be < ${MAX_DATA_URL_CHARS})`);
      assetStats.push({ key, path: String(relative), bytes: stat.size, dataUrlChars });
    } catch (error) {
      errors.push(`asset ${key} cannot be read: ${error.message}`);
    }
  }
  if (totalAssetBytes > MAX_TOTAL_BYTES) errors.push(`combined assets are ${totalAssetBytes} bytes (limit ${MAX_TOTAL_BYTES})`);

  const assetsDir = path.join(themeDir, "assets");
  try {
    const entries = await fs.readdir(assetsDir, { withFileTypes: true });
    const orphans = entries
      .filter((entry) => entry.isFile() && ASSET_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => path.join(assetsDir, entry.name))
      .filter((file) => !referencedFiles.has(file))
      .map((file) => path.relative(themeDir, file));
    if (orphans.length) warnings.push(`orphan asset files: ${orphans.join(", ")}`);
  } catch {
    if (Object.keys(assets).length) errors.push("assets directory is missing");
  }

  const braces = checkBraces(css);
  if (braces.depth !== 0 || braces.minDepth < 0) errors.push(`CSS braces are unbalanced (depth=${braces.depth}, minDepth=${braces.minDepth})`);
  if (css && !css.includes("html.codex-theme-studio")) errors.push("CSS has no html.codex-theme-studio scope");
  if (css.includes("#cts-intro") && !("intro" in assets)) errors.push("CSS defines #cts-intro but assets.intro is missing");

  const staleText = `${JSON.stringify(raw, null, 2)}\n${css}`.toLowerCase();
  const staleTokens = unique(args.forbid.filter((token) => staleText.includes(token.toLowerCase())));
  if (staleTokens.length) errors.push(`forbidden baseline tokens remain: ${staleTokens.join(", ")}`);

  return report({
    themeDir,
    id: raw.id ?? null,
    assetCount: Object.keys(assets).length,
    assetRefCount: assetRefs.length,
    totalAssetBytes,
    estimatedAssetDataUrlChars: assetStats.reduce((sum, item) => sum + item.dataUrlChars, 0),
    errors,
    warnings,
    assets: assetStats,
  }, args.json);
}

function report(result, json) {
  const ok = result.errors.length === 0;
  const output = { ok, ...result };
  if (json) console.log(JSON.stringify(output, null, 2));
  else {
    console.log(`${ok ? "PASS" : "FAIL"} ${result.id ?? path.basename(result.themeDir)}`);
    if (result.assetCount !== undefined) console.log(`assets=${result.assetCount} bytes=${result.totalAssetBytes} estimatedDataUrlChars=${result.estimatedAssetDataUrlChars}`);
    for (const error of result.errors) console.error(`ERROR: ${error}`);
    for (const warning of result.warnings) console.warn(`WARN: ${warning}`);
  }
  if (!ok) process.exitCode = 2;
  return output;
}

await main();
