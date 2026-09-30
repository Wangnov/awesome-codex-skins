// Assertions for the CI-only runtime smoke test (scripts/ci-runtime-smoke.mjs),
// kept in a module of their own so they can be unit-tested offline.
//
// A CI launch is logged out and lands on the sign-in page, which has none of
// the signed-in shell chrome (main surface, composer, left panel) that
// verifyExpression().pass requires. So the smoke test must NOT assert `pass`;
// it asserts only what the injected runtime can guarantee on any route.
import { STUDIO_VERSION } from "./payload.mjs";

export function installedOk(id, result, version = STUDIO_VERSION) {
  return Boolean(
    result?.installed &&
    result.stylePresent &&
    result.themeId === id &&
    result.version === version,
  );
}

export function pickInstallState(result) {
  return {
    installed: result?.installed ?? null,
    stylePresent: result?.stylePresent ?? null,
    themeId: result?.themeId ?? null,
    version: result?.version ?? null,
  };
}

// ---- Renderer-exception attribution -------------------------------------
//
// A logged-out Codex is noisy on its own (sign-in / 401 / telemetry / plugin
// warm-up errors fire on timers regardless of any skin), so "an uncaught
// exception fired during this skin's window" says nothing about the skin.
// Two filters keep the smoke test from blaming a healthy skin:
//   1. a baseline recorded before any skin is injected: an exception whose
//      normalized key was already seen then is app noise and ignored;
//   2. attribution: an exception counts against the skin (fails the run) only
//      when it demonstrably comes from the injected runtime — its text or
//      stack names the runtime (`cts-*`, `__CODEX_THEME_STUDIO__`), or a stack
//      frame is anonymous (the payload is delivered through Runtime.evaluate
//      with no script URL, and the app's own bundles always have one).
// Novel exceptions that are not attributable are reported as warnings, not
// failures. That is a deliberate trade-off: a skin that crashes React from the
// app's own code path, with no frame in the injected script, is surfaced as a
// visible warning annotation instead of a red build, because on a logged-out
// launch we cannot tell it from unrelated app noise.

const RUNTIME_MARKER = /cts-|__CODEX_THEME_STUDIO|CODEX_THEME_STUDIO/;

// Summarize one Runtime.exceptionThrown `exceptionDetails` payload.
export function summarizeException(detail, targetUrl = "") {
  const frames = (detail?.stackTrace?.callFrames ?? []).map((f) => ({
    url: f.url ?? "",
    functionName: f.functionName ?? "",
  }));
  return {
    targetUrl,
    text: detail?.exception?.description ?? detail?.text ?? "unknown renderer exception",
    url: detail?.url ?? "",
    frames,
  };
}

// Stable identity for "the same exception" across time: first line of the
// message with volatile numbers/hex collapsed, plus the top frame's function.
export function exceptionKey(exc) {
  const firstLine = String(exc?.text ?? "").split("\n")[0].replace(/0x[0-9a-f]+|\d+/gi, "#").trim();
  const top = exc?.frames?.[0];
  return `${firstLine}|${top?.functionName ?? ""}|${top?.url ?? ""}`;
}

export function isRuntimeAttributed(exc) {
  if (RUNTIME_MARKER.test(String(exc?.text ?? ""))) return true;
  const frames = exc?.frames ?? [];
  if (frames.some((f) => RUNTIME_MARKER.test(`${f.url} ${f.functionName}`))) return true;
  return frames.some((f) => f.url === "");
}

// Split what fired during a skin's window into failures (attributed to the
// injected runtime), warnings (novel but unattributable) and ignored (already
// seen in the pre-injection baseline).
export function classifyExceptions(exceptions, baselineKeys) {
  const failures = [];
  const warnings = [];
  const ignored = [];
  for (const exc of exceptions) {
    if (isRuntimeAttributed(exc) && !baselineKeys.has(exceptionKey(exc))) failures.push(exc);
    else if (baselineKeys.has(exceptionKey(exc))) ignored.push(exc);
    else warnings.push(exc);
  }
  return { failures, warnings, ignored };
}
