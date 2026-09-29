#!/usr/bin/env node
// CI-only runtime smoke test: injects and removes every skin against a real,
// freshly downloaded Codex renderer over CDP, and fails if the renderer ever
// throws an uncaught exception or ends up not fully removed.
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
// Exits non-zero if any skin fails to apply cleanly, throws a renderer
// exception, or fails to fully remove.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectCodexTargets } from "../src/cdp.mjs";
import {
  discoverCodexApp, selectAvailablePort, launchCodexWithCdp, waitForCdp,
  quitCodex, DEFAULT_PORT,
} from "../src/codex-app.mjs";
import { buildPayload, REMOVE_EXPRESSION, VERIFY_REMOVED_EXPRESSION, verifyExpression } from "../src/payload.mjs";
import { listThemes } from "../src/theme.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(here, "..");
const SKINS_ROOT = process.env.CODEX_SKINS_ROOT?.trim() || path.join(PROJECT_ROOT, "..", "skins");

const SETTLE_MS = 800; // time given for an async exception to surface after an evaluate() resolves
const PER_SKIN_TIMEOUT_MS = 20000;

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
function watchForExceptions(connected) {
  const caught = [];
  for (const { target, session } of connected) {
    session.on("Runtime.exceptionThrown", (params) => {
      const detail = params?.exceptionDetails;
      caught.push({
        targetUrl: target.url,
        text: detail?.exception?.description ?? detail?.text ?? "unknown renderer exception",
      });
    });
  }
  return caught;
}

async function runSkin(id, dir, connected, exceptions) {
  const { payload } = await buildPayload(dir);
  exceptions.length = 0;

  for (const { session } of connected) {
    await session.evaluate(payload);
  }
  await sleep(SETTLE_MS);

  for (const { target, session } of connected) {
    const deadline = Date.now() + PER_SKIN_TIMEOUT_MS;
    let result;
    while (Date.now() < deadline) {
      result = await session.evaluate(verifyExpression());
      if (result?.pass) break;
      await sleep(400);
    }
    if (!result?.pass) {
      throw new Error(`skin '${id}' failed verify() on ${target.url}: ${JSON.stringify(result)}`);
    }
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

  if (exceptions.length > 0) {
    throw new Error(
      `skin '${id}' threw ${exceptions.length} renderer exception(s): ${JSON.stringify(exceptions)}`,
    );
  }
}

async function main() {
  const appPathOverride = process.env.CODEX_APP_PATH?.trim();
  if (!appPathOverride) {
    throw new Error("CODEX_APP_PATH must point at a Codex/ChatGPT.app bundle for this CI-only script.");
  }

  const app = await discoverCodexApp();
  log(`discovered ${app.bundle} (v${app.version})`);

  const port = await selectAvailablePort(DEFAULT_PORT);
  log(`launching with loopback CDP on 127.0.0.1:${port}`);
  await launchCodexWithCdp(app.bundle, port);
  if (!(await waitForCdp(port, 60000))) {
    throw new Error(`Codex did not expose a loopback CDP endpoint on port ${port} within 60s`);
  }

  const connected = await connectCodexTargets(port, 30000);
  log(`connected to ${connected.length} renderer target(s): ${connected.map((c) => c.target.url).join(", ")}`);
  const exceptions = watchForExceptions(connected);

  const themes = await listThemes(SKINS_ROOT);
  if (themes.length === 0) throw new Error(`No skins found under ${SKINS_ROOT}`);
  log(`smoke-testing ${themes.length} skin(s) from ${SKINS_ROOT}`);

  const failures = [];
  for (const theme of themes) {
    process.stderr.write(`::group::runtime-smoke ${theme.id}\n`);
    try {
      await runSkin(theme.id, theme.dir, connected, exceptions);
      process.stderr.write(`OK: ${theme.id}\n`);
    } catch (error) {
      process.stderr.write(`::error::runtime-smoke failed for ${theme.id}: ${error.message}\n`);
      failures.push({ id: theme.id, message: error.message });
    }
    process.stderr.write("::endgroup::\n");
  }

  for (const { session } of connected) session.close();
  await quitCodex(app, { force: true });

  if (failures.length > 0) {
    log(`${failures.length}/${themes.length} skin(s) failed the runtime smoke test`);
    process.exitCode = 1;
    return;
  }
  log(`all ${themes.length} skin(s) passed: apply, verify, remove, no renderer exceptions`);
}

main().catch((error) => {
  process.stderr.write(`::error::${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
