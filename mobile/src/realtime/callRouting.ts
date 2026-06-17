/**
 * Single-source guard for navigating to the incoming/active call screen.
 *
 * WHY THIS EXISTS:
 * A call can be surfaced from multiple places simultaneously while the app is
 * alive or backgrounded-but-alive:
 *   1. `IncomingCallListener` (websocket `call_incoming`) → router.push("/call/...")
 *   2. `PushNotificationListener` (FCM/expo-notifications) → router.push("/call/...")
 *   3. The Notifee full-screen call notification's Answer/body tap →
 *      Linking.openURL(createURL("/call/...")) which expo-router turns into a push.
 *
 * If two of these fire for the SAME call, expo-router mounts the
 * `/call/[conversationId]` `fullScreenModal` screen TWICE. Under the React
 * Native New Architecture (Fabric) that throws a fatal native crash:
 *
 *   java.lang.IllegalStateException: addViewAt: failed to insert view ...
 *   Caused by: The specified child already has a parent.
 *
 * The crash kills the JS thread, so (a) no incoming-call UI is shown and
 * (b) the expo-audio ringtone MediaSession is never stopped → it rings forever.
 *
 * This module tracks the currently-active call so every navigation path can ask
 * `beginCallNavigation()` first and skip if the call screen is already up.
 */

let activeKey: string | null = null;

function keyFor(callId: number | string, conversationId: number | string): string {
  return `${conversationId}:${callId}`;
}

/**
 * Attempt to claim navigation for a given call. Returns true if the caller
 * should proceed to navigate, or false if the call screen is already
 * showing/being shown for this call (caller must NOT navigate again).
 */
export function beginCallNavigation(
  callId: number | string | undefined | null,
  conversationId: number | string | undefined | null,
): boolean {
  if (callId == null || conversationId == null) return false;
  const key = keyFor(callId, conversationId);
  if (activeKey === key) return false; // already navigating/active for this call
  activeKey = key;
  return true;
}

/** True if a call screen is currently active for the given call (or any call). */
export function isCallActive(
  callId?: number | string,
  conversationId?: number | string,
): boolean {
  if (activeKey == null) return false;
  if (callId == null || conversationId == null) return true;
  return activeKey === keyFor(callId, conversationId);
}

/** Clear the active-call guard (call screen unmounted / call ended). */
export function endCallNavigation(): void {
  activeKey = null;
}