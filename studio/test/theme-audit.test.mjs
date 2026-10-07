import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const AUDIT_PATH = fileURLToPath(
  new URL("../../skills/codex-theme-maker/scripts/audit-theme.mjs", import.meta.url),
);

async function makeTheme(assetKey) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cts-theme-audit-"));
  const id = "audit-intro-fixture";
  const themeDir = path.join(root, id);
  await fs.mkdir(themeDir);

  const assets = {};
  if (assetKey) {
    await fs.mkdir(path.join(themeDir, "assets"));
    await fs.writeFile(path.join(themeDir, "assets", "intro.webp"), "fixture");
    assets[assetKey] = "assets/intro.webp";
  }

  await fs.writeFile(
    path.join(themeDir, "theme.json"),
    `${JSON.stringify({ schemaVersion: 2, id, css: "theme.css", assets }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(themeDir, "theme.css"),
    "html.codex-theme-studio #cts-intro { display: grid; }\n",
  );
  return { root, themeDir };
}

async function runAudit(themeDir) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [AUDIT_PATH, themeDir, "--json"]);
    return { exitCode: 0, result: JSON.parse(stdout) };
  } catch (error) {
    return {
      exitCode: error.code,
      result: JSON.parse(error.stdout),
    };
  }
}

for (const assetKey of ["intro", "tiga-punch"]) {
  test(`theme audit accepts #cts-intro with assets.${assetKey}`, async (t) => {
    const { root, themeDir } = await makeTheme(assetKey);
    t.after(() => fs.rm(root, { recursive: true, force: true }));

    const audit = await runAudit(themeDir);
    assert.equal(audit.exitCode, 0);
    assert.equal(audit.result.ok, true);
    assert.deepEqual(audit.result.errors, []);
  });
}

test("theme audit rejects #cts-intro without a supported static asset", async (t) => {
  const { root, themeDir } = await makeTheme(null);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const audit = await runAudit(themeDir);
  assert.equal(audit.exitCode, 2);
  assert.equal(audit.result.ok, false);
  assert.deepEqual(audit.result.errors, [
    "CSS defines #cts-intro but neither assets.intro nor legacy assets.tiga-punch is present",
  ]);
});
