import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { inspectPreviewPath, resolvePreviewPath } from "../src/theme.mjs";

const execFileAsync = promisify(execFile);
const CLI_PATH = fileURLToPath(new URL("../bin/codex-theme.mjs", import.meta.url));

test("preview paths resolve only from the previews directory", () => {
  const themeDir = path.resolve("theme-fixture");

  assert.equal(
    resolvePreviewPath(themeDir, "previews/home.webp"),
    path.join(themeDir, "previews", "home.webp"),
  );
  assert.equal(
    resolvePreviewPath(themeDir, "previews/chat/alternate.webp"),
    path.join(themeDir, "previews", "chat", "alternate.webp"),
  );

  for (const invalid of [
    "previews/../../cover.webp",
    "previews/../cover.webp",
    "../previews/home.webp",
    "previews\\..\\cover.webp",
    "previews//home.webp",
    "previews/.hidden.webp",
    "assets/home.webp",
    "previews/home.png",
    42,
  ]) {
    assert.throws(
      () => resolvePreviewPath(themeDir, invalid),
      /preview must be a WebP below previews/,
      String(invalid),
    );
  }
});

test("preview inspection rejects symbolic-link escapes", async (t) => {
  const themeDir = await fs.mkdtemp(path.join(os.tmpdir(), "cts-preview-link-"));
  t.after(() => fs.rm(themeDir, { recursive: true, force: true }));

  const outsidePreview = path.join(path.dirname(themeDir), `${path.basename(themeDir)}-outside.webp`);
  t.after(() => fs.rm(outsidePreview, { force: true }));
  await fs.mkdir(path.join(themeDir, "previews"));
  await fs.writeFile(outsidePreview, Buffer.from("outside-preview"));
  await fs.symlink(outsidePreview, path.join(themeDir, "previews", "home.webp"));

  await assert.rejects(
    inspectPreviewPath(themeDir, "previews/home.webp"),
    /must not escape previews\/ through a symbolic link/,
  );
});

test("pack rejects a traversal preview even when the escaped file exists", async (t) => {
  const skinsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cts-pack-"));
  t.after(() => fs.rm(skinsRoot, { recursive: true, force: true }));

  const id = "preview-traversal-fixture";
  const themeDir = path.join(skinsRoot, id);
  const outDir = path.join(skinsRoot, "dist");
  const manifest = {
    schemaVersion: 2,
    id,
    name: "Preview traversal fixture",
    version: "1.0.0",
    description: "Regression fixture for preview containment.",
    author: "Codex Theme Studio",
    codexVerified: "test",
    appearance: "dual",
    license: "MIT",
    previews: ["previews/../../cover.webp"],
  };

  await fs.mkdir(themeDir, { recursive: true });
  await fs.writeFile(path.join(themeDir, "theme.json"), JSON.stringify(manifest));
  await fs.writeFile(path.join(themeDir, "theme.css"), "html.codex-theme-studio {}\n");
  await fs.writeFile(path.join(skinsRoot, "cover.webp"), Buffer.from("escaped-preview"));

  let failure;
  try {
    await execFileAsync(process.execPath, [CLI_PATH, "pack", id, "--out", outDir], {
      env: { ...process.env, CODEX_SKINS_ROOT: skinsRoot },
    });
  } catch (error) {
    failure = error;
  }

  assert.equal(failure?.code, 2, "the delivery gate must reject the manifest");
  const result = JSON.parse(failure.stdout);
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, [
    "preview must be a WebP below previews/: previews/../../cover.webp",
  ]);
  await assert.rejects(
    fs.access(path.join(outDir, `${id}-1.0.0.codexskin`)),
    { code: "ENOENT" },
  );
});
