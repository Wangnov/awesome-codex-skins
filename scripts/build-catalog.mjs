#!/usr/bin/env node
// Build the distribution catalog consumed by Codex App Manager's online
// store. Reads packed archives from --packs (produced by the pack gate),
// joins each with its skin manifest and cover preview, and emits:
//
//   <out>/index.json                      catalog (relative URLs, see below)
//   <out>/packs/<id>-<version>.codexskin  archives (copied)
//   <out>/previews/<id>.webp              cover previews (copied)
//
// URLs in index.json are RELATIVE — consumers resolve them against whatever
// origin served the catalog, so mirrors work without rewriting.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const PACKS = path.resolve(flag("packs", path.join(ROOT, "dist")));
const OUT = path.resolve(flag("out", path.join(ROOT, "dist-catalog")));
const SKINS = path.join(ROOT, "skins");

await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(path.join(OUT, "packs"), { recursive: true });
await fs.mkdir(path.join(OUT, "previews"), { recursive: true });

const entries = [];
for (const dirent of (await fs.readdir(SKINS, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!dirent.isDirectory()) continue;
  const id = dirent.name;
  const manifest = JSON.parse(await fs.readFile(path.join(SKINS, id, "theme.json"), "utf8"));
  if (manifest.id !== id) throw new Error(`${id}: directory/id mismatch`);
  const version = manifest.version;
  if (!version) throw new Error(`${id}: missing version (run the pack gate first)`);

  const packName = `${id}-${version}.codexskin`;
  const packSrc = path.join(PACKS, packName);
  const bytes = await fs.readFile(packSrc).catch(() => {
    throw new Error(`${id}: ${packName} not found under ${PACKS} — run pack first`);
  });
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  await fs.writeFile(path.join(OUT, "packs", packName), bytes);

  const coverRel = (manifest.previews ?? [])[0];
  if (!coverRel) throw new Error(`${id}: no cover preview`);
  await fs.copyFile(path.join(SKINS, id, coverRel), path.join(OUT, "previews", `${id}.webp`));

  entries.push({
    id,
    name: manifest.name ?? id,
    description: manifest.description ?? "",
    version,
    author: typeof manifest.author === "object" ? manifest.author?.name ?? "" : manifest.author ?? "",
    appearance: manifest.appearance ?? null,
    license: manifest.license ?? null,
    tags: manifest.tags ?? [],
    codexVerified: manifest.codexVerified ?? null,
    bytes: bytes.length,
    sha256,
    pack: `packs/${packName}`,
    preview: `previews/${id}.webp`,
  });
}

const catalog = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: "https://github.com/Wangnov/awesome-codex-skins",
  skins: entries,
};
await fs.writeFile(path.join(OUT, "index.json"), `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ok: true, skins: entries.length, out: OUT }, null, 2));
