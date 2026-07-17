import test from "node:test";
import assert from "node:assert/strict";

import { isThemeExcludedTarget } from "../src/cdp.mjs";

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
