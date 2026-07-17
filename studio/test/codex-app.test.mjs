import assert from "node:assert/strict";
import test from "node:test";

import {
  CodexAppAmbiguousError,
  CODEX_BUNDLE_ID,
  candidateBundlePaths,
  commandBelongsToApp,
  discoverCodexApp,
  discoverCodexAppForStop,
  discoverManagedCodexApp,
  findRunningCodexApps,
  parseMainProcessTable,
  parseRunningAppBundlePaths,
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
    (error) => error instanceof CodexAppAmbiguousError
      && /Multiple Codex app installations were found; set CODEX_APP_PATH/.test(error.message),
  );
});

test("managed discovery reuses a persisted nonstandard bundle", async () => {
  const persisted = codexApp("/Volumes/Tools/Codex Preview.app");
  const inspected = [];
  const app = await discoverManagedCodexApp(persisted.bundle, {
    env: {},
    candidates: ["/Applications/Codex.app"],
    inspect: async (bundle) => {
      inspected.push(bundle);
      return bundle === persisted.bundle ? persisted : null;
    },
  });

  assert.equal(app.bundle, persisted.bundle);
  assert.deepEqual(inspected, [persisted.bundle]);
});

test("stop discovery tolerates multiple idle installations", async () => {
  const app = await discoverCodexAppForStop(null, {
    env: {},
    discover: async () => { throw new CodexAppAmbiguousError("multiple idle apps"); },
    findRunning: async () => [],
  });

  assert.equal(app, null);
});

test("stop discovery selects the sole running installation after ambiguity", async () => {
  const running = codexApp("/Applications/ChatGPT.app");
  const app = await discoverCodexAppForStop(null, {
    env: {},
    discover: async () => { throw new CodexAppAmbiguousError("multiple installed apps"); },
    findRunning: async () => [{ ...running, pids: [42] }],
  });

  assert.equal(app.bundle, running.bundle);
});

test("explicit override takes precedence over a persisted bundle", async () => {
  const persisted = codexApp("/Volumes/Tools/Codex Preview.app");
  const override = codexApp("/Applications/ChatGPT.app");
  const app = await discoverManagedCodexApp(persisted.bundle, {
    env: { CODEX_APP_PATH: override.bundle },
    candidates: [override.bundle],
    inspect: async (bundle) => bundle === override.bundle ? override : null,
  });

  assert.equal(app.bundle, override.bundle);
});

test("running-app scan includes persisted, overridden, and standard installs", async () => {
  const apps = [
    codexApp("/Volumes/Tools/Persisted.app"),
    codexApp("/Volumes/Tools/Override.app"),
    codexApp("/Applications/Codex.app"),
  ];
  const running = await findRunningCodexApps({
    env: { HOME: "/Users/tester", CODEX_APP_PATH: apps[1].bundle },
    additionalBundles: [apps[0].bundle],
    inspect: async (bundle) => apps.find((app) => app.bundle === bundle) ?? null,
    findPids: async (app) => app.bundle === apps[1].bundle ? [] : [apps.indexOf(app) + 100],
    findRunningBundles: async () => [],
  });

  assert.deepEqual(running.map((app) => [app.bundle, app.pids]), [
    [apps[0].bundle, [100]],
    [apps[2].bundle, [102]],
  ]);
});

test("running-app scan discovers identity-gated bundles from the process table", async () => {
  const nonstandard = codexApp("/Volumes/Tools/Codex Nightly.app", "Codex Nightly");
  const classic = codexApp("/Volumes/Tools/ChatGPT Classic.app");
  const running = await findRunningCodexApps({
    env: {},
    inspect: async (bundle) => bundle === nonstandard.bundle
      ? nonstandard
      : bundle === classic.bundle ? null : null,
    findPids: async (app) => app.bundle === nonstandard.bundle ? [201] : [],
    findRunningBundles: async () => [nonstandard.bundle, classic.bundle],
  });

  assert.deepEqual(running.map((app) => [app.bundle, app.pids]), [
    [nonstandard.bundle, [201]],
  ]);
});

test("process-table bundle parsing covers arbitrary app paths and ignores helpers", () => {
  assert.deepEqual(parseRunningAppBundlePaths(`
    201 /Volumes/Tools/Codex Nightly.app/Contents/MacOS/Codex Nightly
    202 /Volumes/Tools/Codex Nightly.app/Contents/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper
    203 /usr/bin/node
    204 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT
    205 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT
  `), [
    "/Volumes/Tools/Codex Nightly.app",
    "/Volumes/Tools/Codex Nightly.app/Contents/Frameworks/Codex Helper.app",
    "/Applications/ChatGPT.app",
  ]);
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
