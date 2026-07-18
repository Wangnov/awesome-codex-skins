// Canonical validation and serialization for a package's native Codex theme.
//
// Codex's Settings > Appearance importer accepts one `codex-theme-v1:` string
// per light/dark variant. Theme packages keep the structured source of truth;
// AppManager can deterministically derive the two official import strings from
// it without persisting a second, potentially divergent copy.

export const CODEX_THEME_SHARE_PREFIX = "codex-theme-v1:";
export const CODEX_THEME_VARIANTS = Object.freeze(["dark", "light"]);

const HEX6_PATTERN = /^#[0-9a-f]{6}$/i;
const CODE_THEME_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const REQUIRED_COLORS = Object.freeze(["accent", "ink", "surface"]);
const REQUIRED_SEMANTIC_COLORS = Object.freeze(["diffAdded", "diffRemoved", "skill"]);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function relativeLuminance(hex) {
  const channels = hex.slice(1).match(/../g).map((part) => Number.parseInt(part, 16) / 255);
  const linear = channels.map((value) => value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4);
  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
}

export function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function validateVariant(value, path, problems, minimumContrast) {
  if (!isObject(value)) {
    problems.push(`${path} must be an object`);
    return;
  }
  for (const key of REQUIRED_COLORS) {
    if (!HEX6_PATTERN.test(value[key] ?? "")) problems.push(`${path}.${key} must be #RRGGBB`);
  }
  if (!Number.isInteger(value.contrast) || value.contrast < 0 || value.contrast > 100) {
    problems.push(`${path}.contrast must be an integer from 0 to 100`);
  }
  if (typeof value.opaqueWindows !== "boolean") {
    problems.push(`${path}.opaqueWindows must be a boolean`);
  }
  if (!isObject(value.fonts)) {
    problems.push(`${path}.fonts must be an object`);
  } else {
    for (const key of ["code", "ui"]) {
      const font = value.fonts[key];
      if (font !== null && (typeof font !== "string" || !font.trim() || font.length > 240)) {
        problems.push(`${path}.fonts.${key} must be null or a non-empty string up to 240 characters`);
      }
    }
  }
  if (!isObject(value.semanticColors)) {
    problems.push(`${path}.semanticColors must be an object`);
  } else {
    for (const key of REQUIRED_SEMANTIC_COLORS) {
      if (!HEX6_PATTERN.test(value.semanticColors[key] ?? "")) {
        problems.push(`${path}.semanticColors.${key} must be #RRGGBB`);
      }
    }
  }
  if (HEX6_PATTERN.test(value.ink ?? "") && HEX6_PATTERN.test(value.surface ?? "")) {
    const ratio = contrastRatio(value.ink, value.surface);
    if (ratio < minimumContrast) {
      problems.push(`${path} ink/surface contrast ${ratio.toFixed(2)}:1 is below ${minimumContrast}:1`);
    }
  }
}

export function validateCodexTheme(codexTheme, options = {}) {
  const {
    requireCodeThemeIds = true,
    minimumContrast = 4.5,
  } = options;
  const problems = [];
  if (!isObject(codexTheme)) return ["codexTheme must be an object"];

  if (!["dark", "light", "system"].includes(codexTheme.appearanceTheme)) {
    problems.push("codexTheme.appearanceTheme must be dark, light, or system");
  }
  for (const variant of CODEX_THEME_VARIANTS) {
    validateVariant(codexTheme[variant], `codexTheme.${variant}`, problems, minimumContrast);
  }

  if (!isObject(codexTheme.codeThemeIds)) {
    if (requireCodeThemeIds) problems.push("codexTheme.codeThemeIds must be an object");
  } else {
    for (const variant of CODEX_THEME_VARIANTS) {
      const id = codexTheme.codeThemeIds[variant];
      if (!CODE_THEME_ID_PATTERN.test(id ?? "")) {
        problems.push(`codexTheme.codeThemeIds.${variant} must be a valid Codex code theme id`);
      }
    }
  }
  return problems;
}

export function buildCodexThemeSharePayload(codexTheme, variant) {
  if (!CODEX_THEME_VARIANTS.includes(variant)) throw new Error(`unsupported Codex theme variant: ${variant}`);
  const problems = validateCodexTheme(codexTheme);
  if (problems.length) throw new Error(`invalid codexTheme: ${problems.join("; ")}`);
  const source = codexTheme[variant];
  return {
    codeThemeId: codexTheme.codeThemeIds[variant],
    theme: {
      accent: source.accent,
      contrast: source.contrast,
      fonts: { code: source.fonts.code, ui: source.fonts.ui },
      ink: source.ink,
      opaqueWindows: source.opaqueWindows,
      semanticColors: {
        diffAdded: source.semanticColors.diffAdded,
        diffRemoved: source.semanticColors.diffRemoved,
        skill: source.semanticColors.skill,
      },
      surface: source.surface,
    },
    variant,
  };
}

export function buildCodexThemeShareString(codexTheme, variant) {
  return `${CODEX_THEME_SHARE_PREFIX}${JSON.stringify(buildCodexThemeSharePayload(codexTheme, variant))}`;
}

export function verifyCodexThemeShareString(value, expectedVariant) {
  if (typeof value !== "string" || !value.startsWith(CODEX_THEME_SHARE_PREFIX)) return false;
  try {
    const payload = JSON.parse(value.slice(CODEX_THEME_SHARE_PREFIX.length));
    return payload?.variant === expectedVariant
      && typeof payload?.codeThemeId === "string"
      && isObject(payload?.theme)
      && isObject(payload.theme.fonts)
      && isObject(payload.theme.semanticColors);
  } catch {
    return false;
  }
}
