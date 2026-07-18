import assert from "node:assert/strict";
import test from "node:test";

import { RUNTIME_HARDENING_CSS, verifyExpression } from "../src/payload.mjs";

test("composer hardening keeps only the editor scrollable", () => {
  assert.match(RUNTIME_HARDENING_CSS, /data-cts-composer-overflow="shell"/);
  assert.match(RUNTIME_HARDENING_CSS, /overflow: clip !important/);
  assert.match(RUNTIME_HARDENING_CSS, /data-cts-composer-overflow="lane"/);
  assert.match(RUNTIME_HARDENING_CSS, /overflow: visible !important/);
  assert.match(RUNTIME_HARDENING_CSS, /data-cts-composer-overflow="editor"/);
  assert.match(RUNTIME_HARDENING_CSS, /overflow-y: auto !important/);
});

test("verification selects the audited composer policy for each Codex build", () => {
  const expression = verifyExpression();
  assert.match(expression, /26\.715\.31251/);
  assert.match(expression, /composer-three-layer/);
  assert.match(expression, /composerLanePolicy: 'required'/);
  assert.match(expression, /26\.715\.31925/);
  assert.match(expression, /composer-two-or-three-layer/);
  assert.match(expression, /composerLanePolicy: 'optional'/);
  assert.match(expression, /lanePolicyValid/);
  assert.doesNotMatch(expression, /laneCount >= 1/);
});
