import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";

/**
 * JS bridge for the local `CallRinger` native module (Phase 3 — Signal/Teams
 * parity ringing).
 *
 * The native module starts/stops a foreground service (CallRingService) that
 * plays the user's SELECTED ringtone via a looping MediaPlayer and buzzes via a
 * repeating Vibrator, fully app-controlled in EVERY app state (foreground,
 * background, locked, killed). This is the robust ring path: unlike the
 * notification-channel sound (immutable, user-overridable) it gives a consistent
 * selected ringtone AND a deterministic, instant stop on answer/decline.
 *
 * `requireOptionalNativeModule` returns null when the native module isn't
 * present (iOS, Expo Go, or a JS-only build not prebuilt with the module), so
 * every export below is a safe no-op there.
 */
const CallRinger = requireOptionalNativeModule<{
  startRinging(options: Record<string, string>): void;
  stopRinging(): void;
}>("CallRinger");

export type StartRingingOptions = {
  /** Bundled res/raw resource name, e.g. "ringtone_classic". */
  ringtoneRes?: string;
  /** Notification title (caller name / "Incoming call"). */
  title?: string;
  /** Notification body. */
  body?: string;
  /** Pass false to disable vibration. */
  vibrate?: boolean;
  /** Pass true to suppress sound + vibration (muteAll / "none" ringtone). */
  silent?: boolean;
};

/**
 * Start the incoming-call ring (looping selected ringtone + vibration) via the
 * foreground service. No-op on iOS / Expo Go / non-prebuilt builds.
 */
export function startRinging(options: StartRingingOptions = {}): void {
  if (Platform.OS !== "android") return;
  try {
    CallRinger?.startRinging({
      ringtoneRes: options.ringtoneRes ?? "",
      title: options.title ?? "Incoming call",
      body: options.body ?? "",
      vibrate: options.vibrate === false ? "0" : "1",
      silent: options.silent ? "1" : "0",
    });
  } catch {
    // Best-effort; never let a native bridge error break the call flow.
  }
}

/** Stop the incoming-call ring immediately. No-op when unavailable. */
export function stopRinging(): void {
  if (Platform.OS !== "android") return;
  try {
    CallRinger?.stopRinging();
  } catch {
    // Best-effort.
  }
}

/** True when the native CallRinger module is available (custom dev/EAS build). */
export const isCallRingerAvailable = CallRinger != null;