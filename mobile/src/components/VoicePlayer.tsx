import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { Pause, Play } from "lucide-react-native";
import { theme } from "../theme";

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
 */
export default function VoicePlayer({ uri }: { uri: string }) {
  const player = useAudioPlayer({ uri });
  const status = useAudioPlayerStatus(player);
  const [width, setWidth] = useState(0);

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

  function toggle() {
    if (playing) {
      player.pause();
    } else {
      player.play();
    }
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

const styles = StyleSheet.create({
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