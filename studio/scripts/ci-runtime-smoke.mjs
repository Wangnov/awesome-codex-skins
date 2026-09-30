#!/usr/bin/env node
// CI-only runtime smoke test: injects and removes every skin against a real,
// freshly downloaded Codex renderer over CDP, and fails if the injected runtime
// throws an uncaught exception, a skin does not install, or it ends up not
// fully removed.
//
// What this does NOT do: sign in, reach the home route, or take any
// screenshot. The Codex home route requires an account (see SPEC.md §3 and
// Codex-App-Manager's docs/investigations/issue-343-portable-startup.md), and
// this project never accepts or stores credentials, so an unattended CI
// runner is stuck on whatever route a logged-out launch lands on (the sign-in
// page as of this writing). That's fine for this test's actual job: the
// injected runtime (`payload.mjs`'s `buildPayload`/`REMOVE_EXPRESSION`) reads
// and rewrites DOM/CSS that exists on every route Codex's shell renders, not
// just the home route, so exercising it here against a real renderer still
// catches a real class of bug neither the jsdom-based unit tests nor the
// `pack` gate's static structural checks can: a skin whose asset payload
// crashes the actual React app once it's live (a bad CSS selector wedging
// layout into an infinite re-render loop, a malformed motion asset the real
// <video> element chokes on, etc).
//
// Usage: CODEX_APP_PATH=/path/to/ChatGPT.app node studio/scripts/ci-runtime-smoke.mjs
// Exits non-zero if any skin fails to install (installed class, stylesheet,
// theme id and runtime version), throws a renderer exception attributable to
// the injected runtime (see smoke-assert.mjs), or fails to
// fully remove. The full verify().pass (needs the signed-in shell) is NOT
// asserted; see runSkin.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectCodexTargets } from "../src/cdp.mjs";
import {
  discoverCodexApp, selectAvailablePort, launchCodexWithCdp, waitForCdp,
  quitCodex, DEFAULT_PORT,
} from "../src/codex-app.mjs";
import { buildPayload, REMOVE_EXPRESSION, VERIFY_REMOVED_EXPRESSION, verifyExpression } from "../src/payload.mjs";
import {
  installedOk, pickInstallState, summarizeException, exceptionKey, classifyExceptions,
} from "../src/smoke-assert.mjs";
import { listThemes } from "../src/theme.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(here, "..");
const SKINS_ROOT = process.env.CODEX_SKINS_ROOT?.trim() || path.join(PROJECT_ROOT, "..", "skins");

const SETTLE_MS = 800; // time given for an async exception to surface after an evaluate() resolves
const PER_SKIN_TIMEOUT_MS = 20000;
const BASELINE_MS = 6000; // watch the untouched app this long to learn its own exception noise

function log(message) {
  process.stderr.write(`[ci-runtime-smoke] ${message}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wires `Runtime.exceptionThrown` on every connected session so async
// renderer exceptions (thrown after an `evaluate()` call already resolved,
// e.g. from a MutationObserver callback or a later React render pass) are
// caught too, not just synchronous errors inside the evaluated expression
// itself (which `session.evaluate` already rejects on via `exceptionDetails`).
// Attribution and baseline filtering live in smoke-assert.mjs: a logged-out
// Codex throws app-side errors on its own, so raw "an exception fired" is not
// evidence against a skin.
function watchForExceptions(connected) {
  const caught = [];
  for (const { target, session } of connected) {
    session.on("Runtime.exceptionThrown", (params) => {
      caught.push(summarizeException(params?.exceptionDetails, target.url));
    });
  }
  return caught;
}

const shellReached = new Set();

async function runSkin(id, dir, connected, exceptions, baselineKeys) {
  const { payload } = await buildPayload(dir);
  exceptions.length = 0;

  for (const { session } of connected) {
    await session.evaluate(payload);
  }
  await sleep(SETTLE_MS);

  // Logged-out assertions only. verifyExpression().pass (the full "shell is
  // laid out" check) requires the signed-in app shell — a visible main
  // surface, composer and sidebar — none of which exists on the sign-in page
  // a CI launch lands on, so it is deliberately NOT asserted here; it is only
  // logged as informational context. What is asserted is what the injected
  // runtime can honestly guarantee on any route: it installed itself under
  // the expected theme id and version, and its stylesheet is present.
  for (const { target, session } of connected) {
    const deadline = Date.now() + PER_SKIN_TIMEOUT_MS;
    let result;
    while (Date.now() < deadline) {
      result = await session.evaluate(verifyExpression());
      if (installedOk(id, result)) break;
      await sleep(400);
    }
    if (!installedOk(id, result)) {
      throw new Error(
        `skin '${id}' did not install on ${target.url}: ${JSON.stringify(pickInstallState(result))}`,
      );
    }
    if (result.pass) shellReached.add(target.url);
  }

  for (const { session } of connected) {
    await session.evaluate(REMOVE_EXPRESSION);
  }
  await sleep(SETTLE_MS);

  for (const { target, session } of connected) {
    const removed = await session.evaluate(VERIFY_REMOVED_EXPRESSION);
    if (removed !== true) {
      throw new Error(`skin '${id}' left residue on ${target.url} after removal (verify returned ${JSON.stringify(removed)})`);
    }
  }

  const { failures, warnings, ignored } = classifyExceptions(exceptions, baselineKeys);
  if (warnings.length > 0) {
    process.stderr.write(
      `::warning::runtime-smoke ${id}: ${warnings.length} new renderer exception(s) not attributable to the ` +
        `injected runtime (not failing): ${JSON.stringify(warnings.map((w) => w.text.split("\n")[0]))}\n`,
    );
  }
  if (ignored.length > 0) log(`${id}: ignored ${ignored.length} exception(s) already seen in the pre-injection baseline`);
  if (failures.length > 0) {
    throw new Error(
      `skin '${id}' threw ${failures.length} renderer exception(s) from the injected runtime: ${JSON.stringify(failures)}`,
    );
  }
}

async function main() {
  const appPathOverride = process.env.CODEX_APP_PATH?.trim();
  if (!appPathOverride) {
    throw new Error("CODEX_APP_PATH must point at a Codex/ChatGPT.app bundle for this CI-only script.");
  }

  // Everything that can be checked without a running app is checked first, so
  // a bad skin directory fails in milliseconds instead of after a full launch.
  const themes = await listThemes(SKINS_ROOT);
  if (themes.length === 0) throw new Error(`No skins found under ${SKINS_ROOT}`);
  // listThemes silently skips directories that fail to load; a smoke test that
  // quietly covers fewer skins than exist would be a false green.
  const skinDirs = (await fs.readdir(SKINS_ROOT, { withFileTypes: true })).filter((e) => e.isDirectory());
  if (skinDirs.length !== themes.length) {
    throw new Error(`${skinDirs.length} skin dir(s) under ${SKINS_ROOT} but only ${themes.length} loaded`);
  }

  const app = await discoverCodexApp();
  log(`discovered ${app.bundle} (v${app.version})`);

  const port = await selectAvailablePort(DEFAULT_PORT);
  log(`launching with loopback CDP on 127.0.0.1:${port}`);
  let connected = [];
  const failures = [];
  // From the launch onward, always close the CDP sockets (Node's global
  // WebSocket would otherwise keep the process alive until the job timeout)
  // and quit the app, whatever throws.
  try {
    await launchCodexWithCdp(app.bundle, port);
    if (!(await waitForCdp(port, 60000))) {
      throw new Error(`Codex did not expose a loopback CDP endpoint on port ${port} within 60s`);
    }

    connected = await connectCodexTargets(port, 30000);
    log(`connected to ${connected.length} renderer target(s): ${connected.map((c) => c.target.url).join(", ")}`);
    const exceptions = watchForExceptions(connected);

    log(`recording ${BASELINE_MS}ms of the app's own exception noise before injecting anything`);
    await sleep(BASELINE_MS);
    const baselineKeys = new Set(exceptions.map(exceptionKey));
    log(`baseline: ${exceptions.length} exception(s), ${baselineKeys.size} distinct`);

    log(`smoke-testing ${themes.length} skin(s) from ${SKINS_ROOT}`);
    for (const theme of themes) {
      process.stderr.write(`::group::runtime-smoke ${theme.id}\n`);
      try {
        await runSkin(theme.id, theme.dir, connected, exceptions, baselineKeys);
        process.stderr.write(`OK: ${theme.id}\n`);
      } catch (error) {
        process.stderr.write(`::error::runtime-smoke failed for ${theme.id}: ${error.message}\n`);
        failures.push({ id: theme.id, message: error.message });
      }
      process.stderr.write("::endgroup::\n");
    }
  } finally {
    for (const { session } of connected) {
      try { session.close(); } catch { /* already closed */ }
    }
    await quitCodex(app, { force: true }).catch((error) => log(`quitCodex failed: ${error.message}`));
  }

  if (failures.length > 0) {
    log(`${failures.length}/${themes.length} skin(s) failed the runtime smoke test`);
    process.exitCode = 1;
    return;
  }
  log(
    `all ${themes.length} skin(s) passed: install, remove, no runtime-attributed renderer exceptions ` +
      `(full signed-in shell reached on ${shellReached.size} target(s), informational only)`,
  );
}

main()
  .catch((error) => {
    process.stderr.write(`::error::${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  })
  // Belt and braces: never let a lingering socket or child handle hold a
  // billed macOS runner until the job timeout.
  .finally(() => process.exit(process.exitCode ?? 0));
