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

// Raw-content fetches get a timeout (so a hung connection can't stall CI
// indefinitely) and a few retries with backoff, because
// raw.githubusercontent.com is a new external network dependency for
// validate-skins.yml's pack-gate job (which runs on every skin PR) and its
// push-to-main -> publish-catalog job: a transient blip there should not
// fail an otherwise-correct, unrelated skin submission or skip a production
// catalog republish. See main()'s --check handling below for what happens
// when retries are exhausted.
const FETCH_TIMEOUT_MS = 10_000;
const FETCH_ATTEMPTS = 3;
const FETCH_RETRY_BASE_MS = 300;

// Thrown for a failure we believe is transient (network error, timeout, 5xx,
// rate limiting) and therefore worth retrying — as opposed to a 404 on the
// pinned commit/path, which means the pin itself is broken and must fail
// loudly and immediately (retrying a 404 never helps, and silently treating
// a broken pin as "transient" would hide a real problem — the design doc's
// risk section explicitly calls for a hard failure, not a silent skip, on a
// pinned-SHA 404).
class TransientFetchError extends Error {}

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

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFromGitHubOnce(repo, commit, sourcePath) {
  const url = `https://raw.githubusercontent.com/${repo}/${commit}/${sourcePath}`;
  let res;
  try {
    res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
  } catch (err) {
    // DNS failure, connection reset, timeout/abort, etc. — transport-level,
    // treated as transient.
    throw new TransientFetchError(`fetch ${url} failed: ${err.message}`);
  }
  if (res.status === 404) {
    throw new Error(
      `fetch ${url} failed: 404 Not Found (the pinned commit or path is missing — ` +
        "check studio/RUNTIME_SOURCE.json's commit/paths)",
    );
  }
  if (!res.ok) {
    // Any other non-2xx (5xx, secondary rate limiting, etc.) is transient.
    throw new TransientFetchError(`fetch ${url} failed: ${res.status} ${res.statusText}`);
  }
  return res.text();
}

async function fetchFromGitHub(repo, commit, sourcePath) {
  let lastErr;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      return await fetchFromGitHubOnce(repo, commit, sourcePath);
    } catch (err) {
      if (!(err instanceof TransientFetchError)) throw err; // 404: fail fast, no retry
      lastErr = err;
      if (attempt < FETCH_ATTEMPTS) {
        const delayMs = FETCH_RETRY_BASE_MS * 2 ** (attempt - 1);
        console.error(`${err.message} (attempt ${attempt}/${FETCH_ATTEMPTS}, retrying in ${delayMs}ms)`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastErr;
}

async function readFromLocalCheckout(dir, sourcePath) {
  return fs.readFile(path.join(dir, sourcePath), "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = await readManifest();

  let drifted = false;
  let networkSkipped = false;
  for (const [sourcePath, destRelPath] of Object.entries(manifest.paths)) {
    let body;
    try {
      body = args.from
        ? await readFromLocalCheckout(args.from, sourcePath)
        : await fetchFromGitHub(manifest.repo, manifest.commit, sourcePath);
    } catch (err) {
      // Only `--check` degrades a transient failure into a warning, and only
      // after FETCH_ATTEMPTS retries have already been exhausted inside
      // fetchFromGitHub(). A 404 (broken pin) surfaces as a plain Error, not
      // a TransientFetchError, so it always falls through to `throw err`
      // below and fails the job loudly, per the design doc's explicit "hard
      // fail on a pinned-SHA 404, don't silently skip" requirement. A plain
      // `sync` (no --check) also always fails loudly on any error, including
      // a transient one: a human who explicitly ran `sync-runtime` to bump
      // the pin should see the failure immediately rather than have it
      // silently no-op.
      //
      // The tradeoff this accepts (flagged as an open risk in the design
      // doc's risk section): if raw.githubusercontent.com is unreachable
      // during `--check` — which gates skin-submission PRs and the
      // push-to-main publish-catalog job in validate-skins.yml — treating
      // that as a hard CI failure would block an otherwise-correct,
      // unrelated skin PR on a GitHub CDN blip. Instead this degrades to a
      // loud warning and treats the already-committed vendored copy as
      // presumed-good for this run, rather than caching a separate
      // last-known-good blob (the vendored copy already checked into the
      // repo *is* the last-known-good blob). The real drift check for that
      // file simply did not run this time; it will run again on the next
      // push/PR once the network recovers.
      if (args.check && !args.from && err instanceof TransientFetchError) {
        console.warn(
          `warning: could not reach raw.githubusercontent.com for ${sourcePath} after ` +
            `${FETCH_ATTEMPTS} attempts (${err.message}); skipping the live drift check for ` +
            `${destRelPath} this run and trusting the committed vendored copy.`,
        );
        networkSkipped = true;
        continue;
      }
      throw err;
    }
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

  if (args.check && networkSkipped && !drifted) {
    console.error(
      "\nOne or more files could not be checked against the pinned commit because " +
        "raw.githubusercontent.com was unreachable after retries (see warnings above). " +
        "This run passed on trust in the committed vendored copy, not a verified match — " +
        "re-run once network access is restored for a real drift verdict.",
    );
  }

  if (!args.check) {
    const updatedManifest = { ...manifest, lastSyncedAt: new Date().toISOString() };
    await fs.writeFile(manifestPath, `${JSON.stringify(updatedManifest, null, 2)}\n`, "utf8");
    console.log(`updated: studio/RUNTIME_SOURCE.json (lastSyncedAt=${updatedManifest.lastSyncedAt})`);
  }
}

main().catch((err) => {
  console.error(err.stack ?? String(err));
  process.exitCode = 1;
});
