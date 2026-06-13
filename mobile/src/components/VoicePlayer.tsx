import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
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

/**
 * Inline audio player bubble for voice notes / audio attachments. Mirrors the
 * web chat's audio message: play/pause toggle + a progress bar + elapsed /
 * total duration. Uses expo-audio's player hooks.
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
    player.play();
  }

  return (
    <View style={styles.wrap}>
      <Pressable style={styles.btn} onPress={toggle} hitSlop={6}>
        {playing ? (
          <Pause size={18} color="#fff" />
        ) : (
          <Play size={18} color="#fff" />
        )}
      </Pressable>
      <View style={styles.right}>
        <View
          style={styles.track}
          onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        >
          <View style={[styles.fill, { width: width * pct }]} />
        </View>
        <Text style={styles.time}>
          {fmtSecs(position)} / {fmtSecs(duration)}
        </Text>
      </View>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minWidth: 190,
    paddingVertical: 2,
  },
  btn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  right: { flex: 1, gap: 4 },
  track: {
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.surfaceHover,
    overflow: "hidden",
  },
  fill: { height: 4, borderRadius: 2, backgroundColor: theme.primary },
  time: { fontSize: 11, color: theme.textMuted },
});