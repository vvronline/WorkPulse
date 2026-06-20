import type { ExpoConfig, ConfigContext } from "expo/config";
// Single source of truth for the app version. The mobile release workflow
// validates that the `mobile-vX.Y.Z` tag matches this value, and the in-app
// updater compares against it — so it MUST reflect the real shipped version
// (previously this was hardcoded to "1.0.0" which broke update comparisons).
import { version as APP_VERSION } from "./package.json";

// Default backend targets. Override per-build via environment variables
// (EAS secrets / .env) without touching source.
const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_BASE_URL || "https://workpulse-prod.up.railway.app/api";
const WS_BASE_URL =
  process.env.EXPO_PUBLIC_WS_BASE_URL || "wss://workpulse-prod.up.railway.app";
const ANDROID_GOOGLE_SERVICES_FILE =
  process.env.EXPO_ANDROID_GOOGLE_SERVICES_FILE ||
  process.env.GOOGLE_SERVICES_JSON ||
  "./google-services.json";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "WorkPulse",
  slug: "workpulse",
  version: APP_VERSION,
  // "default" lets the OS/device sensor control rotation so tablets (and phones
  // with auto-rotate enabled) can switch between portrait and landscape and the
  // UI re-aligns. Previously "portrait" injected android:screenOrientation="portrait"
  // into the manifest, hard-locking every Android screen (incl. tablets) to portrait.
  orientation: "default",
  icon: "./assets/icon.png",
  scheme: "workpulse",
  userInterfaceStyle: "automatic",
  ios: {
    supportsTablet: true,
    bundleIdentifier: "app.workpulse.mobile",
  },
  android: {
    package: "app.workpulse.mobile",
    googleServicesFile: ANDROID_GOOGLE_SERVICES_FILE,
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
      // Android 13+ runtime permission required for status-bar notifications.
      "android.permission.POST_NOTIFICATIONS",
      "android.permission.USE_FULL_SCREEN_INTENT",
      "android.permission.FOREGROUND_SERVICE_PHONE_CALL",
      "android.permission.WAKE_LOCK",
      "android.permission.VIBRATE",
      "android.permission.RECORD_AUDIO",
      "android.permission.CAMERA",
      "android.permission.MODIFY_AUDIO_SETTINGS",
      "android.permission.ACCESS_NETWORK_STATE",
      "android.permission.ACCESS_FINE_LOCATION",
      "android.permission.ACCESS_COARSE_LOCATION",
      // Required so the in-app updater can launch the system package installer
      // for the downloaded APK (see src/updater.ts).
      "android.permission.REQUEST_INSTALL_PACKAGES",
    ],
  },
  web: {
    favicon: "./assets/favicon.png",
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    // Native Firebase Cloud Messaging. These config plugins generate the
    // native code that registers FCM and enables background/terminated-state
    // push delivery via setBackgroundMessageHandler.
    "@react-native-firebase/app",
    "@react-native-firebase/messaging",
    [
      "expo-notifications",
      {
        // Ensures push notifications still post when the app process is dead.
        defaultChannel: "default",
        // NOTE: Do NOT set `icon`/`color` here. Those options inject
        // `com.google.firebase.messaging.default_notification_color` /
        // `..._icon` meta-data into the app manifest, which collides with the
        // same meta-data declared by @react-native-firebase/messaging and FAILS
        // the manifest merge (`processReleaseMainManifest`). The small icon is
        // cosmetic; Notifee falls back to the app default icon without it.
      },
    ],
    "./scripts/withFirebaseNotificationChannelOverride",
    // Remove the expo-notifications FCM service so @react-native-firebase/messaging
    // is the SOLE handler of com.google.firebase.MESSAGING_EVENT. Otherwise the
    // Expo service intercepts our DATA-ONLY call/message pushes and silently drops
    // them (no background handler fires → no Notifee call/message UI).
    "./scripts/withRemoveExpoFirebaseMessagingService",
    // Makes the main Activity show over the lock screen + turn the screen on so
    // full-screen-intent incoming-call notifications surface the call UI over
    // the lock screen without the SYSTEM_ALERT_WINDOW overlay permission.
    "./scripts/withAndroidCallActivityFlags",
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
    APP_VERSION,
  },
});
