 /**
 * Design tokens mirrored from the web client's global.css (Notion-style dark
 * theme). Keep these in sync with client/src/global.css `:root`/`[data-theme="dark"]`.
 *
 * The brand (accent) colour is tenant-customisable. `makeTheme(accent)` derives
 * the companion brand shades from the chosen accent the same way the web client
 * does with `color-mix(...)` in BrandingContext. Non-refactored modules can keep
 * importing the static `theme` (which equals `makeTheme(DEFAULT_ACCENT)`), while
 * reactive screens read the live theme via `useTheme()`.
 */

import { FONTS } from "./fonts";

export const DEFAULT_ACCENT = "#2383e2";

/* ── colour helpers ── */

function clamp(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const int = parseInt(h, 16);
  if (Number.isNaN(int) || h.length !== 6) {
    return { r: 35, g: 131, b: 226 }; // fallback to default accent
  }
  return {
    r: (int >> 16) & 255,
    g: (int >> 8) & 255,
    b: int & 255,
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => clamp(n).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Mix `hex` with white by `amount` (0..1). amount=0 → hex, 1 → white. */
function mixWhite(hex: string, amount: number): string {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex(
    r + (255 - r) * amount,
    g + (255 - g) * amount,
    b + (255 - b) * amount,
  );
}

/** Mix `hex` with black by `amount` (0..1). amount=0 → hex, 1 → black. */
function mixBlack(hex: string, amount: number): string {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex(r * (1 - amount), g * (1 - amount), b * (1 - amount));
}

/** rgba() string from a hex + alpha (0..1). */
function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Validate a 6-digit hex string. */
export function isValidHex(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

/**
 * Build a full theme object from a tenant accent colour. Brand shades are
 * derived so gradients, hovers and glows track the chosen accent.
 */
export function makeTheme(accent: string = DEFAULT_ACCENT) {
  const primary = isValidHex(accent) ? accent : DEFAULT_ACCENT;
  return {
    // Brand (derived from accent)
    primary,
    primaryLight: mixWhite(primary, 0.3),
    primaryDark: mixBlack(primary, 0.2),
    primaryGlow: withAlpha(primary, 0.15),
    onAccent: "#ffffff",

    // Status
    success: "#4daa57",
    warning: "#cb912f",
    danger: "#e03e3e",

    // Surfaces (dark)
    bg: "#131314",
    bgSecondary: "#1b1b1c",
    bgElevated: "#202021",
    chatHeaderSurface: "rgba(255, 255, 255, 0.05)",
    chatSegmentSurface: "rgba(255, 255, 255, 0.06)",
    chatSegmentBorder: "rgba(255, 255, 255, 0.12)",
    chatSegmentActiveSurface: "rgba(0, 0, 0, 0.3)",
    chatSegmentActiveBorder: withAlpha(primary, 0.58),
    chatSegmentActiveIndicator: primary,
    chatSegmentText: "rgba(255, 255, 255, 0.55)",
    chatSegmentTextActive: "rgba(255, 255, 255, 0.9)",
    chatTabBadgeBg: "#ef6073",
    chatTabBadgeBorder: "rgba(255, 255, 255, 0.18)",
    chatRowSurface: "rgba(255, 255, 255, 0.022)",
    chatRowBorder: "rgba(255, 255, 255, 0.08)",
    chatRowPressed: "rgba(255, 255, 255, 0.05)",
    chatRowSelected: withAlpha(primary, 0.2),
    chatRowSelectedBorder: withAlpha(primary, 0.68),
    chatEmptySurface: "rgba(255, 255, 255, 0.045)",
    surface: "rgba(255, 255, 255, 0.04)",
    surfaceHover: "rgba(255, 255, 255, 0.07)",
    // Signal-style chat bubbles: outgoing uses the solid brand accent (white
    // text); incoming is a flat, borderless dark surface. No tails — grouping
    // is conveyed purely through corner-radius variation.
    chatOutBg: primary,
    // Very light org-accent wash for OWN (sent) message bubbles so they read
    // subtly branded against incoming bubbles without the loud solid fill.
    chatOutBgSubtle: withAlpha(primary, 0.14),
    chatOutBorderSubtle: withAlpha(primary, 0.16),
    chatInBg: "#2a2a2e",
    chatBubbleBorder: "transparent",
    // Translucent white for the outgoing bubble footer (time / edited / ticks)
    // so it reads on the accent fill.
    chatOutMeta: "rgba(255, 255, 255, 0.7)",
    glass: "rgba(255, 255, 255, 0.045)",
    glassBorder: "rgba(255, 255, 255, 0.09)",
    cardBg: "rgba(255, 255, 255, 0.035)",
    border: "rgba(255, 255, 255, 0.09)",

    // Inputs
    inputBg: "rgba(255, 255, 255, 0.065)",
    inputBorder: "rgba(255, 255, 255, 0.1)",
    inputBorderFocus: withAlpha(primary, 0.6),

    // Text
    text: "rgba(255, 255, 255, 0.81)",
    textSecondary: "rgba(255, 255, 255, 0.53)",
    textMuted: "rgba(255, 255, 255, 0.38)",

    // Radius
    radius: 8,
    radiusSm: 6,
    radiusLg: 16,
    radiusXl: 24,
    radiusFull: 9999,

    // Typography — Inter (Signal's typeface). On Android a custom font's weight
    // is selected by its registered family NAME, not via `fontWeight`, so each
    // weight is exposed as a distinct family token here. Use these in place of
    // `fontWeight` on Text styles for the Signal-matching look.
    fontRegular: FONTS.regular,
    fontMedium: FONTS.medium,
    fontSemiBold: FONTS.semiBold,
    fontBold: FONTS.bold,
    // Pacifico script display face for the "loops" brand wordmark only.
    fontBrand: FONTS.brand,
  } as const;
}

export type Theme = ReturnType<typeof makeTheme>;

/**
 * Static default theme. Modules that haven't been migrated to the reactive
 * `useTheme()` hook import this directly — it stays valid and uses the
 * design-system default accent.
 */
export const theme: Theme = makeTheme(DEFAULT_ACCENT);