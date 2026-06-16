import { useMemo } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { Mic, Plus, Send } from "lucide-react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import { scrollFocusedIntoView } from "../../hooks/useKeyboardInset";
import VoiceRecorderBar from "./VoiceRecorderBar";

/**
 * Chat composer / input bar (mirrors the web message composer). Shows the
 * voice-recording UI while recording, otherwise the attach "+" button, the
 * multiline text input, and a send/mic toggle. Presentational — all state and
 * the recorder/audio-session logic live in the parent.
 */
export default function Composer({
  text,
  editing,
  uploading,
  isRecording,
  recordingMillis,
  bottomInset,
  onChangeText,
  onSend,
  onSaveEdit,
  onOpenAttach,
  onStartRecording,
  onCancelRecording,
  onStopAndSend,
}: {
  text: string;
  editing: boolean;
  uploading: boolean;
  isRecording: boolean;
  recordingMillis: number;
  bottomInset: number;
  onChangeText: (v: string) => void;
  onSend: () => void;
  onSaveEdit: () => void;
  onOpenAttach: () => void;
  onStartRecording: () => void;
  onCancelRecording: () => void;
  onStopAndSend: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  return (
    <View style={[styles.inputBar, { paddingBottom: bottomInset }]}>
      {isRecording ? (
        <VoiceRecorderBar
          durationMillis={recordingMillis}
          onCancel={onCancelRecording}
          onStopAndSend={onStopAndSend}
        />
      ) : (
        <>
          <Pressable
            style={styles.attachBtn}
            onPress={onOpenAttach}
            disabled={uploading || editing}
          >
            {uploading ? (
              <ActivityIndicator size="small" color={theme.textSecondary} />
            ) : (
              <Plus size={22} color={theme.textSecondary} />
            )}
          </Pressable>
          <TextInput
            style={styles.input}
            placeholder={editing ? "Edit message" : "Message"}
            placeholderTextColor={theme.textMuted}
            value={text}
            onChangeText={onChangeText}
            onFocus={scrollFocusedIntoView}
            multiline
          />
          {text.trim() || editing ? (
            <Pressable
              style={styles.sendBtn}
              onPress={editing ? onSaveEdit : onSend}
            >
              <Send size={18} color="#fff" />
            </Pressable>
          ) : (
            <Pressable
              style={styles.sendBtn}
              onPress={onStartRecording}
              disabled={uploading}
            >
              <Mic size={18} color="#fff" />
            </Pressable>
          )}
        </>
      )}
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    inputBar: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 8,
      paddingHorizontal: 12,
      paddingTop: 8,
      borderTopWidth: 1,
      borderTopColor: theme.border,
      backgroundColor: theme.bgSecondary,
    },
    attachBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
    },
    input: {
      flex: 1,
      maxHeight: 120,
      backgroundColor: theme.inputBg,
      borderWidth: 1,
      borderColor: theme.inputBorder,
      borderRadius: 20,
      paddingHorizontal: 16,
      paddingVertical: 10,
      color: theme.text,
      fontSize: 15,
    },
    sendBtn: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: theme.primary,
      alignItems: "center",
      justifyContent: "center",
    },
  });