import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

import {
  buildPayload, REMOVE_EXPRESSION, VERIFY_REMOVED_EXPRESSION, verifyExpression,
} from "../src/payload.mjs";
import { installedOk, pickInstallState } from "../src/smoke-assert.mjs";

const SKIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "skins", "asuka-eva02");

// The premise the CI smoke job depends on: on a logged-out sign-in page (no
// main surface, composer or left panel) the runtime installs cleanly, the
// smoke assertion passes, and verify().pass — which needs the signed-in shell
// — is correctly false, so it must not be what the smoke job asserts.
test("logged-out sign-in page: smoke assertion holds while verify().pass does not", async (t) => {
  const { payload } = await buildPayload(SKIN_DIR);
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body><div id="root"><h1>Sign in</h1><button>Continue</button></div></body></html>',
    { pretendToBeVisual: true, runScripts: "outside-only" },
  );
  t.after(() => dom.window.close());
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  dom.window.innerWidth = 1280;
  dom.window.innerHeight = 800;

  dom.window.eval(payload);
  const result = dom.window.eval(verifyExpression());
  assert.equal(result.pass, false, "the full shell check cannot pass without the signed-in shell");
  assert.equal(installedOk("asuka-eva02", result), true, JSON.stringify(pickInstallState(result)));
  assert.equal(installedOk("some-other-skin", result), false);

  dom.window.eval(REMOVE_EXPRESSION);
  assert.equal(dom.window.eval(VERIFY_REMOVED_EXPRESSION), true);
});

test("installedOk rejects each missing install signal", () => {
  const good = { installed: true, stylePresent: true, themeId: "x", version: "1.0" };
  assert.equal(installedOk("x", good, "1.0"), true);
  assert.equal(installedOk("x", { ...good, installed: false }, "1.0"), false);
  assert.equal(installedOk("x", { ...good, stylePresent: false }, "1.0"), false);
  assert.equal(installedOk("x", { ...good, version: "0.9" }, "1.0"), false);
  assert.equal(installedOk("x", null, "1.0"), false);
});
