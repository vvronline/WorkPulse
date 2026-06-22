/**
 * Inter typeface — the font Signal-Android uses for its UI. We bundle the same
 * family so the WorkPulse chat (and the rest of the app) matches Signal's
 * typography exactly.
 *
 * Usage:
 *  - `interFontMap` is passed to expo-font's `useFonts(...)` in app/_layout.tsx
 *    so the .ttf files are loaded once at startup before the UI renders.
 *  - `FONTS` exposes the loaded family NAMES to reference in StyleSheet
 *    `fontFamily`. React Native on Android resolves a weight by its registered
 *    family name (NOT by fontWeight on a custom family), so each weight is a
 *    distinct family here.
 *
 * The theme (src/theme.ts) re-exports these as `fontRegular/Medium/SemiBold/Bold`
 * so components read them off the reactive theme object like any other token.
 */
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from "@expo-google-fonts/inter";

/** Font-family names referenced from StyleSheet `fontFamily`. */
export const FONTS = {
  regular: "Inter_400Regular",
  medium: "Inter_500Medium",
  semiBold: "Inter_600SemiBold",
  bold: "Inter_700Bold",
} as const;

/** Map handed to expo-font's `useFonts(...)` loader at app startup. */
export const interFontMap = {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} as const;