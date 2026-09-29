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
