import type { ExpoConfig, ConfigContext } from "expo/config";
// Single source of truth for the app version. The mobile release workflow
// validates that the `mobile-vX.Y.Z` tag matches this value, and the R2 updater
// surfaces it on the Profile screen — so it MUST reflect the real shipped version
// (previously this was hardcoded to "1.0.0" which broke update comparisons).
import { version as APP_VERSION } from "./package.json";

// Default backend targets. Override per-build via environment variables
// (CI secrets / .env) without touching source.
// Must be the `www.` host: the apex `aino.org.in` is a registrar redirect and
// is NOT served by Railway (it 404s on /api). The legacy Railway origin still
// resolves to the same server and must stay alive for already-installed builds
// that baked it in.
const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_BASE_URL || "https://www.aino.org.in/api";
const WS_BASE_URL =
  process.env.EXPO_PUBLIC_WS_BASE_URL || "wss://www.aino.org.in";
const TENOR_API_KEY = process.env.EXPO_PUBLIC_TENOR_API_KEY || "";
const TENOR_CLIENT_KEY =
  process.env.EXPO_PUBLIC_TENOR_CLIENT_KEY || "aino-chat";
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

const versionParts = APP_VERSION.split(".").map(Number);
if (
  versionParts.length !== 3 ||
  versionParts.some((part) => !Number.isInteger(part) || part < 0 || part > 999)
) {
  throw new Error(`mobile/package.json version must be numeric X.Y.Z: ${APP_VERSION}`);
}
// Android compares this integer, not versionName, when replacing an installed APK.
const ANDROID_VERSION_CODE =
  versionParts[0] * 1_000_000 + versionParts[1] * 1_000 + versionParts[2];

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "AINO",
  // Expo project identity retained for config/plugin compatibility.
  slug: "aino",
  owner: "aino",
  version: APP_VERSION,
  // "default" lets the OS/device sensor control rotation so tablets (and phones
  // with auto-rotate enabled) can switch between portrait and landscape and the
  // UI re-aligns. Previously "portrait" injected android:screenOrientation="portrait"
  // into the manifest, hard-locking every Android screen (incl. tablets) to portrait.
  orientation: "default",
  icon: "./assets/icon.png",
  // Deep-link scheme. The Android native modules (CallRingService,
  // CallActionActivity, ActiveCallService) receive this value as an intent
  // extra and only fall back to a literal, so JS and native were flipped
  // together to "aino" as one change; ConversationNotificationsModule builds
  // `aino://chat/...` directly. Renaming here alone would make call
  // answer/decline and notification taps dead links.
  scheme: "aino",
  userInterfaceStyle: "automatic",
  ios: {
    supportsTablet: true,
    bundleIdentifier: "app.aino.mobile",
  },
  android: {
    versionCode: ANDROID_VERSION_CODE,
    // FROZEN FROM THE FIRST `eas submit` ONWARDS. A Play Store package name is
    // permanent once published; this was renamed from `app.workpulse.mobile`
    // while the app had NEVER been published (distribution was sideloaded,
    // debug-signed APKs only), which was the last possible window. Treat it as
    // immutable now — see docs/AINO_EAS_MIGRATION_PLAN.md §0. The store LISTING
    // name is independent, so rebrand that (and `name` above) instead.
    // Matches the `aino-86bb6` Firebase client in google-services.json; the two
    // must stay in lockstep or FCM sends fail with `mismatched-credential`.
    package: "app.aino.mobile",
    googleServicesFile: ANDROID_GOOGLE_SERVICES_FILE,
    adaptiveIcon: {
      backgroundColor: "#131314",
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
      // Direct-distribution builds download the signed APK from R2 and hand it
      // to Android's package installer. Remove before Play-managed distribution.
      "android.permission.REQUEST_INSTALL_PACKAGES",
    ],
  },
  web: {
    favicon: "./assets/favicon.png",
  },
  // RENDER PERF: enable the React Compiler (stable, babel-plugin-react-compiler
  // ships with babel-preset-expo). It automatically memoizes components, hooks
  // and derived values at build time, so the whole app avoids re-rendering
  // subtrees whose inputs did not change — without hand-written useMemo/
  // useCallback/React.memo. This complements (does not replace) the manual
  // memoization already in place (e.g. MessageBubble) and is the app-wide
  // counterpart to the list/worklet optimizations. React 19 has the compiler
  // runtime built in, so no extra `react-compiler-runtime` dep is needed.
  experiments: {
    reactCompiler: true,
  },
  plugins: [
    "expo-router",
    // expo-image powers the chat media bubbles (see src/components/AuthedImage).
    // Its native decoder DOWNSAMPLES large photos to the display size instead of
    // decoding them at full resolution the way the stock RN <Image> did — this
    // is the fix for the chat-scroll jank/freeze and the out-of-memory crashes
    // when scrolling back through media-heavy history.
    "expo-image",

    // Signal-style launch splash: the brand mark centered (small) on a solid
    // brand-navy background, matching Signal-Android's Android-12 SplashScreen
    // (windowSplashScreenBackground = brand color, windowSplashScreenAnimatedIcon
    // = centered logo). The splash keeps the brand-navy #0a0e1c; the adaptive
    // launcher-icon background is a separate colour (ADAPTIVE_BG in
    // scripts/generate-icons.cjs).
    [
      "expo-splash-screen",
      {
        image: "./assets/splash-icon.png",
        // splash-icon.png carries ~19% transparent safe-zone padding (the logo
        // occupies the inner ~62%) so the Android 12+ circular splash mask
        // doesn't clip its edges. imageWidth is sized against the full padded
        // canvas, so the visible mark lands at ~178dp — keep these two in sync.
        imageWidth: 288,
        resizeMode: "contain",
        backgroundColor: "#0a0e1c",
        dark: {
          image: "./assets/splash-icon.png",
          backgroundColor: "#0a0e1c",
        },
      },
    ],
    "expo-secure-store",
    // COLD-START PERF: statically embed the Inter/Pacifico TTFs into the
    // native Android build so every fontFamily is resolvable at t=0 and the
    // first render never has to wait for expo-font's async runtime load.
    // (Android resolves an embedded font by its FILENAME, which matches the
    // family names in src/fonts.ts exactly — e.g. Inter_400Regular.ttf →
    // "Inter_400Regular".) app/_layout.tsx keeps useFonts() as a fallback for
    // iOS/Expo Go, but no longer BLOCKS the first render on it.
    [
      "expo-font",
      {
        android: {
          fonts: [
            "node_modules/@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf",
            "node_modules/@expo-google-fonts/inter/500Medium/Inter_500Medium.ttf",
            "node_modules/@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf",
            "node_modules/@expo-google-fonts/inter/700Bold/Inter_700Bold.ttf",
            "node_modules/@expo-google-fonts/pacifico/400Regular/Pacifico_400Regular.ttf",
          ],
        },
      },
    ],
    // COLD-START PERF (release builds): enable R8 code minification + resource
    // shrinking. A smaller, optimized DEX loads faster at process start
    // (Signal-Android ships heavily R8-optimized). Hermes (RN default) already
    // precompiles the JS bundle; this covers the NATIVE side.
    [
      "expo-build-properties",
      {
        android: {
          enableProguardInReleaseBuilds: true,
          enableShrinkResourcesInReleaseBuilds: true,
        },
      },
    ],
    // Re-applies the Gradle JVM heap/metaspace settings during `expo prebuild`.
    // CI regenerates the gitignored android/ project on every run, which
    // overwrites android/gradle.properties with Expo's 2 GiB default and OOMs
    // the release build (:app:mergeReleaseJavaResource → "Java heap space").
    // This plugin makes the higher limits survive prebuild.
    "./scripts/withAndroidGradleMemory",
    // Injects the RELEASE signing config (keystore from ANDROID_KEYSTORE_*
    // env vars) into the generated build.gradle. Same "prebuild clobbers it"
    // reason as withAndroidGradleMemory above: Expo's template signs `release`
    // with `signingConfigs.debug`, which the Play Store rejects. No-ops (keeps
    // debug signing) when the env vars are unset, so local dev is unaffected.
    "./scripts/withAndroidSigning",
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
    // Forward notification-tap intents to Notifee when the app is ALREADY
    // running. MainActivity is singleTask, so tapping a Notifee notification on
    // a cached/backgrounded process is delivered via onNewIntent (NOT onCreate);
    // without setIntent() the tap never reaches Notifee/getInitialNotification
    // and the app just resumes to the dashboard instead of opening the chat.
    "./scripts/withAndroidNewIntent",
    // Copies the bundled call ringtone WAV files (assets/sounds/*.wav, generated
    // by scripts/generate-call-sounds.cjs) into android res/raw so the Notifee
    // calls channel can ring with the AINO tone instead of the system
    // default in the killed/background status-bar state.
    "./scripts/withAndroidRingtoneAssets",
    // Copies the white-silhouette notification small icon (assets/notification/
    // notification_icon.png) into android res/drawable so Notifee can resolve
    // `smallIcon: "notification_icon"`. Without a resolvable small drawable,
    // Android DROPS the message notification silently (sound plays, but no
    // status-bar entry) — the root cause of "messages: only sound, no banner".
    "./scripts/withAndroidNotificationIcon",
    [
      "expo-audio",
      {
        microphonePermission:
          "Allow AINO to access your microphone to record voice messages and make calls.",
      },
    ],
    [
      "@config-plugins/react-native-webrtc",
      {
        cameraPermission:
          "Allow AINO to access your camera for video calls.",
        microphonePermission:
          "Allow AINO to access your microphone for calls.",
      },
    ],
    [
      "expo-camera",
      {
        cameraPermission:
          "Allow AINO to access your camera to take photos and record videos for chat, face enrollment and attendance verification.",
        // Required so the in-chat camera can RECORD VIDEO (audio track) on a
        // long-press of the shutter, matching Signal's camera.
        microphonePermission:
          "Allow AINO to access your microphone to record videos in chat.",
        recordAudioAndroid: true,
      },
    ],
    [
      // Recent-gallery strips (the in-camera roll + the "+" attach sheet) read
      // the device's recent photos/videos via expo-media-library, mirroring
      // Signal's AttachmentKeyboard recent-media row + in-camera gallery shortcut.
      "expo-media-library",
      {
        photosPermission:
          "Allow AINO to access your photos so you can share them in chat.",
        savePhotosPermission:
          "Allow AINO to save photos and videos you capture in chat.",
        isAccessMediaLocationEnabled: true,
      },
    ],
    [
      "expo-location",
      {
        locationAlwaysAndWhenInUsePermission:
          "Allow AINO to use your location to verify office attendance at clock-in.",
        locationWhenInUsePermission:
          "Allow AINO to use your location to verify office attendance at clock-in.",
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
          "Allow AINO to use Face ID to sign you in securely.",
      },
    ],
    "expo-sharing",
    [
      // Inline chat video player (Signal-style). Enables background playback +
      // PiP so a video can keep playing when the user expands/leaves it, and
      // declares the iOS audio-session usage for video with sound.
      "expo-video",
      {
        supportsBackgroundPlayback: false,
        supportsPictureInPicture: true,
      },
    ],
  ],
  extra: {
    API_BASE_URL,
    WS_BASE_URL,
    TENOR_API_KEY,
    TENOR_CLIENT_KEY,
    APP_VERSION,
    // P3.15 — surfaced to src/config.ts so nativeCallService can gate the
    // Android react-native-callkeep branch behind this feature flag.
    ANDROID_NATIVE_CALL_UI,
  },
});
