/**
 * Design tokens mirrored from the web client's global.css (Notion-style dark
 * theme). Keep these in sync with client/src/global.css `:root`/`[data-theme="dark"]`.
 */
export const theme = {
  // Brand
  primary: "#2383e2",
  primaryLight: "#529cca",
  primaryDark: "#1a6dbe",
  primaryGlow: "rgba(35, 131, 226, 0.15)",
  onAccent: "#ffffff",

  // Status
  success: "#4daa57",
  warning: "#cb912f",
  danger: "#e03e3e",

  // Surfaces (dark)
  bg: "#191919",
  bgSecondary: "#202020",
  bgElevated: "#252525",
  surface: "rgba(255, 255, 255, 0.04)",
  surfaceHover: "rgba(255, 255, 255, 0.07)",
  glass: "rgba(255, 255, 255, 0.045)",
  glassBorder: "rgba(255, 255, 255, 0.09)",
  cardBg: "rgba(255, 255, 255, 0.035)",
  border: "rgba(255, 255, 255, 0.09)",

  // Inputs
  inputBg: "rgba(255, 255, 255, 0.065)",
  inputBorder: "rgba(255, 255, 255, 0.1)",
  inputBorderFocus: "rgba(35, 131, 226, 0.6)",

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
} as const;

export type Theme = typeof theme;
