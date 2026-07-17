import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_BUNDLE_ID,
  candidateBundlePaths,
  commandBelongsToApp,
  discoverCodexApp,
  parseMainProcessTable,
} from "../src/codex-app.mjs";

const codexApp = (bundle, executableName = "ChatGPT") => ({
  bundle,
  bundleId: CODEX_BUNDLE_ID,
  executable: `${bundle}/Contents/MacOS/${executableName}`,
  version: "26.715.21425",
});

test("candidateBundlePaths covers pre- and post-rebrand names", () => {
  assert.deepEqual(candidateBundlePaths({ HOME: "/Users/tester" }), [
    "/Applications/Codex.app",
    "/Applications/ChatGPT.app",
    "/Users/tester/Applications/Codex.app",
    "/Users/tester/Applications/ChatGPT.app",
  ]);
});

test("CODEX_APP_PATH is the only candidate when explicitly set", () => {
  assert.deepEqual(candidateBundlePaths({
    HOME: "/Users/tester",
    CODEX_APP_PATH: "/Volumes/Tools/Codex Preview.app",
  }), ["/Volumes/Tools/Codex Preview.app"]);
});

test("discovery falls through from legacy Codex.app to rebranded ChatGPT.app", async () => {
  const candidates = ["/Applications/Codex.app", "/Applications/ChatGPT.app"];
  const inspected = [];
  const app = await discoverCodexApp({
    env: {},
    candidates,
    inspect: async (bundle) => {
      inspected.push(bundle);
      if (bundle.endsWith("Codex.app")) throw new Error("missing");
      return codexApp(bundle);
    },
  });

  assert.deepEqual(inspected, candidates);
  assert.deepEqual(app, codexApp("/Applications/ChatGPT.app"));
});

test("discovery rejects ChatGPT Classic and keeps scanning", async () => {
  const app = await discoverCodexApp({
    env: {},
    candidates: ["/Applications/ChatGPT.app", "/Users/tester/Applications/ChatGPT.app"],
    inspect: async (bundle) => bundle.startsWith("/Applications/") ? null : codexApp(bundle),
  });

  assert.equal(app.bundle, "/Users/tester/Applications/ChatGPT.app");
  assert.equal(app.bundleId, CODEX_BUNDLE_ID);
});

test("discovery selects the only running app when multiple installs coexist", async () => {
  const legacy = codexApp("/Applications/Codex.app");
  const rebranded = codexApp("/Applications/ChatGPT.app");
  const app = await discoverCodexApp({
    env: {},
    candidates: [legacy.bundle, rebranded.bundle],
    inspect: async (bundle) => bundle === legacy.bundle ? legacy : rebranded,
    findPids: async (candidate) => candidate.bundle === rebranded.bundle ? [42] : [],
  });

  assert.equal(app.bundle, rebranded.bundle);
});

test("discovery refuses to guess between multiple idle installs", async () => {
  const apps = [codexApp("/Applications/Codex.app"), codexApp("/Applications/ChatGPT.app")];
  await assert.rejects(
    discoverCodexApp({
      env: {},
      candidates: apps.map((app) => app.bundle),
      inspect: async (bundle) => apps.find((app) => app.bundle === bundle),
      findPids: async () => [],
    }),
    /Multiple Codex app installations were found; set CODEX_APP_PATH/,
  );
});

test("invalid CODEX_APP_PATH fails instead of silently falling back", async () => {
  await assert.rejects(
    discoverCodexApp({
      env: { CODEX_APP_PATH: "/Applications/ChatGPT.app" },
      candidates: ["/Applications/ChatGPT.app"],
      inspect: async () => null,
    }),
    /CODEX_APP_PATH does not point to the Codex app/,
  );
});

test("process matching is pinned to the concrete bundle executable", () => {
  const app = codexApp("/Applications/ChatGPT Preview (Beta).app", "ChatGPT+");
  assert.deepEqual(parseMainProcessTable(`
    123 ${app.executable}
    124 ${app.executable} Helper
    125 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT
  `, app), [123]);
  assert.equal(commandBelongsToApp(app.executable, app), true);
  assert.equal(commandBelongsToApp(`${app.executable} --remote-debugging-port=9345`, app), true);
  assert.equal(commandBelongsToApp(`${app.executable}-helper --type=renderer`, app), false);
  assert.equal(commandBelongsToApp("/Applications/ChatGPT.app/Contents/MacOS/ChatGPT", app), false);
});
