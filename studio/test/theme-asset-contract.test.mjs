import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const skinsRoot = path.resolve(here, "..", "..", "skins");
const ASSET_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function assetVarCalls(css) {
  const source = stripComments(css);
  const calls = [];
  for (let start = source.indexOf("var("); start !== -1; start = source.indexOf("var(", start + 4)) {
    let depth = 1;
    let quote = null;
    let end = start + 4;
    for (; end < source.length && depth > 0; end += 1) {
      const char = source[end];
      if (quote) {
        if (char === quote && source[end - 1] !== "\\") quote = null;
        continue;
      }
      if (char === '"' || char === "'") quote = char;
      else if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
    }
    if (depth !== 0) continue;
    const body = source.slice(start + 4, end - 1);
    const match = body.match(/^\s*--cts-asset-([a-z0-9-]+)/);
    if (!match) continue;
    const comma = body.indexOf(",");
    const fallback = comma === -1 ? "" : body.slice(comma + 1);
    calls.push({
      key: match[1],
      fallbackKeys: [...fallback.matchAll(/--cts-asset-([a-z0-9-]+)/g)].map((item) => item[1]),
      excerpt: source.slice(start, Math.min(end, start + 180)).replace(/\s+/g, " "),
    });
  }
  return calls;
}

async function listSkinDirectories() {
  const entries = await fs.readdir(skinsRoot, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(skinsRoot, entry.name)).sort();
}

test("every skin's CSS asset variables resolve to real manifest files", async (t) => {
  const skinDirectories = await listSkinDirectories();
  assert.ok(skinDirectories.length > 0, "the public skin registry must not be empty");

  for (const skinDir of skinDirectories) {
    const id = path.basename(skinDir);
    await t.test(id, async () => {
      const manifest = JSON.parse(await fs.readFile(path.join(skinDir, "theme.json"), "utf8"));
      const css = await fs.readFile(path.join(skinDir, manifest.css || "theme.css"), "utf8");
      const staticAssets = manifest.assets && typeof manifest.assets === "object" ? manifest.assets : {};
      const motionAssets = manifest.motionAssets && typeof manifest.motionAssets === "object" ? manifest.motionAssets : {};
      const declaredStatic = new Set(Object.keys(staticAssets));
      const declaredMotion = new Set(Object.keys(motionAssets));

      for (const [key, relative] of Object.entries({ ...staticAssets, ...motionAssets })) {
        assert.match(key, ASSET_KEY, `${id}: invalid manifest asset key ${key}`);
        assert.equal(typeof relative, "string", `${id}: asset ${key} path must be a string`);
        assert.ok(!path.isAbsolute(relative), `${id}: asset ${key} path must be relative`);
        const resolved = path.resolve(skinDir, relative);
        assert.ok(
          resolved.startsWith(`${skinDir}${path.sep}`),
          `${id}: asset ${key} escapes its skin directory`,
        );
        const stat = await fs.stat(resolved);
        assert.ok(stat.isFile() && stat.size > 0, `${id}: asset ${key} must resolve to a non-empty file`);
      }

      const calls = assetVarCalls(css);
      assert.ok(calls.length > 0, `${id}: theme CSS does not reference any material asset variables`);
      for (const call of calls) {
        assert.ok(
          !declaredMotion.has(call.key),
          `${id}: motion-only asset ${call.key} cannot be referenced through a CSS asset variable`,
        );
        const fallbackResolves = call.fallbackKeys.some((key) => declaredStatic.has(key));
        assert.ok(
          declaredStatic.has(call.key) || fallbackResolves,
          `${id}: ${call.excerpt} references no declared asset or declared asset fallback`,
        );
      }
    });
  }
});
