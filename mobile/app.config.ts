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
    // Permissions for voice notes (RECORD_AUDIO) and audio/video calls
    // (CAMERA, MODIFY_AUDIO_SETTINGS, network state for WebRTC).
    permissions: [
      "android.permission.RECORD_AUDIO",
      "android.permission.CAMERA",
      "android.permission.MODIFY_AUDIO_SETTINGS",
      "android.permission.ACCESS_NETWORK_STATE",
      "android.permission.ACCESS_FINE_LOCATION",
      "android.permission.ACCESS_COARSE_LOCATION",
    ],
  },
  web: {
    favicon: "./assets/favicon.png",
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    [
      "expo-audio",
      {
        microphonePermission:
          "Allow WorkPulse to access your microphone to record voice messages and make calls.",
      },
    ],
    [
      "@config-plugins/react-native-webrtc",
      {
        cameraPermission:
          "Allow WorkPulse to access your camera for video calls.",
        microphonePermission:
          "Allow WorkPulse to access your microphone for calls.",
      },
    ],
    [
      "expo-camera",
      {
        cameraPermission:
          "Allow WorkPulse to access your camera for face enrollment and attendance verification.",
      },
    ],
    [
      "expo-location",
      {
        locationAlwaysAndWhenInUsePermission:
          "Allow WorkPulse to use your location to verify office attendance at clock-in.",
        locationWhenInUsePermission:
          "Allow WorkPulse to use your location to verify office attendance at clock-in.",
      },
    ],
    "expo-sharing",
  ],
  extra: {
    API_BASE_URL,
    WS_BASE_URL,
  },
});
