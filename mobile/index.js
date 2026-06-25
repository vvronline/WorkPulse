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
 * After registering the background handler we delegate to expo-router's default
 * entry so the normal app boot proceeds unchanged.
 */
import { backgroundPushService } from "./src/services/backgroundPushService";

// Register the FCM background handler at import time (top-level), not in a
// component lifecycle. Safe to call here: it is idempotent and no-ops if the
// native @react-native-firebase/messaging module is unavailable (e.g. Expo Go).
backgroundPushService.initialize();

// Hand off to expo-router's standard entry to boot the app UI.
// NOTE: use require (not a static import) so this runs AFTER
// backgroundPushService.initialize() above — static imports are hoisted and
// would otherwise boot the app before the background handler is registered.
require("expo-router/entry");
