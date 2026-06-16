import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  GestureResponderEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
} from "expo-audio";
import { Pause, Play } from "lucide-react-native";
import type { Theme } from "../theme";
import { useTheme } from "../theme/ThemeProvider";
import { getToken } from "../auth/tokenStore";

function fmtSecs(ms?: number): string {
  if (!ms || ms < 0) return "0:00";
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Playback speeds — mirrors the web client's AudioPlayer (FilePreview.tsx).
const SPEEDS = [1, 1.5, 2];

/**
 * Inline audio player bubble for voice notes / audio attachments. Mirrors the
 * web chat's audio message (client/src/components/chat/FilePreview.tsx): a round
 * play/pause toggle, a seekable progress bar with a thumb, current / total time
 * split to opposite ends, and a playback-speed button cycling 1x → 1.5x → 2x.
 * Uses expo-audio's player hooks.
 *
 * IMPORTANT: the server serves /uploads behind auth middleware (cookie OR
 * `Authorization: Bearer` header). The web client gets the cookie for free;
 * on mobile we must attach the JWT as a header on the media request or the
 * server returns 401 and the clip never plays (the original bug: tapping
 * play did nothing).
 */
export default function VoicePlayer({ uri }: { uri: string }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  // Create the player empty, then load the source once the auth token is
  // available — useAudioPlayer only takes the source at creation time, and
  // reading the token is async.
  const player = useAudioPlayer();
  const status = useAudioPlayerStatus(player);
  const [width, setWidth] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(0);
  const loadedUriRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (loadedUriRef.current === uri) return;
      const token = await getToken();
      if (!active) return;
      try {
        player.replace({
          uri,
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        loadedUriRef.current = uri;
        setLoaded(true);
      } catch {
        /* source load failed — keep the button; a retry happens on next tap */
      }
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri]);

  // Auto-reset to start when playback finishes.
  useEffect(() => {
    if (status?.didJustFinish) {
      player.seekTo(0);
      player.pause();
    }
  }, [status?.didJustFinish, player]);

  const playing = status?.playing ?? false;
  const duration = status?.duration ? status.duration * 1000 : 0;
  const position = status?.currentTime ? status.currentTime * 1000 : 0;
  const pct = duration > 0 ? Math.min(1, position / duration) : 0;

  // Re-apply the playback rate whenever playback (re)starts — some platforms
  // reset the rate to 1.0 on play, so keep it in sync with the chosen speed.
  useEffect(() => {
    if (playing) {
      try {
        player.setPlaybackRate(SPEEDS[speedIdx], "high");
      } catch {
        /* non-fatal */
      }
    }
  }, [playing, speedIdx, player]);

  async function toggle() {
    if (playing) {
      player.pause();
      return;
    }
    // Recording (in the chat composer) flips the global audio session to
    // allowsRecording=true and never restores it — on iOS that routes
    // playback to the earpiece / silences it entirely. Reset to a playback
    // session before playing (cheap no-op when already correct).
    try {
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
      });
    } catch {
      /* non-fatal */
    }
    // If the token wasn't ready on mount (rare), retry loading now.
    if (!loaded && loadedUriRef.current !== uri) {
      const token = await getToken();
      try {
        player.replace({
          uri,
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        loadedUriRef.current = uri;
        setLoaded(true);
      } catch {
        return;
      }
    }
    try {
      player.setPlaybackRate(SPEEDS[speedIdx], "high");
    } catch {
      /* non-fatal */
    }
    player.play();
  }

  // Tap anywhere on the progress bar to seek to that position (mirrors the
  // web client's click-to-seek behaviour).
  const seek = useCallback(
    (e: GestureResponderEvent) => {
      if (!duration || !width) return;
      const x = e.nativeEvent.locationX;
      const ratio = Math.max(0, Math.min(1, x / width));
      player.seekTo((ratio * duration) / 1000);
    },
    [duration, width, player],
  );

  const cycleSpeed = useCallback(() => {
    const next = (speedIdx + 1) % SPEEDS.length;
    setSpeedIdx(next);
    try {
      player.setPlaybackRate(SPEEDS[next], "high");
    } catch {
      /* non-fatal */
    }
  }, [speedIdx, player]);

  return (
    <View style={styles.wrap}>
      <Pressable style={styles.btn} onPress={toggle} hitSlop={6}>
        {playing ? (
          <Pause size={16} color="#fff" />
        ) : (
          <Play size={16} color="#fff" />
        )}
      </Pressable>

      <View style={styles.trackArea}>
        <Pressable
          style={styles.track}
          onPress={seek}
          onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
          hitSlop={8}
        >
          <View style={[styles.fill, { width: width * pct }]} />
          <View
            style={[
              styles.thumb,
              { left: Math.max(0, Math.min(width, width * pct)) - 6 },
            ]}
          />
        </Pressable>
        <View style={styles.timeRow}>
          <Text style={styles.time}>{fmtSecs(position)}</Text>
          <Text style={styles.time}>{fmtSecs(duration)}</Text>
        </View>
      </View>

      <Pressable style={styles.speedBtn} onPress={cycleSpeed} hitSlop={6}>
        <Text style={styles.speedText}>{SPEEDS[speedIdx]}x</Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    wrap: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      width: "100%",
      maxWidth: 320,
      paddingVertical: 10,
      paddingHorizontal: 14,
      backgroundColor: theme.surface,
      borderRadius: theme.radius,
      borderWidth: 1,
      borderColor: theme.glassBorder,
    },
    btn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: theme.primary,
      alignItems: "center",
      justifyContent: "center",
    },
    trackArea: { flex: 1, minWidth: 0, gap: 4 },
    track: {
      position: "relative",
      height: 6,
      borderRadius: 3,
      backgroundColor: theme.glassBorder,
      justifyContent: "center",
    },
    fill: {
      position: "absolute",
      left: 0,
      top: 0,
      height: 6,
      borderRadius: 3,
      backgroundColor: theme.primary,
    },
    thumb: {
      position: "absolute",
      top: -3,
      width: 12,
      height: 12,
      borderRadius: 6,
      backgroundColor: theme.primary,
      borderWidth: 2,
      borderColor: "#fff",
    },
    timeRow: { flexDirection: "row", justifyContent: "space-between" },
    time: { fontSize: 11, color: theme.textMuted },
    speedBtn: {
      backgroundColor: theme.surfaceHover,
      paddingVertical: 3,
      paddingHorizontal: 7,
      borderRadius: 6,
    },
    speedText: {
      fontSize: 11,
      fontWeight: "700",
      color: theme.textSecondary,
    },
  });