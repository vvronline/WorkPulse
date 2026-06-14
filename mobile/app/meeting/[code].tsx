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
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { RTCView } from "react-native-webrtc";
import {
  Check,
  Copy,
  Mic,
  MicOff,
  Minimize2,
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
 * browser. The layout mirrors the web client's mobile meeting view
 * (client/src/pages/MeetingRoom.tsx + MeetingRoom.css): a header with the
 * title / copyable code / elapsed timer, an adaptive participant grid with
 * name + mute + connecting overlays, and a bottom control bar.
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
  const [codeCopied, setCodeCopied] = useState(false);
  const [elapsed, setElapsed] = useState(0);

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

  // Elapsed timer — starts ticking once we're connected.
  useEffect(() => {
    if (status !== "connected") return;
    const startedAt = Date.now();
    setElapsed(0);
    const t = setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => clearInterval(t);
  }, [status]);

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

  async function copyCode() {
    if (!code) return;
    try {
      await Clipboard.setStringAsync(code);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    } catch {
      /* ignore */
    }
  }

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
          <Text style={styles.cardTitle}>Can't join the meeting</Text>
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
  // Tile count = self + remote participants. Drives the adaptive grid columns.
  const tileCount = remoteParticipants.length + 1;
  const statusText =
    status === "connected"
      ? `${tileCount} in call`
      : status === "connecting"
        ? "Connecting…"
        : "Joining…";

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {title}
          </Text>
          <Pressable style={styles.codePill} onPress={copyCode}>
            <Text style={styles.codeText}>{code}</Text>
            {codeCopied ? (
              <Check size={12} color={theme.success} />
            ) : (
              <Copy size={12} color={theme.textMuted} />
            )}
          </Pressable>
        </View>
        <View style={styles.headerRight}>
          <Text style={styles.headerStatus}>
            {status === "connected" ? formatTime(elapsed) : statusText}
          </Text>
          <Pressable style={styles.headerBtn} onPress={() => router.back()}>
            <Minimize2 size={16} color={theme.text} />
          </Pressable>
        </View>
      </View>

      {/* Video grid */}
      <ScrollView
        style={styles.gridScroll}
        contentContainerStyle={styles.grid}
      >
        {/* Self tile */}
        <VideoTile
          theme={theme}
          tileCount={tileCount}
          name="You"
          isLocal
          stream={localStream}
          videoOff={videoOff}
          muted={muted}
          connected
          mirror
        />
        {remoteParticipants.map((p) => (
          <RemoteTile
            key={String(p.userId)}
            theme={theme}
            tileCount={tileCount}
            participant={p}
          />
        ))}
      </ScrollView>

      {connecting && remoteParticipants.length === 0 ? (
        <View style={styles.waiting} pointerEvents="none">
          <ActivityIndicator color={theme.primary} />
          <Text style={styles.waitingText}>Waiting for others to join…</Text>
        </View>
      ) : null}

      {/* Bottom control bar */}
      <View style={styles.controls}>
        <ControlButton
          theme={theme}
          active={muted}
          label={muted ? "Unmute" : "Mute"}
          onPress={toggleMute}
          icon={
            muted ? (
              <MicOff size={22} color="#fff" />
            ) : (
              <Mic size={22} color="#fff" />
            )
          }
        />
        <ControlButton
          theme={theme}
          active={videoOff}
          label={videoOff ? "Start" : "Stop"}
          onPress={toggleVideo}
          icon={
            videoOff ? (
              <VideoOff size={22} color="#fff" />
            ) : (
              <VideoIcon size={22} color="#fff" />
            )
          }
        />
        <ControlButton
          theme={theme}
          label="Flip"
          onPress={switchCamera}
          icon={<SwitchCamera size={22} color="#fff" />}
        />
        <ControlButton
          theme={theme}
          danger
          label="Leave"
          onPress={handleLeave}
          icon={<PhoneOff size={24} color="#fff" />}
        />
      </View>
    </SafeAreaView>
  );
}

function formatTime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function ControlButton({
  theme,
  icon,
  label,
  onPress,
  active = false,
  danger = false,
}: {
  theme: Theme;
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  active?: boolean;
  danger?: boolean;
}) {
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View style={styles.ctrlWrap}>
      <Pressable
        style={[
          styles.ctrl,
          active && styles.ctrlActive,
          danger && styles.ctrlDanger,
        ]}
        onPress={onPress}
      >
        {icon}
      </Pressable>
      <Text style={styles.ctrlLabel}>{label}</Text>
    </View>
  );
}

function RemoteTile({
  theme,
  participant,
  tileCount,
}: {
  theme: Theme;
  participant: MeetingParticipant;
  tileCount: number;
}) {
  return (
    <VideoTile
      theme={theme}
      tileCount={tileCount}
      name={participant.name}
      stream={participant.stream}
      videoOff={participant.videoOff}
      muted={participant.muted}
      connected={!!participant.stream}
    />
  );
}

function VideoTile({
  theme,
  name,
  stream,
  videoOff,
  muted,
  tileCount,
  isLocal = false,
  connected = false,
  mirror = false,
}: {
  theme: Theme;
  name: string;
  stream: any;
  videoOff: boolean;
  muted: boolean;
  tileCount: number;
  isLocal?: boolean;
  connected?: boolean;
  mirror?: boolean;
}) {
  const { width, height } = useWindowDimensions();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  // Adaptive grid sizing (mirrors web's mobile breakpoints): 1 column for a
  // 1:1 call, 2 columns otherwise. Tiles fill the available width with a
  // square-ish aspect so they don't look stretched.
  const gap = 10;
  const outer = 12;
  const cols = tileCount <= 1 ? 1 : 2;
  const tileWidth = (width - outer * 2 - gap * (cols - 1)) / cols;
  // For a single tile take most of the screen; for grids keep a 3:4 portrait.
  const tileHeight =
    tileCount <= 1
      ? Math.min(height * 0.62, tileWidth * 1.2)
      : tileWidth * 1.15;
  const showVideo = stream && !videoOff;
  const displayName = isLocal ? `${name} (You)` : name;
  const showConnecting = !isLocal && !connected;

  return (
    <View style={[styles.tile, { width: tileWidth, height: tileHeight }]}>
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
          {showConnecting ? (
            <View style={styles.tileStatusRow}>
              <ActivityIndicator size="small" color={theme.textSecondary} />
              <Text style={styles.tileStatusText}>Connecting…</Text>
            </View>
          ) : null}
        </View>
      )}
      <View style={styles.tileFooter}>
        {muted ? <MicOff size={12} color="#fff" /> : null}
        <Text style={styles.tileName} numberOfLines={1}>
          {displayName}
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
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      paddingVertical: 10,
      gap: 12,
    },
    headerLeft: { flex: 1, gap: 4 },
    headerTitle: { color: "#fff", fontSize: 17, fontWeight: "700" },
    codePill: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "flex-start",
      gap: 6,
      backgroundColor: "rgba(255,255,255,0.08)",
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    codeText: {
      color: "rgba(255,255,255,0.7)",
      fontSize: 12,
      fontWeight: "600",
      letterSpacing: 0.5,
    },
    headerRight: { flexDirection: "row", alignItems: "center", gap: 10 },
    headerStatus: { color: "rgba(255,255,255,0.6)", fontSize: 13 },
    headerBtn: {
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor: "rgba(255,255,255,0.08)",
      alignItems: "center",
      justifyContent: "center",
    },
    gridScroll: { flex: 1 },
    grid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 10,
      padding: 12,
      justifyContent: "center",
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
      gap: 12,
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
    tileStatusRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    tileStatusText: {
      color: "rgba(255,255,255,0.55)",
      fontSize: 12,
      fontWeight: "500",
    },
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
      alignItems: "flex-start",
      gap: 22,
      paddingVertical: 14,
      paddingBottom: 20,
      backgroundColor: "rgba(0,0,0,0.3)",
    },
    ctrlWrap: { alignItems: "center", gap: 6 },
    ctrl: {
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: "rgba(255,255,255,0.16)",
      alignItems: "center",
      justifyContent: "center",
    },
    ctrlActive: { backgroundColor: "rgba(255,255,255,0.32)" },
    ctrlDanger: { backgroundColor: theme.danger },
    ctrlLabel: { color: "rgba(255,255,255,0.7)", fontSize: 11 },
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
    cardTitle: { fontSize: 18, fontWeight: "800", color: theme.text },
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