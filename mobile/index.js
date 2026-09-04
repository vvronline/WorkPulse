/**
 * Custom JS entry point.
 *
 * The FCM background/terminated-state message handler MUST be registered here,
 * at the top level of the JS bundle, BEFORE the React app initializes. When the
 * app is killed, React Native Firebase spawns a headless JS task that runs this
 * module but never mounts the React tree — so registering the handler inside a
 * component `useEffect` (as was previously done in `app/_layout.tsx`) means it
 * never runs in the terminated state, and incoming-call / message pushes are
 * silently dropped.
 *
 * SAME FOR FOREGROUND HANDLER: The FCM foreground handler (`onMessage`) MUST
 * also register here, at the JS entry top-level, to guarantee it is ready when
 * the app is launched in the foreground and receives data-only payloads. If
 * registration is deferred to a React useEffect, messages can arrive BEFORE
 * the handler is registered, causing them to be silently dropped.
 *
 * After handler registration starts, notificationDispatcher begins the
 * ONE-SHOT Notifee initial-notification read. The root route waits briefly for
 * the dispatcher result instead of reading getInitialNotification() itself.
 */
import { markJsStart } from "./src/utils/appReady";
import { backgroundPushService } from "./src/services/backgroundPushService";
import { notificationDispatcher } from "./src/services/notificationDispatcher";

// LiveKit's WebRTC/URL/stream globals must exist before expo-router imports the
// call route. Native LiveKit code requires a development build (not Expo Go).
const { registerGlobals } = require("@livekit/react-native");
registerGlobals({ autoConfigureAudioSession: false });

// COLD-START TIMING: stamp the JS-eval start time as early as possible so
// markAppReady() can log the full "JS eval → first frame" duration. This is the
// FIRST executable statement so it captures the earliest JS timestamp available.
markJsStart();

// Step 1: Register the FCM background handler at import time (top-level).
// Safe to call here: it is idempotent and no-ops if the native
// @react-native-firebase/messaging module is unavailable (e.g. Expo Go).
backgroundPushService.initialize();

// Step 2: Register the FCM foreground handler (onMessage) at the JS entry top-level.
// This starts before React boots so the handler is wired as early as possible.
// Do NOT delay expo-router''s entry behind this async work: React Native expects
// the root component to be registered during initial JS evaluation.
backgroundPushService.registerForegroundHandler().catch((error) => {
  console.error("Foreground handler registration failed:", error);
  // Continue anyway — background handler still works
});

// Step 3: Start the single-reader cold-start dispatcher before React mounts.
// Do not await it here: React Native expects the root component registration to
// happen during initial JS evaluation. app/index.tsx waits up to 600ms for this.
notificationDispatcher.initialize("cold_start").catch((error) => {
  console.error("Notification dispatcher initialization failed:", error);
});

// Step 4: Hand off to expo-router''s standard entry synchronously.
// NOTE: use require (not a static import) so this runs AFTER the top-level
// handler registration calls above — static imports are hoisted.
require("expo-router/entry");