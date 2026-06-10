import type { ExpoConfig, ConfigContext } from "expo/config";

// Default backend targets. Override per-build via environment variables
// (EAS secrets / .env) without touching source.
const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_BASE_URL || "https://workpulse-prod.up.railway.app/api";
const WS_BASE_URL =
  process.env.EXPO_PUBLIC_WS_BASE_URL || "wss://workpulse-prod.up.railway.app";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "WorkPulse",
  slug: "workpulse",
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/icon.png",
  scheme: "workpulse",
  userInterfaceStyle: "automatic",
  ios: {
    supportsTablet: true,
    bundleIdentifier: "app.workpulse.mobile",
  },
  android: {
    package: "app.workpulse.mobile",
    adaptiveIcon: {
      backgroundColor: "#E6F4FE",
      foregroundImage: "./assets/android-icon-foreground.png",
      backgroundImage: "./assets/android-icon-background.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: false,
  },
  web: {
    favicon: "./assets/favicon.png",
  },
  plugins: ["expo-router", "expo-secure-store"],
  extra: {
    API_BASE_URL,
    WS_BASE_URL,
  },
});
