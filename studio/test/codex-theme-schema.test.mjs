import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCodexThemeShareString,
  validateCodexTheme,
  verifyCodexThemeShareString,
} from "../src/codex-theme-schema.mjs";

const variantBlock = () => ({
  accent: "#d94a57",
  ink: "#2a1e22",
  surface: "#f5eef0",
  contrast: 40,
  opaqueWindows: true,
  fonts: { code: "Maple Mono", ui: "Inter" },
  semanticColors: { diffAdded: "#1d9e75", diffRemoved: "#d85a30", skill: "#7f77dd" },
});

const validTheme = () => ({
  appearanceTheme: "dark",
  codeThemeIds: { dark: "cts-dark", light: "cts-light" },
  dark: variantBlock(),
  light: variantBlock(),
});

test("a fully specified theme validates and round-trips", () => {
  const theme = validTheme();
  assert.deepEqual(validateCodexTheme(theme, { requireCodeThemeIds: true }), []);
  for (const variant of ["dark", "light"]) {
    assert.equal(verifyCodexThemeShareString(buildCodexThemeShareString(theme, variant), variant), true);
  }
});

test("an omitted font key means 'keep the Codex default' and stays valid", () => {
  const omitted = validTheme();
  delete omitted.dark.fonts.ui;
  assert.deepEqual(validateCodexTheme(omitted, { requireCodeThemeIds: true }), []);
  // The share string normalizes the omission to an explicit null: omitting a
  // font and spelling out null must serialize identically.
  const explicit = validTheme();
  explicit.dark.fonts.ui = null;
  assert.equal(
    buildCodexThemeShareString(omitted, "dark"),
    buildCodexThemeShareString(explicit, "dark"),
  );
  assert.equal(verifyCodexThemeShareString(buildCodexThemeShareString(omitted, "dark"), "dark"), true);
});

test("a non-string font is still rejected", () => {
  const theme = validTheme();
  theme.dark.fonts.ui = 42;
  const problems = validateCodexTheme(theme, { requireCodeThemeIds: true });
  assert.equal(problems.some((p) => p.includes("fonts.ui")), true);
});
