import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { usePathname } from "expo-router";
import { setAudioModeAsync, useAudioPlayer } from "expo-audio";

import { useAuth } from "../auth/AuthContext";
import { getNotificationPrefs, type NotificationPrefs } from "../features";
import {
  getNotificationPreviewDataUri,
  type NotificationSoundCategory,
} from "../utils/notificationSoundPreview";
import {
  DEFAULT_NOTIFICATION_PREFS,
  mergeNotificationPrefs,
} from "../utils/notificationPrefs";
import { socket } from "./socket";

const SOUND_COOLDOWN_MS = 450;

function isMention(content: unknown, username?: string, fullName?: string) {
  const text = typeof content === "string" ? content.toLowerCase() : "";
  if (!text) return false;
  if (username && text.includes(`@${String(username).toLowerCase()}`)) return true;
  if (fullName && text.includes(`@${String(fullName).toLowerCase()}`)) return true;
  return false;
}

function toneIdForCategory(
  prefs: NotificationPrefs,
  category: NotificationSoundCategory,
) {
  if (category === "ringtone") return prefs.ringtone || "classic";
  if (category === "outgoing") return prefs.outgoingTone || "ringback";
  if (category === "mention") return prefs.mentionTone || "mention";
  if (category === "reaction") return prefs.reactionTone || "subtle";
  return prefs.messageTone || "ding";
}

export default function RealtimeSoundListener() {
  const { user } = useAuth();
  const pathname = usePathname();
  const player = useAudioPlayer();
  const prefsRef = useRef<NotificationPrefs>(DEFAULT_NOTIFICATION_PREFS);
  const appActiveRef = useRef(AppState.currentState === "active");
  const lastPlayedRef = useRef<Record<string, number>>({});
  const [, setPrefs] = useState<NotificationPrefs>(DEFAULT_NOTIFICATION_PREFS);

  const reloadPrefs = useCallback(async () => {
    if (!user) return;
    try {
      const { data } = await getNotificationPrefs();
      const merged = mergeNotificationPrefs(data || {});
      prefsRef.current = merged;
      setPrefs(merged);
    } catch {
      const merged = mergeNotificationPrefs();
      prefsRef.current = merged;
      setPrefs(merged);
    }
  }, [user]);

  const playTone = useCallback(
    async (category: NotificationSoundCategory) => {
      const prefs = prefsRef.current;
      if (prefs.muteAll) return;
      if (appActiveRef.current && prefs.playWhenFocused === false) return;
      if (pathname?.startsWith("/call/")) return;
      const toneId = toneIdForCategory(prefs, category);
      if (!toneId || toneId === "none") return;
      const now = Date.now();
      const key = `${category}:${toneId}`;
      const lastAt = lastPlayedRef.current[key] || 0;
      if (now - lastAt < SOUND_COOLDOWN_MS) return;
      lastPlayedRef.current[key] = now;
      const uri = getNotificationPreviewDataUri(category, toneId);
      if (!uri) return;
      try {
        await setAudioModeAsync({
          allowsRecording: false,
          playsInSilentMode: true,
          shouldPlayInBackground: false,
          interruptionMode: "doNotMix",
          shouldRouteThroughEarpiece: false,
        });
        player.replace({ uri });
        player.play();
      } catch {
        /* no-op */
      }
    },
    [pathname, player],
  );

  useEffect(() => {
    if (!user) return;
    reloadPrefs();
    const sub = AppState.addEventListener("change", (next) => {
      appActiveRef.current = next === "active";
      if (next === "active") reloadPrefs();
    });
    return () => sub.remove();
  }, [reloadPrefs, user]);

  useEffect(() => {
    if (!user) return;
    const off = socket.subscribe((msg) => {
      const d = msg.data || {};
      if (msg.type === "chat_message") {
        if (Number(d.senderId) === Number(user.id)) return;
        const category = isMention(d.content, user.username, user.full_name)
          ? "mention"
          : "message";
        void playTone(category);
        return;
      }
      if (msg.type === "chat_reaction") {
        if (Number(d.userId) === Number(user.id)) return;
        void playTone("reaction");
        return;
      }
      if (msg.type === "meeting_started" || msg.type === "meeting_restarted") {
        // A huddle is a group CALL, not a meeting — its (legacy) start event
        // must not play the meeting alert tone. Defensive guard; the server no
        // longer emits meeting_started for huddles.
        if ((d as any).isHuddle) return;
        if (Number(d.startedBy) === Number(user.id)) return;
        void playTone("mention");
        return;
      }
      if (msg.type === "notification") {
        const category = isMention(d.body || d.title, user.username, user.full_name)
          ? "mention"
          : "message";
        void playTone(category);
      }
    });
    return off;
  }, [playTone, user]);

  return null;
}

