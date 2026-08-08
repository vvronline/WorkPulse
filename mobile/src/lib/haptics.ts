/**
 * Centralised haptic feedback.
 *
 * Every call is fire-and-forget and failure-tolerant: haptics are a polish
 * layer, never a correctness dependency. On devices/emulators without a
 * vibrator (or on web) the underlying native call rejects — we swallow it so a
 * missing motor can never surface as an unhandled rejection.
 *
 * Android note: iOS has a dedicated Taptic Engine with distinct impact styles;
 * Android maps these onto its (coarser) `VibrationEffect` predefined constants.
 * Keeping every call site behind these named intents (rather than raw
 * `impactAsync(Heavy)` sprinkled everywhere) means the mapping can be tuned in
 * one place if a style feels wrong on one platform.
 */

import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

// `expo-haptics` is a no-op-with-rejection on web; skip the bridge hop entirely.
const ENABLED = Platform.OS === "ios" || Platform.OS === "android";

function run(fn: () => Promise<void>): void {
  if (!ENABLED) return;
  fn().catch(() => {});
}

export const haptics = {
  /**
   * Light tick. Use for high-frequency, low-consequence interactions:
   * tab switches, chip/segment toggles, list-row selection, pagination dots.
   */
  selection(): void {
    run(() => Haptics.selectionAsync());
  },

  /**
   * Standard button press. Use for primary actions that commit something small
   * (send message, add item, apply filter).
   */
  light(): void {
    run(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
  },

  /**
   * Weightier press. Use for state changes the user should *feel*:
   * clock in / clock out, starting or stopping a timer, opening a sheet via
   * long-press.
   */
  medium(): void {
    run(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium));
  },

  /**
   * Long-press / drag pickup. Reserved for gesture affordances (message
   * long-press, kanban card lift) so the pickup moment is unmistakable.
   */
  heavy(): void {
    run(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy));
  },

  /** Operation completed successfully (leave approved, task created). */
  success(): void {
    run(() =>
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
    );
  },

  /** Operation needs attention but did not fail outright (validation). */
  warning(): void {
    run(() =>
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
    );
  },

  /** Operation failed (request rejected, send failed). */
  error(): void {
    run(() =>
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
    );
  },
};

export default haptics;