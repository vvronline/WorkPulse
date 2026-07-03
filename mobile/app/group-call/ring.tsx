import { useEffect, useMemo, useRef, useState } from "react";
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  Vibration,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from "expo-audio";
import { Phone, PhoneOff, Users } from "lucide-react-native";
import { socket } from "../../src/realtime/socket";
import { endCallNavigation } from "../../src/realtime/callRouting";
import { useAuth } from "../../src/auth/AuthContext";
import { notifeeService } from "../../src/services/notifeeService";
import { loadCallPrefs } from "../../src/services/callPrefsStore";
import { warmIceConfig } from "../../src/features";
import { SERVER_ORIGIN } from "../../src/config";
import { getNotificationPreviewDataUri } from "../../src/utils/notificationSoundPreview";
import { FONTS } from "../../src/fonts";

// How long the incoming group-call ring screen stays up before auto-dismissing
// as "missed" (parity with the 1:1 ring TTL).
const RING_TIMEOUT_MS = 45_000;

function resolveAvatarUrl(avatar?: string | null): string | null {
  if (!avatar) return null;
  if (avatar.startsWith("http")) return avatar;
  return `${SERVER_ORIGIN}${avatar.startsWith("/") ? "" : "/"}${avatar}`;
}

/**
 * Full-screen INCOMING GROUP-CALL ring UI (Signal/WhatsApp group-call parity).
 *
 * Before this screen existed the foreground `call_incoming` (huddle) path
 * auto-navigated straight into the meeting room — the user was yanked into a
 * "Joining…" screen with NO chance to accept or decline. Now:
 *   • Accept  → replace to /meeting/<code>?huddle=1&callType=…  (join mesh)
 *   • Decline → send `huddle_decline` (server marks us declined, dismisses
 *               the ring on our other devices, and tells the joined members)
 *   • The ring auto-dismisses on `call_ended` / `call_handled_elsewhere`
 *     for this callId (caller backed out / answered on another device) and
 *     after RING_TIMEOUT_MS.
 */
export default function GroupCallRingScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const params = useLocalSearchParams<{
    meetingCode: string;
    callId?: string;
    meetingId?: string;
    conversationId?: string;
    callType?: string;
    callerName?: string;
    callerAvatar?: string;
    groupName?: string;
  }>();

  const meetingCode = params.meetingCode;
  const callId = params.callId ? String(params.callId) : null;
  const meetingId = params.meetingId ? Number(params.meetingId) : null;
  const callType = params.callType === "video" ? "video" : "voice";
  const groupName = params.groupName || "Group call";
  const callerName = params.callerName || "Someone";
  const avatarUrl = resolveAvatarUrl(params.callerAvatar);

  const [muteAll, setMuteAll] = useState(false);
  const [ringtoneId, setRingtoneId] = useState("classic");
  const handledRef = useRef(false);

  const ringPlayer = useAudioPlayer();
  const ringStatus = useAudioPlayerStatus(ringPlayer);
  const ringLoadedRef = useRef(false);

  // Warm TURN creds while ringing so Accept connects deterministically, and
  // dismiss any system full-screen-intent notification for this same call so
  // we never double-ring (screen tone + Notifee looped sound).
  useEffect(() => {
    void warmIceConfig();
    if (callId && params.conversationId) {
      void notifeeService.cancelCall(callId, String(params.conversationId));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load the cached call prefs (selected ringtone + muteAll).
  useEffect(() => {
    let active = true;
    loadCallPrefs()
      .then((p) => {
        if (!active) return;
        setMuteAll(!!p.muteAll);
        setRingtoneId(p.ringtone || "classic");
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  // Ringtone loop.
  const shouldRing = !muteAll && ringtoneId !== "none";
  useEffect(() => {
    if (!shouldRing) {
      try {
        ringPlayer.pause();
        ringPlayer.seekTo(0);
      } catch {
        /* no-op */
      }
      return;
    }
    const uri = getNotificationPreviewDataUri("ringtone", ringtoneId);
    if (!uri) return;
    if (!ringLoadedRef.current) {
      ringPlayer.replace({ uri });
      ringLoadedRef.current = true;
    }
    setAudioModeAsync({
      allowsRecording: false,
      playsInSilentMode: true,
      shouldPlayInBackground: false,
      interruptionMode: "doNotMix",
      shouldRouteThroughEarpiece: false,
    })
      .then(() => ringPlayer.play())
      .catch(() => {});
  }, [ringPlayer, ringtoneId, shouldRing]);

  useEffect(() => {
    if (!shouldRing || !ringStatus?.didJustFinish) return;
    try {
      ringPlayer.seekTo(0);
      ringPlayer.play();
    } catch {
      /* no-op */
    }
  }, [ringPlayer, ringStatus?.didJustFinish, shouldRing]);

  useEffect(
    () => () => {
      try {
        ringPlayer.pause();
        ringPlayer.seekTo(0);
      } catch {
        /* no-op */
      }
    },
    [ringPlayer],
  );

  // Vibration loop (same pattern as the 1:1 incoming call screen).
  useEffect(() => {
    if (muteAll) return;
    try {
      Vibration.vibrate([0, 700, 1500], true);
    } catch {
      /* no-op */
    }
    return () => {
      try {
        Vibration.cancel();
      } catch {
        /* no-op */
      }
    };
  }, [muteAll]);

  // Auto-dismiss when the call dies or was handled on another device.
  useEffect(() => {
    if (!user) return;
    const off = socket.subscribe((msg) => {
      const d: any = msg.data || {};
      if (
        msg.type === "call_ended" ||
        msg.type === "call_rejected" ||
        msg.type === "call_handled_elsewhere"
      ) {
        if (callId != null && String(d.callId) !== callId) return;
        if (handledRef.current) return;
        handledRef.current = true;
        endCallNavigation();
        router.back();
      }
    });
    return off;
  }, [user, callId, router]);

  // Ring timeout — treat as missed and dismiss.
  useEffect(() => {
    const t = setTimeout(() => {
      if (handledRef.current) return;
      handledRef.current = true;
      // Best-effort decline so the joined members' "Ringing…" state clears.
      if (meetingId) {
        socket.send("huddle_decline", {
          meetingId,
          clientMsgId: `hd-timeout-${meetingId}-${Date.now()}`,
        });
      }
      endCallNavigation();
      router.back();
    }, RING_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [meetingId, router]);

  const accept = () => {
    if (handledRef.current) return;
    handledRef.current = true;
    try {
      Vibration.cancel();
    } catch {
      /* no-op */
    }
    // Release the incoming-call navigation claim — the meeting room is not a
    // /call screen, so keeping the claim would block a FUTURE incoming call's
    // ring navigation.
    endCallNavigation();
    // Replace (not push) so Back from the call room doesn't return to a dead
    // ring screen.
    router.replace(
      `/meeting/${meetingCode}?huddle=1&callType=${callType}` as never,
    );
  };

  const decline = () => {
    if (handledRef.current) return;
    handledRef.current = true;
    if (meetingId) {
      socket.send("huddle_decline", {
        meetingId,
        clientMsgId: `hd-${meetingId}-${user?.id ?? 0}-${Date.now()}`,
      });
    }
    endCallNavigation();
    router.back();
  };

  const styles = useMemo(() => makeStyles(), []);
  const callLabel =
    callType === "video" ? "Incoming video call" : "Incoming voice call";

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ headerShown: false }} />
      <LinearGradient
        colors={["#12203a", "#0a0e1c"] as const}
        style={StyleSheet.absoluteFill}
      />
      <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
        <View style={styles.info}>
          <View style={styles.groupBadge}>
            <Users size={14} color="#9db2d8" />
            <Text style={styles.groupBadgeText} numberOfLines={1}>
              {groupName}
            </Text>
          </View>
          <View style={styles.avatarWrap}>
            {avatarUrl ? (
              <Image source={{ uri: avatarUrl }} style={styles.avatar} />
            ) : (
              <View style={styles.avatarPlaceholder}>
                <Text style={styles.avatarInitial}>
                  {(callerName || "?")[0]?.toUpperCase()}
                </Text>
              </View>
            )}
            <View style={styles.pulseRing} />
          </View>
          <Text style={styles.callerName} numberOfLines={1}>
            {callerName}
          </Text>
          <Text style={styles.callLabel}>{callLabel}</Text>
        </View>

        <View style={styles.actions}>
          <View style={styles.actionWrap}>
            <Pressable style={styles.decline} onPress={decline} hitSlop={8}>
              <PhoneOff size={30} color="#fff" />
            </Pressable>
            <Text style={styles.actionLabel}>Decline</Text>
          </View>
          <View style={styles.actionWrap}>
            <Pressable style={styles.accept} onPress={accept} hitSlop={8}>
              <Phone size={30} color="#fff" />
            </Pressable>
            <Text style={styles.actionLabel}>Accept</Text>
          </View>
        </View>
      </SafeAreaView>
    </View>
  );
}

function makeStyles() {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: "#0a0e1c" },
    safe: { flex: 1, justifyContent: "space-between" },
    info: { alignItems: "center", marginTop: 80, paddingHorizontal: 24 },
    groupBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: "rgba(255,255,255,0.08)",
      borderRadius: 16,
      paddingHorizontal: 12,
      paddingVertical: 6,
      marginBottom: 28,
      maxWidth: "90%",
    },
    groupBadgeText: {
      color: "#9db2d8",
      fontSize: 13,
      fontFamily: FONTS.medium,
    },
    avatarWrap: {
      width: 120,
      height: 120,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 22,
    },
    avatar: { width: 108, height: 108, borderRadius: 54 },
    avatarPlaceholder: {
      width: 108,
      height: 108,
      borderRadius: 54,
      backgroundColor: "#2a3b5e",
      alignItems: "center",
      justifyContent: "center",
    },
    avatarInitial: {
      color: "#fff",
      fontSize: 42,
      fontFamily: FONTS.bold,
    },
    pulseRing: {
      position: "absolute",
      width: 120,
      height: 120,
      borderRadius: 60,
      borderWidth: 2,
      borderColor: "rgba(255,255,255,0.25)",
    },
    callerName: {
      color: "#fff",
      fontSize: 26,
      fontFamily: FONTS.bold,
      marginBottom: 8,
      maxWidth: "90%",
      textAlign: "center",
    },
    callLabel: {
      color: "rgba(255,255,255,0.65)",
      fontSize: 15,
      fontFamily: FONTS.regular,
    },
    actions: {
      flexDirection: "row",
      justifyContent: "space-evenly",
      alignItems: "flex-end",
      paddingBottom: 48,
    },
    actionWrap: { alignItems: "center", gap: 10 },
    decline: {
      width: 68,
      height: 68,
      borderRadius: 34,
      backgroundColor: "#e5484d",
      alignItems: "center",
      justifyContent: "center",
    },
    accept: {
      width: 68,
      height: 68,
      borderRadius: 34,
      backgroundColor: "#30a46c",
      alignItems: "center",
      justifyContent: "center",
    },
    actionLabel: {
      color: "rgba(255,255,255,0.8)",
      fontSize: 13,
      fontFamily: FONTS.medium,
    },
  });
}