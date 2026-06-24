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
// P3.15 — Android native incoming-call surface (react-native-callkeep) feature
// flag. DEFAULT OFF: the current callkeep build can crash at startup on some RN
// versions, so the native ConnectionService/CallStyle UI stays opt-in until a
// build is verified. Enable per-build via EXPO_PUBLIC_ANDROID_NATIVE_CALL_UI=true.
const ANDROID_NATIVE_CALL_UI =
  process.env.EXPO_PUBLIC_ANDROID_NATIVE_CALL_UI === "true";

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
      // Required on Android 14+ (API 34) for the ONGOING-CALL foreground service
      // (ActiveCallService) declared with foregroundServiceType="microphone|
      // camera". This keeps the process at foreground priority for the call's
      // lifetime so the OS doesn't throttle the app mid-call (which surfaces as
      // video stutter/lag/freeze). Mic is used on every call; camera on video.
      "android.permission.FOREGROUND_SERVICE_MICROPHONE",
      "android.permission.FOREGROUND_SERVICE_CAMERA",
      // Required on Android 14+ (API 34) for a foregroundServiceType="phoneCall"
      // service AND for NotificationCompat.CallStyle. Without it the call-ringer
      // foreground service throws on start (swallowed) so the ring/notification
      // never surfaces in the background/locked state.
      "android.permission.MANAGE_OWN_CALLS",
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
    // Re-applies the Gradle JVM heap/metaspace settings during `expo prebuild`.
    // CI regenerates the gitignored android/ project on every run, which
    // overwrites android/gradle.properties with Expo's 2 GiB default and OOMs
    // the release build (:app:mergeReleaseJavaResource → "Java heap space").
    // This plugin makes the higher limits survive prebuild.
    "./scripts/withAndroidGradleMemory",
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
    // Enables Android Picture-in-Picture (PiP) for the call screen: declares
    // android:supportsPictureInPicture + the screen/orientation configChanges on
    // MainActivity, and injects onUserLeaveHint/onPictureInPictureModeChanged
    // overrides that drive the local modules/pip native module. This makes a
    // live call shrink into a floating window when the user leaves the app
    // mid-call (Signal-Android parity) instead of the "Ongoing call — Return"
    // banner. No-op on iOS (the banner remains the fallback there).
    "./scripts/withAndroidPip",
    // Copies the bundled call ringtone WAV files (assets/sounds/*.wav, generated
    // by scripts/generate-call-sounds.cjs) into android res/raw so the Notifee
    // calls channel can ring with the WorkPulse tone instead of the system
    // default in the killed/background status-bar state.
    "./scripts/withAndroidRingtoneAssets",
    // Copies the monochrome notification small icon (assets/notification/
    // notification_icon.xml) into android res/drawable so Notifee can resolve
    // `smallIcon: "notification_icon"`. Without a resolvable small drawable,
    // Android DROPS the message notification silently (sound plays, but no
    // status-bar entry) — the root cause of "messages: only sound, no banner".
    "./scripts/withAndroidNotificationIcon",
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
    [
      // Face ID / Touch ID (iOS) + BiometricPrompt (Android) for "log in with
      // your face / fingerprint". The OS performs the biometric match locally
      // and unlocks a device secret stored in expo-secure-store — no biometric
      // data ever leaves the device.
      "expo-local-authentication",
      {
        faceIDPermission:
          "Allow WorkPulse to use Face ID to sign you in securely.",
      },
    ],
    "expo-sharing",
  ],
  extra: {
    API_BASE_URL,
    WS_BASE_URL,
    APP_VERSION,
    // P3.15 — surfaced to src/config.ts so nativeCallService can gate the
    // Android react-native-callkeep branch behind this feature flag.
    ANDROID_NATIVE_CALL_UI,
  },
});
