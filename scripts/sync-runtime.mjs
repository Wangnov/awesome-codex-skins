#!/usr/bin/env node
// Vendors the renderer runtime from Codex-App-Manager's codex-theme-engine
// crate — the single authored implementation — into studio/src, pinned to a
// commit recorded in studio/RUNTIME_SOURCE.json.
//
// Usage:
//   node scripts/sync-runtime.mjs            fetch the pinned commit from
//                                             GitHub and overwrite the local
//                                             vendored copies
//   node scripts/sync-runtime.mjs --check     fetch and diff only; exits 1
//                                             (without writing) if the
//                                             checked-in copies have drifted
//                                             from what the pin produces
//   node scripts/sync-runtime.mjs --from <dir>
//                                             read source files from a local
//                                             checkout of Codex-App-Manager at
//                                             <dir> instead of fetching from
//                                             GitHub (useful for local dev
//                                             when both repos are cloned
//                                             side by side, or when the
//                                             sandbox has no network access)
//
// This script is also what studio/RUNTIME_SOURCE.json means when it says
// "do not hand-edit" the generated files below: run this instead.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
const manifestPath = path.join(repoRoot, "studio", "RUNTIME_SOURCE.json");

const GENERATED_HEADER = (sourcePath, commit) => `// ---------------------------------------------------------------------------
// GENERATED FILE — do not hand-edit.
//
// Vendored verbatim from Wangnov/Codex-App-Manager, the canonical
// codex-theme-engine runtime implementation, at commit ${commit}:
//   ${sourcePath}
//
// To pick up a newer runtime, bump the commit in studio/RUNTIME_SOURCE.json
// and run: node scripts/sync-runtime.mjs
// ---------------------------------------------------------------------------
`;

function parseArgs(argv) {
  const args = { check: false, from: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") args.check = true;
    else if (arg === "--from") args.from = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

async function readManifest() {
  const raw = await fs.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw);
  if (!manifest.repo || !manifest.commit || !manifest.paths) {
    throw new Error(`${manifestPath} is missing repo/commit/paths`);
  }
  return manifest;
}

async function fetchFromGitHub(repo, commit, sourcePath) {
  const url = `https://raw.githubusercontent.com/${repo}/${commit}/${sourcePath}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

async function readFromLocalCheckout(dir, sourcePath) {
  return fs.readFile(path.join(dir, sourcePath), "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = await readManifest();

  let drifted = false;
  for (const [sourcePath, destRelPath] of Object.entries(manifest.paths)) {
    const body = args.from
      ? await readFromLocalCheckout(args.from, sourcePath)
      : await fetchFromGitHub(manifest.repo, manifest.commit, sourcePath);
    const header = GENERATED_HEADER(sourcePath, manifest.commit);
    const nextContent = `${header}\n${body}`;
    const destPath = path.join(repoRoot, destRelPath);

    if (args.check) {
      let current = null;
      try {
        current = await fs.readFile(destPath, "utf8");
      } catch {
        current = null;
      }
      if (current !== nextContent) {
        drifted = true;
        console.error(`drift: ${destRelPath} does not match pinned commit ${manifest.commit}`);
      } else {
        console.log(`ok: ${destRelPath}`);
      }
      continue;
    }

    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, nextContent, "utf8");
    console.log(`synced: ${destRelPath}`);
  }

  if (args.check && drifted) {
    console.error(
      "\nVendored runtime files are out of sync with studio/RUNTIME_SOURCE.json.\n" +
        "Run `node scripts/sync-runtime.mjs` and commit the result, or update the pin.",
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.stack ?? String(err));
  process.exitCode = 1;
});
