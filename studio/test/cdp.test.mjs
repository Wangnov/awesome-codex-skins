import test from "node:test";
import assert from "node:assert/strict";

import {
  connectCodexTargets,
  hasVerifiableShellMarkers,
  isThemeExcludedTarget,
  isVerifyAuxiliaryTarget,
  partitionVerifyTargets,
  summarizeVerifyResults,
  waitForVerifyTargets,
} from "../src/cdp.mjs";

function connectedTarget({ id, url, title = "ChatGPT", markers }) {
  return {
    target: { id, url, title },
    session: { id: `session-${id}` },
    probe: { title, href: url, markers, codex: true },
  };
}

test("pet overlay targets are excluded from skin injection", () => {
  for (const url of [
    "app://-/index.html?initialRoute=%2Favatar-overlay",
    "app://-/avatar-overlay",
    "app://-/avatar-overlay-composition-surface.html?surfaceId=mascot-badge",
    "app://-/avatar-overlay-composition-surface.html?surfaceId=activity-slot-0",
    "app://-/avatar-overlay-composition-surface.html?surfaceId=activity-slot-1",
  ]) {
    assert.equal(isThemeExcludedTarget({ url }), true, url);
  }
});

test("regular Codex targets remain skin eligible", () => {
  for (const url of [
    "app://-/index.html",
    "app://-/index.html?initialRoute=%2Fsettings",
    "app://-/index.html?initialRoute=%2Fquick-chat",
    "app://-/avatar-settings.html",
  ]) {
    assert.equal(isThemeExcludedTarget({ url }), false, url);
  }
});

test("malformed and non-app URLs are not classified as Codex pet targets", () => {
  assert.equal(isThemeExcludedTarget({ url: "not a URL" }), false);
  assert.equal(isThemeExcludedTarget({ url: "https://example.com/avatar-overlay" }), false);
});

test("verify discovery keeps polling when only an auxiliary target appears first", async () => {
  const quickChat = { id: "quick-chat", title: "ChatGPT", url: "app://-/index.html?initialRoute=%2Fquick-chat" };
  const main = { id: "main", title: "ChatGPT", url: "app://-/index.html" };
  let currentTime = 0;
  let listCount = 0;
  let sessionCount = 0;
  const closedSessions = [];

  const connected = await connectCodexTargets(9345, 1000, {
    requireVerifyPrimary: true,
    now: () => currentTime,
    wait: async (delayMs) => { currentTime += delayMs; },
    listTargets: async () => (++listCount === 1 ? [quickChat] : [quickChat, main]),
    openTarget: async (target) => {
      const id = `${target.id}-${++sessionCount}`;
      return { id, target, close: () => closedSessions.push(id) };
    },
    inspectSession: async (session) => ({
      title: session.target.title,
      href: session.target.url,
      markers: session.target.id === "main"
        ? { shell: true, sidebar: true, composer: true, main: false }
        : { shell: false, sidebar: false, composer: false, main: false },
      codex: true,
    }),
  });

  assert.equal(listCount, 2);
  assert.deepEqual(connected.map((entry) => entry.target.id), ["quick-chat", "main"]);
  assert.deepEqual(closedSessions, ["quick-chat-1"], "the superseded auxiliary session must be closed");
  for (const { session } of connected) session.close();
});

test("verify discovery returns its final auxiliary set at the deadline for a clear failure report", async () => {
  const quickChat = { id: "quick-chat", title: "ChatGPT", url: "app://-/index.html?initialRoute=%2Fquick-chat" };
  let currentTime = 0;
  let listCount = 0;
  let sessionCount = 0;
  const closedSessions = [];

  const connected = await connectCodexTargets(9345, 700, {
    requireVerifyPrimary: true,
    now: () => currentTime,
    wait: async (delayMs) => { currentTime += delayMs; },
    listTargets: async () => { listCount += 1; return [quickChat]; },
    openTarget: async (target) => {
      const id = `${target.id}-${++sessionCount}`;
      return { id, target, close: () => closedSessions.push(id) };
    },
    inspectSession: async (session) => ({
      title: session.target.title,
      href: session.target.url,
      markers: { shell: false, sidebar: false, composer: false, main: false },
      codex: true,
    }),
  });
  const partition = await waitForVerifyTargets(connected, 0);
  const summary = summarizeVerifyResults([], partition);

  assert.equal(currentTime, 700);
  assert.equal(listCount, 2);
  assert.deepEqual(closedSessions, ["quick-chat-1"]);
  assert.equal(summary.pass, false);
  assert.match(summary.error, /only auxiliary renderers/);
  for (const { session } of connected) session.close();
});

test("verify keeps a structural main target and reports auxiliary targets as skipped without waiting", async () => {
  const main = connectedTarget({
    id: "main",
    url: "app://-/index.html",
    markers: { shell: true, sidebar: true, composer: true, main: false },
  });
  const prewarm = connectedTarget({
    id: "prewarm",
    url: "app://-/index.html?initialRoute=%2Fspace%2Flocal-page%3Fprewarm%3D1",
    markers: { shell: true, sidebar: false, composer: false, main: false },
  });
  const detached = connectedTarget({
    id: "detached",
    url: "app://-/detached-window.html?initialRoute=%2Fdetached-window",
    markers: { shell: false, sidebar: false, composer: false, main: false },
  });
  const quickChat = connectedTarget({
    id: "quick-chat",
    url: "app://-/index.html?initialRoute=%2Fquick-chat",
    markers: { shell: false, sidebar: false, composer: false, main: false },
  });

  let reprobes = 0;
  const { targets, skippedTargets } = await waitForVerifyTargets(
    [main, prewarm, detached, quickChat],
    20000,
    { probe: async () => { reprobes += 1; } },
  );

  assert.deepEqual(targets, [main]);
  assert.deepEqual(skippedTargets.map((target) => target.targetId), ["prewarm", "detached", "quick-chat"]);
  assert.ok(skippedTargets.every((target) => target.reason === "known-auxiliary-renderer"));
  assert.equal(reprobes, 0, "a stable structural main should make verification start immediately");
  assert.deepEqual(summarizeVerifyResults([{ result: { pass: true } }]), { pass: true, error: null });
});

test("verify re-probes a title-matched renderer until its shell mounts", async () => {
  const mountingMain = connectedTarget({
    id: "mounting-main",
    url: "app://-/index.html",
    markers: { shell: false, sidebar: false, composer: false, main: false },
  });
  let currentTime = 0;
  let probeCount = 0;

  const partition = await waitForVerifyTargets(
    [mountingMain],
    1000,
    {
      pollIntervalMs: 100,
      now: () => currentTime,
      wait: async (delayMs) => { currentTime += delayMs; },
      probe: async () => {
        probeCount += 1;
        return {
          ...mountingMain.probe,
          markers: { shell: true, sidebar: true, composer: true, main: false },
        };
      },
    },
  );

  assert.equal(probeCount, 1);
  assert.equal(partition.targets.length, 1);
  assert.equal(partition.targets[0].target.id, "mounting-main");
  assert.deepEqual(partition.skippedTargets, []);
});

test("a structurally ready prewarm target cannot hide a mounting primary window", async () => {
  const mountingMain = connectedTarget({
    id: "mounting-main",
    url: "app://-/index.html",
    markers: { shell: false, sidebar: false, composer: false, main: false },
  });
  const readyPrewarm = connectedTarget({
    id: "ready-prewarm",
    url: "app://-/index.html?initialRoute=%2Fspace%2Fpage%3Fprewarm%3D1",
    markers: { shell: true, sidebar: true, composer: true, main: false },
  });
  let currentTime = 0;
  let probeCount = 0;

  const result = await waitForVerifyTargets(
    [readyPrewarm, mountingMain],
    1000,
    {
      pollIntervalMs: 100,
      now: () => currentTime,
      wait: async (delayMs) => { currentTime += delayMs; },
      probe: async (session) => {
        probeCount += 1;
        assert.equal(session.id, "session-mounting-main", "known auxiliary targets must not be re-probed");
        return {
          ...mountingMain.probe,
          markers: { shell: true, sidebar: true, composer: true, main: false },
        };
      },
    },
  );

  assert.equal(probeCount, 1);
  assert.deepEqual(result.targets.map((entry) => entry.target.id), ["mounting-main"]);
  assert.deepEqual(result.skippedTargets.map((entry) => entry.targetId), ["ready-prewarm"]);
  assert.deepEqual(result.unreadyTargets, []);
});

test("verify fails when any structurally valid main target fails", () => {
  const connected = ["main-a", "main-b"].map((id) => connectedTarget({
    id,
    url: `app://-/index.html?window=${id}`,
    markers: { shell: true, sidebar: true, composer: true, main: false },
  }));
  const { targets, skippedTargets } = partitionVerifyTargets(connected);
  const results = targets.map((entry, index) => ({
    targetId: entry.target.id,
    result: { pass: index === 0 },
  }));

  assert.equal(targets.length, 2, "both structural mains must be verified");
  assert.deepEqual(skippedTargets, []);
  assert.deepEqual(summarizeVerifyResults(results), { pass: false, error: null });
});

test("verify still fails clearly after the shell re-probe deadline expires", async () => {
  const mountingMain = connectedTarget({
    id: "mounting-main",
    url: "app://-/index.html",
    markers: { shell: false, sidebar: false, composer: false, main: false },
  });
  let currentTime = 0;
  let probeCount = 0;
  const partition = await waitForVerifyTargets(
    [mountingMain],
    300,
    {
      pollIntervalMs: 100,
      now: () => currentTime,
      wait: async (delayMs) => { currentTime += delayMs; },
      probe: async () => {
        probeCount += 1;
        return mountingMain.probe;
      },
    },
  );
  const summary = summarizeVerifyResults([], partition);

  assert.deepEqual(partition.targets, []);
  assert.equal(partition.skippedTargets.length, 0);
  assert.equal(partition.unreadyTargets.length, 1);
  assert.equal(probeCount, 3);
  assert.equal(summary.pass, false);
  assert.match(summary.error, /did not expose verifiable shell markers before timeout/);
});

test("verify fails immediately when every connected renderer is a known auxiliary", async () => {
  const auxiliaries = [
    connectedTarget({
      id: "prewarm",
      url: "app://-/index.html?initialRoute=%2Fspace%2Fpage%3Fprewarm%3D1",
      markers: { shell: true, sidebar: true, composer: true, main: false },
    }),
    connectedTarget({
      id: "detached",
      url: "app://-/detached-window.html?initialRoute=%2Fdetached-window",
      markers: { shell: false, sidebar: false, composer: false, main: false },
    }),
  ];
  let reprobes = 0;
  const partition = await waitForVerifyTargets(auxiliaries, 20000, {
    probe: async () => { reprobes += 1; },
  });
  const summary = summarizeVerifyResults([], partition);

  assert.equal(reprobes, 0);
  assert.equal(partition.primaryCandidateCount, 0);
  assert.deepEqual(partition.targets, []);
  assert.equal(partition.skippedTargets.length, 2);
  assert.equal(summary.pass, false);
  assert.match(summary.error, /only auxiliary renderers/);
});

test("legacy quick-chat prewarm routes cannot become primary verify targets", async () => {
  const quickChatTargets = [
    connectedTarget({
      id: "quick-chat",
      url: "app://-/index.html?initialRoute=%2Fquick-chat",
      markers: { shell: false, sidebar: false, composer: false, main: false },
    }),
    connectedTarget({
      id: "quick-chat-child",
      url: "app://-/index.html?initialRoute=%2Fquick-chat%2Fprewarm",
      markers: { shell: false, sidebar: false, composer: false, main: false },
    }),
  ];
  const partition = await waitForVerifyTargets(quickChatTargets, 20000, {
    probe: async () => assert.fail("known quick-chat auxiliary targets must not be re-probed"),
  });
  const summary = summarizeVerifyResults([], partition);

  assert.equal(partition.primaryCandidateCount, 0);
  assert.deepEqual(partition.skippedTargets.map((entry) => entry.targetId), ["quick-chat", "quick-chat-child"]);
  assert.equal(summary.pass, false);
  assert.match(summary.error, /only auxiliary renderers/);
});

test("query-string routes without an auxiliary signal remain primary candidates", () => {
  const queryMain = connectedTarget({
    id: "settings-main",
    url: "app://-/index.html?initialRoute=%2Fsettings",
    markers: { shell: true, sidebar: true, composer: false, main: true },
  });
  const partition = partitionVerifyTargets([queryMain]);

  assert.equal(isVerifyAuxiliaryTarget(queryMain.target), false);
  assert.equal(isVerifyAuxiliaryTarget({
    url: "app://-/index.html?initialRoute=%2Fquick-chatter",
  }), false, "route-prefix lookalikes must remain primary candidates");
  assert.deepEqual(partition.targets, [queryMain]);
  assert.equal(partition.primaryCandidateCount, 1);
});

test("legacy role-main marker remains a valid structural shell fallback", () => {
  const legacyProbe = {
    markers: { shell: true, sidebar: true, composer: false, main: true },
  };

  assert.equal(hasVerifiableShellMarkers(legacyProbe), true);
});
