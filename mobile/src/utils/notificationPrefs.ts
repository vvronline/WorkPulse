import type { NotificationPrefs } from "../features";

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  muteAll: false,
  ringtone: "classic",
  outgoingTone: "ringback",
  messageTone: "ding",
  mentionTone: "mention",
  reactionTone: "subtle",
  // Mobile currently relies on foreground realtime events for sound.
  playWhenFocused: true,
  playOnSend: false,
};

export function mergeNotificationPrefs(
  prefs?: NotificationPrefs | null,
): NotificationPrefs {
  return { ...DEFAULT_NOTIFICATION_PREFS, ...(prefs || {}) };
}

