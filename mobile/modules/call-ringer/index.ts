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
  startActiveCall?(options: Record<string, string>): void;
  stopActiveCall?(): void;
  getPendingCallAction?(): PendingCallAction | null;
  clearPendingCallAction?(): void;
}>("CallRinger");

/**
 * The Answer/Decline choice the user made on the native CallStyle status-bar
 * notification, recorded natively (PendingCallActionStore) so the JS layer can
 * apply it after a COLD start. See getPendingCallAction below.
 */
export type PendingCallAction = {
  /** "answer" | "decline". */
  action: string;
  callId: string;
  conversationId: string;
};

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
  /** Call identity — used to build the CallStyle UI + Answer/Decline deep links. */
  callId?: string;
  conversationId?: string;
  callerId?: string;
  callerName?: string;
  callerAvatar?: string;
  /** "voice" | "video". */
  callType?: string;
  /** App deep-link scheme (e.g. "workpulse") so action taps open the call screen. */
  scheme?: string;
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
      callId: options.callId ?? "",
      conversationId: options.conversationId ?? "",
      callerId: options.callerId ?? "",
      callerName: options.callerName ?? "",
      callerAvatar: options.callerAvatar ?? "",
      callType: options.callType ?? "voice",
      scheme: options.scheme ?? "workpulse",
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

export type StartActiveCallOptions = {
  /** "voice" | "video" — drives the foregroundServiceType (mic vs mic+camera). */
  callType?: string;
  /** Ongoing-call notification title (peer name). */
  title?: string;
  /** Ongoing-call notification body. */
  body?: string;
  /** App deep-link scheme so tapping the notification reopens the call screen. */
  scheme?: string;
};

/**
 * Start the ONGOING-CALL foreground service (Signal ActiveCallManager model).
 * Keeps the process at foreground priority for the call's lifetime so the OS
 * does not doze/throttle the app mid-call (a cause of video stutter/lag/freeze).
 * Declared with FOREGROUND_SERVICE_TYPE_MICROPHONE (+ CAMERA for video).
 * No-op on iOS / Expo Go / non-prebuilt builds.
 */
export function startActiveCall(options: StartActiveCallOptions = {}): void {
  if (Platform.OS !== "android") return;
  try {
    CallRinger?.startActiveCall?.({
      callType: options.callType ?? "voice",
      title: options.title ?? "Ongoing call",
      body: options.body ?? "",
      scheme: options.scheme ?? "workpulse",
    });
  } catch {
    // Best-effort; never let a native bridge error break the call flow.
  }
}

/** Stop the ongoing-call foreground service. No-op when unavailable. */
export function stopActiveCall(): void {
  if (Platform.OS !== "android") return;
  try {
    CallRinger?.stopActiveCall?.();
  } catch {
    // Best-effort.
  }
}

/**
 * Read the Answer/Decline choice the user made on the native CallStyle status-
 * bar notification (recorded by CallActionActivity) so it can be MERGED into the
 * cold-start pending-call route. Returns null when absent/stale/invalid or when
 * the native module is unavailable. The caller should clearPendingCallAction()
 * after consuming it so a stale tap can't auto-answer a later unrelated call.
 */
export function getPendingCallAction(): PendingCallAction | null {
  if (Platform.OS !== "android") return null;
  try {
    const result = CallRinger?.getPendingCallAction?.();
    if (
      result &&
      typeof result.action === "string" &&
      typeof result.callId === "string" &&
      typeof result.conversationId === "string" &&
      result.action.length > 0 &&
      result.callId.length > 0 &&
      result.conversationId.length > 0
    ) {
      return {
        action: result.action,
        callId: result.callId,
        conversationId: result.conversationId,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Clear the stored pending call action. No-op when unavailable. */
export function clearPendingCallAction(): void {
  if (Platform.OS !== "android") return;
  try {
    CallRinger?.clearPendingCallAction?.();
  } catch {
    // Best-effort.
  }
}

/** True when the native CallRinger module is available (custom dev/EAS build). */
export const isCallRingerAvailable = CallRinger != null;
