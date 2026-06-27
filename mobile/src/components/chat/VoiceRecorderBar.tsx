import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Send, X as XIcon } from "lucide-react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import { fmtRecTime } from "./chatUtils";

/**
 * In-composer voice-recording UI (mirrors the recording state of the web
 * composer). Presentational only — the recorder/audio-session logic lives in
 * the parent. Renders the cancel button, the live "Recording… mm:ss" bar, and
 * the stop-and-send button. Meant to sit inside the composer's input row.
 */
export default function VoiceRecorderBar({
  durationMillis,
  onCancel,
  onStopAndSend,
}: {
  durationMillis: number;
  onCancel: () => void;
  onStopAndSend: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  return (
    <>
      <Pressable style={styles.attachBtn} onPress={onCancel} hitSlop={6}>
        <XIcon size={22} color={theme.danger} />
      </Pressable>
      <View style={styles.recordingBar}>
        <View style={styles.recDot} />
        <Text style={styles.recText}>
          Recording… {fmtRecTime(durationMillis)}
        </Text>
      </View>
      <Pressable style={styles.sendBtn} onPress={onStopAndSend}>
        <Send size={18} color="#fff" />
      </Pressable>
    </>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    attachBtn: {
      width: 46,
      height: 46,
      borderRadius: 23,
      alignItems: "center",
      justifyContent: "center",
    },
    sendBtn: {
      width: 46,
      height: 46,
      borderRadius: 23,
      backgroundColor: theme.primary,
      alignItems: "center",
      justifyContent: "center",
    },
    recordingBar: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      minHeight: 46,
      backgroundColor: theme.inputBg,
      borderWidth: 1,
      borderColor: theme.inputBorder,
      borderRadius: 23,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    recDot: {
      width: 10,
      height: 10,
      borderRadius: 5,
      backgroundColor: theme.danger,
    },
    recText: { color: theme.text, fontSize: 14 },
  });
