import { Platform } from "react-native";
import {
  requireOptionalNativeModule,
  type EventSubscription,
} from "expo-modules-core";

/**
 * JS bridge for the local `Pip` native module (Android Picture-in-Picture).
 *
 * Mirrors the Signal-Android call PiP: when the user leaves the app mid-call the
 * call screen shrinks into a floating window instead of showing the old
 * "Ongoing call — Return" banner. The native module:
 *   • setAutoEnter(true, w, h)  → OS auto-shrinks on Home (API 31+).
 *   • setCallActive(true)       → injected onUserLeaveHint enters PiP (API 26–30).
 *   • enterPip(w, h)            → request PiP now (manual minimize).
 *   • onPipModeChanged          → event so JS collapses/restores the call UI.
 *
 * `requireOptionalNativeModule` returns `null` on iOS / Expo Go / a JS-only
 * build, so every export below is a safe no-op there (iOS keeps the banner).
 */
type PipNativeModule = {
  isPipSupported(): boolean;
  setCallActive(active: boolean): void;
  enterPip(aspectW: number, aspectH: number): boolean;
  setAutoEnter(enabled: boolean, aspectW: number, aspectH: number): void;
  addListener(
    eventName: "onPipModeChanged",
    listener: (event: { isInPip: boolean }) => void,
  ): EventSubscription;
};

const Pip = requireOptionalNativeModule<PipNativeModule>("Pip");

/** True when the native PiP module is available AND the device supports PiP. */
export function isPipSupported(): boolean {
  if (Platform.OS !== "android" || !Pip) return false;
  try {
    return Pip.isPipSupported();
  } catch {
    return false;
  }
}

/** True when the native module is present (Android custom dev/EAS build). */
export const isPipModuleAvailable = Pip != null;

/**
 * Mark a call as active/inactive. While active, leaving the app (Home / app
 * switch) shrinks the call into a PiP window. Always clear (false) on call
 * teardown so leaving the app afterwards behaves normally.
 */
export function setCallActive(active: boolean): void {
  if (Platform.OS !== "android" || !Pip) return;
  try {
    Pip.setCallActive(active);
  } catch {
    /* best-effort */
  }
}

/**
 * Enable seamless auto-enter PiP on Home press (API 31+). On older Android the
 * injected onUserLeaveHint handles the transition, so this is a harmless no-op.
 * Pass the call's aspect ratio (video → 9:16, voice → 1:1).
 */
export function setAutoEnter(
  enabled: boolean,
  aspectW = 9,
  aspectH = 16,
): void {
  if (Platform.OS !== "android" || !Pip) return;
  try {
    Pip.setAutoEnter(enabled, aspectW, aspectH);
  } catch {
    /* best-effort */
  }
}

/**
 * Explicitly request PiP now (e.g. a manual "minimize" button). Returns false
 * when PiP isn't available. Pass the call's aspect ratio.
 */
export function enterPip(aspectW = 9, aspectH = 16): boolean {
  if (Platform.OS !== "android" || !Pip) return false;
  try {
    return Pip.enterPip(aspectW, aspectH);
  } catch {
    return false;
  }
}

/**
 * Subscribe to PiP mode changes. The listener receives `true` when the call
 * window enters PiP and `false` when it expands back to full screen. Returns an
 * unsubscribe function (safe no-op when the module is unavailable).
 */
export function addPipModeListener(
  listener: (isInPip: boolean) => void,
): () => void {
  if (Platform.OS !== "android" || !Pip) return () => {};
  try {
    const sub = Pip.addListener("onPipModeChanged", (e) =>
      listener(!!e?.isInPip),
    );
    return () => {
      try {
        sub.remove();
      } catch {
        /* ignore */
      }
    };
  } catch {
    return () => {};
  }
}