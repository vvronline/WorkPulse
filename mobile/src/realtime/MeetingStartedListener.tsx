import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, usePathname } from "expo-router";
import { Video as VideoIcon, X } from "../icons";
import { socket } from "./socket";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../theme/ThemeProvider";
import type { Theme } from "../theme";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface MeetingStartedData {
  meetingId?: number | string;
  meetingCode?: string;
  title?: string;
  organizerName?: string;
  restarted?: boolean;
}

/**
 * App-wide "Meeting started" card. Mirrors the web client's
 * GlobalMeetingNotification: when the server broadcasts a `meeting_started`
 * (or `meeting_restarted`) WS event to an invitee, a floating Teams-style card
 * slides in with the meeting title + organizer and a "Join now" / "Dismiss"
 * pair. "Join" deep-links into the in-app meeting room (`/meeting/[code]`).
 *
 * Behaviour parity with web:
 *   • Suppressed when the user is already inside that meeting (so it doesn't
 *     pop over the in-call UI).
 *   • De-duped per meetingId (a restart re-shows it).
 *   • Auto-dismisses after 60s.
 */
export default function MeetingStartedListener() {
  const router = useRouter();
  const pathname = usePathname();
  const { user } = useAuth();
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const [notification, setNotification] = useState<MeetingStartedData | null>(
    null,
  );
  const shownMeetingRef = useRef<number | string | null>(null);
  const autoDismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = useCallback(() => {
    shownMeetingRef.current = null;
    setNotification(null);
  }, []);

  const showNotification = useCallback(
    (data: MeetingStartedData) => {
      if (!data || !data.meetingId || !data.meetingCode) return;
      // Suppress when we're already in this meeting room.
      if (pathname?.startsWith(`/meeting/${data.meetingCode}`)) return;
      // De-dup: skip if already showing this meeting (unless it's a restart).
      if (shownMeetingRef.current === data.meetingId && !data.restarted) return;
      shownMeetingRef.current = data.meetingId;
      setNotification(data);
    },
    [pathname],
  );

  useEffect(() => {
    if (!user) return;
    const off = socket.subscribe((msg) => {
      if (
        (msg.type === "meeting_started" || msg.type === "meeting_restarted") &&
        msg.data
      ) {
        const d = msg.data as any;
        // Defensive: a huddle is a group CALL, not a meeting — it must never
        // surface a "Meeting started" card. The server no longer emits
        // meeting_started for huddles, but guard here too in case an old
        // server build is in play.
        if (d.isHuddle) return;
        // Never show the card to the person who started the meeting.
        if (d.startedBy != null && d.startedBy === user.id) return;
        showNotification({
          meetingId: d.meetingId,
          meetingCode: d.meetingCode,
          title: d.title,
          organizerName: d.organizerName,
          restarted: !!d.restarted || msg.type === "meeting_restarted",
        });
      } else if (msg.type === "meeting_ended" && msg.data) {
        const d = msg.data as any;
        if (shownMeetingRef.current === d.meetingId) dismiss();
      }
    });
    return off;
  }, [user, showNotification, dismiss]);

  // If we navigate into the shown meeting, dismiss the card.
  useEffect(() => {
    if (notification?.meetingCode && pathname?.startsWith(`/meeting/${notification.meetingCode}`)) {
      dismiss();
    }
  }, [pathname, notification?.meetingCode, dismiss]);

  // Auto-dismiss after 60s.
  useEffect(() => {
    if (!notification) return;
    autoDismissRef.current = setTimeout(dismiss, 60000);
    return () => {
      if (autoDismissRef.current) clearTimeout(autoDismissRef.current);
    };
  }, [notification, dismiss]);

  const handleJoin = useCallback(() => {
    const code = notification?.meetingCode;
    dismiss();
    if (code) router.push(`/meeting/${code}` as never);
  }, [notification?.meetingCode, dismiss, router]);

  if (!notification) return null;

  return (
    <SafeAreaView style={styles.wrap} pointerEvents="box-none">
      <View style={styles.card}>
        <View style={styles.topBar}>
          <View style={styles.pulseRing} />
          <Text style={styles.topLabel}>
            {notification.restarted ? "Meeting Restarted" : "Meeting Started"}
          </Text>
          <Pressable style={styles.dismissBtn} onPress={dismiss} hitSlop={8}>
            <X size={16} color={theme.textSecondary} />
          </Pressable>
        </View>

        <View style={styles.body}>
          <View style={styles.iconWrap}>
            <VideoIcon size={20} color={theme.primary} />
          </View>
          <View style={styles.info}>
            <Text style={styles.title} numberOfLines={1}>
              {notification.title || "Meeting"}
            </Text>
            <Text style={styles.host} numberOfLines={1}>
              {notification.organizerName || "Someone"}{" "}
              {notification.restarted ? "restarted" : "started"} this meeting
            </Text>
          </View>
        </View>

        <View style={styles.actions}>
          <Pressable style={styles.joinBtn} onPress={handleJoin}>
            <Text style={styles.joinBtnText}>Join now</Text>
          </Pressable>
          <Pressable style={styles.declineBtn} onPress={dismiss}>
            <Text style={styles.declineBtnText}>Dismiss</Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    wrap: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      alignItems: "center",
      zIndex: 1000,
    },
    card: {
      width: "92%",
      marginTop: 8,
      backgroundColor: theme.bgElevated,
      borderRadius: theme.radiusLg,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      padding: 14,
      gap: 12,
      shadowColor: "#000",
      shadowOpacity: 0.35,
      shadowRadius: 16,
      shadowOffset: { width: 0, height: 8 },
      elevation: 10,
    },
    topBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    pulseRing: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: theme.success,
    },
    topLabel: {
      flex: 1,
      color: theme.textSecondary,
      fontSize: 12,
      fontWeight: "700",
      letterSpacing: 0.4,
      textTransform: "uppercase",
    },
    dismissBtn: {
      padding: 2,
    },
    body: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    iconWrap: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: theme.primaryGlow,
      alignItems: "center",
      justifyContent: "center",
    },
    info: { flex: 1, gap: 2 },
    title: { color: theme.text, fontSize: 16, fontWeight: "800" },
    host: { color: theme.textMuted, fontSize: 13 },
    actions: {
      flexDirection: "row",
      gap: 10,
    },
    joinBtn: {
      flex: 1,
      backgroundColor: theme.primary,
      borderRadius: theme.radiusSm,
      paddingVertical: 11,
      alignItems: "center",
    },
    joinBtnText: { color: "#fff", fontSize: 15, fontWeight: "700" },
    declineBtn: {
      flex: 1,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radiusSm,
      paddingVertical: 11,
      alignItems: "center",
    },
    declineBtnText: { color: theme.textSecondary, fontSize: 15, fontWeight: "600" },
  });