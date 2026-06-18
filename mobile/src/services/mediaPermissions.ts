/**
 * Proactive camera/microphone permission acquisition.
 *
 * WHY THIS EXISTS:
 * The call screen requests CAMERA/RECORD_AUDIO lazily, inside getUserMedia /
 * ensurePermissions(). When a call is ANSWERED while the app is backgrounded or
 * over the lock screen, Android cannot show the runtime permission dialog, so
 * the request fails and the call connects with NO camera/mic (black self-view,
 * peer sees nothing). Requesting these permissions up front — right after the
 * user is authenticated and the app is in the foreground — means they are
 * already granted by the time a background/lock-screen answer needs the camera.
 *
 * Defensive: no-ops on web and if the native module is unavailable.
 */

import { Platform, PermissionsAndroid } from "react-native";

let requested = false;

/**
 * Request CAMERA + RECORD_AUDIO once per process (Android). Safe to call
 * repeatedly; only prompts on the first call. Does not throw — a denied
 * permission simply means the call screen will prompt again at call time.
 */
export async function ensureCallMediaPermissions(): Promise<void> {
  if (requested) return;
  requested = true;
  if (Platform.OS !== "android") return;
  try {
    await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      PermissionsAndroid.PERMISSIONS.CAMERA,
    ]);
  } catch (err) {
    console.warn("[mediaPermissions] Failed to request call media permissions:", err);
  }
}