import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";

/**
 * JS bridge for the local `LockScreen` native module.
 *
 * The native module exposes `setShowWhenLocked(enable: boolean)` which toggles
 * the current Activity's show-over-lock-screen + turn-screen-on flags at
 * RUNTIME (see android/.../LockScreenModule.kt for the rationale).
 *
 * `requireOptionalNativeModule` returns `null` when the native module isn't
 * present (iOS, Expo Go, or a JS-only build that hasn't been prebuilt with the
 * module). Every export below is therefore a safe no-op in those environments.
 */
const LockScreen = requireOptionalNativeModule<{
  setShowWhenLocked(enable: boolean): void;
}>("LockScreen");

/**
 * Enable/disable showing the app over the lock screen (and turning the screen
 * on). Call `setShowWhenLocked(true)` when a call UI mounts and
 * `setShowWhenLocked(false)` when it ends/unmounts. No-op on iOS / Expo Go.
 */
export function setShowWhenLocked(enable: boolean): void {
  if (Platform.OS !== "android") return;
  try {
    LockScreen?.setShowWhenLocked(enable);
  } catch {
    // Best-effort; never let a native bridge error crash the call screen.
  }
}

/** True when the native module is available (Android custom dev/EAS build). */
export const isLockScreenModuleAvailable = LockScreen != null;