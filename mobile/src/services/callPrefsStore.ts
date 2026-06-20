/**
 * Durable cache of the call-relevant notification preferences.
 *
 * WHY THIS EXISTS:
 * The incoming-call Notifee notification is posted from a HEADLESS FCM task
 * (app killed) where there is no React state and an authenticated API call is
 * slow/unreliable. To honour the user's `muteAll` preference in that state
 * (post a SILENT call notification instead of one that rings), we persist the
 * relevant prefs to SecureStore whenever the app fetches them while alive, and
 * read them back from the headless task.
 *
 * Only `muteAll` is cached here: the SELECTED ringtone is a JS data-URI sound
 * played by the call screen once it mounts (Notifee can only ring with a bundled
 * Android raw resource, so it falls back to the system default / silent). The
 * call screen — which always surfaces for an incoming call — owns the selected
 * ringtone. This cache only governs the brief pre-mount Notifee ring window.
 *
 * Every function is best-effort and never throws so it is safe to call from the
 * headless background task.
 */

import * as SecureStore from "expo-secure-store";

const CALL_PREFS_KEY = "wp_call_notification_prefs";

export type CachedCallPrefs = {
  /** When true, the incoming-call notification must be posted silently. */
  muteAll: boolean;
  /**
   * The user's SELECTED incoming-call ringtone id (e.g. "classic", "calm",
   * "urgent", … or "none"). Cached so the headless/killed Notifee path can post
   * the incoming-call notification on the matching per-tone channel (whose sound
   * is the bundled res/raw/ringtone_<id> resource) — making the status-bar ring
   * use the user's CHOICE instead of a single fixed tone. Falls back to
   * "classic" when absent.
   */
  ringtone: string;
};

const DEFAULT_CALL_PREFS: CachedCallPrefs = {
  muteAll: false,
  ringtone: "classic",
};

/** Persist the call-relevant prefs. Safe from any context; never throws. */
export async function persistCallPrefs(prefs: CachedCallPrefs): Promise<void> {
  try {
    await SecureStore.setItemAsync(
      CALL_PREFS_KEY,
      JSON.stringify({
        muteAll: !!prefs.muteAll,
        ringtone: prefs.ringtone || "classic",
      }),
    );
  } catch {
    // Best-effort only — the live call screen still respects prefs directly.
  }
}

/**
 * Load the cached call prefs. Returns the safe default (not muted, classic
 * ringtone) when absent, malformed, or on any error so an incoming call is never
 * silently dropped.
 */
export async function loadCallPrefs(): Promise<CachedCallPrefs> {
  try {
    const raw = await SecureStore.getItemAsync(CALL_PREFS_KEY);
    if (!raw) return DEFAULT_CALL_PREFS;
    const parsed = JSON.parse(raw) as Partial<CachedCallPrefs>;
    return {
      muteAll: Boolean(parsed?.muteAll),
      ringtone:
        typeof parsed?.ringtone === "string" && parsed.ringtone
          ? parsed.ringtone
          : "classic",
    };
  } catch {
    return DEFAULT_CALL_PREFS;
  }
}
