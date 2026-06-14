import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { RTCView } from "react-native-webrtc";
import {
  Mic,
  MicOff,
  PhoneOff,
  SwitchCamera,
  Video as VideoIcon,
  VideoOff,
} from "lucide-react-native";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import { useAuth } from "../../src/auth/AuthContext";
import { getMeeting } from "../../src/features";
import { SERVER_ORIGIN } from "../../src/config";
import {
  useMeetingMesh,
  type MeetingParticipant,
} from "../../src/meeting/useMeetingMesh";

/**
 * In-app meeting room. Joins the SAME WebRTC mesh as the web/desktop clients
 * (server/utils/ws.ts relays the signaling) instead of bouncing the user to a
 * browser. Built on react-native-webrtc (already used by the 1:1 call screen).
 */
export default function MeetingScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const { user } = useAuth();
  const { code } = useLocalSearchParams<{ code: string }>();

  const [meetingId, setMeetingId] = useState<number | null>(null);
  const [title, setTitle] = useState("Meeting");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  // Resolve the meeting by code (mirrors the web auto-join path).
  useEffect(() => {
    if (!code) return;
    let cancelled = false;
    getMeeting(code)
      .then((r) => {
        if (cancelled) return;
        setMeetingId(r.data.id);
        if (r.data.title) setTitle(r.data.title);
      })
      .catch(() => {
        if (!cancelled)
          setLoadError("Meeting not found or you are not invited.");
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  const {
    localStream,
    participants,
    muted,
    videoOff,
    status,
    mediaError,
    toggleMute,
    toggleVideo,
    switchCamera,
    leave,
  } = useMeetingMesh({
    meetingId,
    selfId: user?.id ?? null,
    initialMuted: false,
    initialVideoOff: false,
  });

  // Leave the meeting (or bounce back) when the host ends it.
  useEffect(() => {
    if (status === "ended") {
      leave();
      router.back();
    }
  }, [status, leave, router]);

  const handleLeave = () => {
    leave();
    router.back();
  };

  async function openInBrowser() {
    setOpening(true);
    try {
      await Linking.openURL(`${SERVER_ORIGIN}/meeting/${code}`);
    } finally {
      setOpening(false);
    }
  }

  // ── Error / fallback states ──────────────────────────────────────────────
  if (loadError || mediaError) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: "Meeting" }} />
        <View style={styles.card}>
          <View style={styles.iconWrap}>
            <VideoIcon size={32} color={theme.primary} />
          </View>
          <Text style={styles.title}>Can't join the meeting</Text>
          <Text style={styles.hint}>{loadError || mediaError}</Text>
          {!loadError ? (
            <Pressable
              style={styles.fallbackBtn}
              onPress={openInBrowser}
              disabled={opening}
            >
              {opening ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <VideoIcon size={16} color="#fff" />
                  <Text style={styles.fallbackBtnText}>Open in browser</Text>
                </>
              )}
            </Pressable>
          ) : null}
          <Pressable style={styles.linkBtn} onPress={() => router.back()}>
            <Text style={styles.linkBtnText}>Go back</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const remoteParticipants = Array.from(participants.values());
  const connecting = status === "joining" || status === "connecting";

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.headerStatus}>
          {status === "connected"
            ? `${remoteParticipants.length + 1} in call`
            : connecting
              ? "Connecting…"
              : "Joining…"}
        </Text>
      </View>

      {/* Video grid */}
      <ScrollView contentContainerStyle={styles.grid}>
        {/* Self tile */}
        <VideoTile
          theme={theme}
          name="You"
          stream={localStream}
          videoOff={videoOff}
          muted={muted}
          mirror
        />
        {remoteParticipants.map((p) => (
          <RemoteTile key={String(p.userId)} theme={theme} participant={p} />
        ))}
      </ScrollView>

      {connecting && remoteParticipants.length === 0 ? (
        <View style={styles.waiting}>
          <ActivityIndicator color={theme.primary} />
          <Text style={styles.waitingText}>Waiting for others to join…</Text>
        </View>
      ) : null}

      {/* Controls */}
      <View style={styles.controls}>
        <Pressable style={styles.ctrl} onPress={toggleMute}>
          {muted ? (
            <MicOff size={24} color="#fff" />
          ) : (
            <Mic size={24} color="#fff" />
          )}
        </Pressable>
        <Pressable style={styles.ctrl} onPress={toggleVideo}>
          {videoOff ? (
            <VideoOff size={24} color="#fff" />
          ) : (
            <VideoIcon size={24} color="#fff" />
          )}
        </Pressable>
        <Pressable style={styles.ctrl} onPress={switchCamera}>
          <SwitchCamera size={24} color="#fff" />
        </Pressable>
        <Pressable style={[styles.ctrl, styles.leave]} onPress={handleLeave}>
          <PhoneOff size={26} color="#fff" />
        </Pressable>
      </View>
    </View>
  );
}

function RemoteTile({
  theme,
  participant,
}: {
  theme: Theme;
  participant: MeetingParticipant;
}) {
  return (
    <VideoTile
      theme={theme}
      name={participant.name}
      stream={participant.stream}
      videoOff={participant.videoOff}
      muted={participant.muted}
    />
  );
}

function VideoTile({
  theme,
  name,
  stream,
  videoOff,
  muted,
  mirror = false,
}: {
  theme: Theme;
  name: string;
  stream: any;
  videoOff: boolean;
  muted: boolean;
  mirror?: boolean;
}) {
  const { width } = useWindowDimensions();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  // Two columns with 12px outer + gap padding.
  const tileWidth = (width - 36) / 2;
  const showVideo = stream && !videoOff;

  return (
    <View style={[styles.tile, { width: tileWidth, height: tileWidth * 1.2 }]}>
      {showVideo ? (
        <RTCView
          streamURL={(stream as any).toURL()}
          style={styles.tileVideo}
          objectFit="cover"
          mirror={mirror}
          zOrder={0}
        />
      ) : (
        <View style={styles.tileAvatarWrap}>
          <View style={styles.tileAvatar}>
            <Text style={styles.tileAvatarText}>
              {(name || "?")[0]?.toUpperCase()}
            </Text>
          </View>
        </View>
      )}
      <View style={styles.tileFooter}>
        {muted ? <MicOff size={12} color="#fff" /> : null}
        <Text style={styles.tileName} numberOfLines={1}>
          {name}
        </Text>
      </View>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: "#0a0a0a",
      paddingTop: 44,
    },
    header: {
      paddingHorizontal: 16,
      paddingBottom: 8,
      gap: 2,
    },
    headerTitle: { color: "#fff", fontSize: 18, fontWeight: "700" },
    headerStatus: { color: "rgba(255,255,255,0.6)", fontSize: 13 },
    grid: {
      flexGrow: 1,
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 12,
      padding: 12,
      justifyContent: "flex-start",
    },
    tile: {
      backgroundColor: "#161616",
      borderRadius: 14,
      overflow: "hidden",
      borderWidth: 1,
      borderColor: "rgba(255,255,255,0.08)",
    },
    tileVideo: { flex: 1, backgroundColor: "#000" },
    tileAvatarWrap: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
    },
    tileAvatar: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: theme.primary,
      alignItems: "center",
      justifyContent: "center",
    },
    tileAvatarText: { color: "#fff", fontSize: 26, fontWeight: "700" },
    tileFooter: {
      position: "absolute",
      bottom: 6,
      left: 6,
      right: 6,
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: "rgba(0,0,0,0.45)",
      borderRadius: 8,
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    tileName: { color: "#fff", fontSize: 12, fontWeight: "600", flex: 1 },
    waiting: {
      position: "absolute",
      top: "45%",
      left: 0,
      right: 0,
      alignItems: "center",
      gap: 10,
    },
    waitingText: { color: "rgba(255,255,255,0.6)", fontSize: 14 },
    controls: {
      flexDirection: "row",
      justifyContent: "center",
      gap: 18,
      paddingVertical: 18,
      paddingBottom: 36,
    },
    ctrl: {
      width: 58,
      height: 58,
      borderRadius: 29,
      backgroundColor: "rgba(255,255,255,0.18)",
      alignItems: "center",
      justifyContent: "center",
    },
    leave: { backgroundColor: theme.danger },
    // ── Error / fallback card ──
    card: {
      margin: 16,
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radiusLg,
      padding: 24,
      alignItems: "center",
      gap: 10,
    },
    iconWrap: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: theme.primaryGlow,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 4,
    },
    title: { fontSize: 18, fontWeight: "800", color: theme.text },
    hint: {
      fontSize: 13,
      color: theme.textMuted,
      textAlign: "center",
      lineHeight: 19,
      marginVertical: 4,
    },
    fallbackBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      backgroundColor: theme.primary,
      borderRadius: theme.radiusSm,
      paddingVertical: 12,
      paddingHorizontal: 24,
      marginTop: 6,
    },
    fallbackBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
    linkBtn: { paddingVertical: 10, paddingHorizontal: 16 },
    linkBtnText: { color: theme.textSecondary, fontSize: 14 },
  });