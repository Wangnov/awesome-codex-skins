import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadTheme } from "../src/theme.mjs";
import { buildPayload } from "../src/payload.mjs";

async function writeFixture({ motionAssets, extraFiles = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cts-motion-"));
  const manifest = {
    schemaVersion: 2,
    id: path.basename(dir).toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40) || "motion-fixture",
    name: "Motion fixture",
    assets: { intro: "assets/intro.webp" },
    ...(motionAssets ? { motionAssets } : {}),
  };
  // The loader only stats sizes; content bytes are irrelevant to these tests.
  await fs.mkdir(path.join(dir, "assets"), { recursive: true });
  await fs.writeFile(path.join(dir, "theme.json"), JSON.stringify(manifest));
  await fs.writeFile(path.join(dir, "theme.css"), "html.codex-theme-studio {}\n");
  await fs.writeFile(path.join(dir, "assets", "intro.webp"), Buffer.from([0x52, 0x49, 0x46, 0x46]));
  for (const [rel, bytes] of Object.entries(extraFiles)) {
    await fs.writeFile(path.join(dir, rel), bytes);
  }
  return dir;
}

test("motion assets ride the dedicated JSON slot, not CSS variables", async (t) => {
  const dir = await writeFixture({
    motionAssets: { "intro-video": "assets/intro-video.mp4" },
    extraFiles: { "assets/intro-video.mp4": Buffer.from("mp4-bytes") },
  });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const { payload } = await buildPayload(dir);
  assert.match(payload, /"intro-video":"data:video\/mp4;base64,/);
  assert.doesNotMatch(payload, /--cts-asset-intro-video:/);
  assert.match(payload, /--cts-asset-intro:/, "static assets keep their CSS variable");
  assert.doesNotMatch(payload, /__CTS_MOTION_JSON__/, "the placeholder must be substituted");
});

test("payloads without motion assets substitute an empty motion map", async (t) => {
  const dir = await writeFixture();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const { payload } = await buildPayload(dir);
  assert.doesNotMatch(payload, /__CTS_MOTION_JSON__/);
  assert.match(payload, /\}\)\(.*, \{\}\)$/m, "the runtime IIFE receives an empty motion object");
});

test("the stamp changes when only motion bytes change", async (t) => {
  const dir = await writeFixture({
    motionAssets: { "intro-video": "assets/intro-video.mp4" },
    extraFiles: { "assets/intro-video.mp4": Buffer.from("take-one") },
  });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const stampOf = (payload) => payload.match(/"0\.1\.0:[a-z0-9-]+:([0-9a-f]{12})"/)?.[1];
  const first = stampOf((await buildPayload(dir)).payload);
  await fs.writeFile(path.join(dir, "assets", "intro-video.mp4"), Buffer.from("take-two!"));
  const second = stampOf((await buildPayload(dir)).payload);
  assert.ok(first && second, "both payloads carry a parsable stamp");
  assert.notEqual(first, second, "reconcilers must re-inject when the video changes");
});

test("the loader rejects non-video motion formats and bad keys", async (t) => {
  const badFormat = await writeFixture({
    motionAssets: { "intro-video": "assets/intro.webp" },
  });
  t.after(() => fs.rm(badFormat, { recursive: true, force: true }));
  await assert.rejects(() => loadTheme(badFormat), /unsupported motion asset format/);

  const badKey = await writeFixture({
    motionAssets: { "Bad Key!": "assets/intro-video.mp4" },
    extraFiles: { "assets/intro-video.mp4": Buffer.from("mp4-bytes") },
  });
  t.after(() => fs.rm(badKey, { recursive: true, force: true }));
  await assert.rejects(() => loadTheme(badKey), /invalid motion asset key/);
});

test("the loader rejects a motion key that shadows a static asset", async (t) => {
  const dir = await writeFixture({
    motionAssets: { intro: "assets/intro-video.mp4" },
    extraFiles: { "assets/intro-video.mp4": Buffer.from("mp4-bytes") },
  });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await assert.rejects(() => loadTheme(dir), /collides with a static asset/);
});

test("the runtime template accepts and consumes the motion argument", async () => {
  const template = await fs.readFile(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "runtime", "theme-runtime.js"),
    "utf8",
  );
  assert.match(template, /\(\(cssText, themeConfig, chromeHtml, motionAssets\) => \{/);
  assert.match(template, /__CTS_MOTION_JSON__\)$/m);
  assert.match(template, /MOTION\["intro-video"\]/);
  assert.match(template, /prefers-reduced-motion/);
  // Hot-switch contract: a stamp change tears down a still-playing intro so
  // the incoming theme can mount its own; same-stamp re-ensures leave it be.
  assert.match(template, /previous\.stamp !== STAMP\) document\.getElementById\(INTRO_ID\)\?\.remove\(\)/);
  // Late-failure contract: every video error path remounts the static intro.
  assert.match(template, /const fallbackToStatic/);
  assert.equal((template.match(/fallbackToStatic\(/g) || []).length >= 3, true,
    "error handler, play rejection and play throw must all route through fallbackToStatic");
});
