import { forwardRef, useMemo } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { Keyboard, Mic, Plus, Send, Smile } from "lucide-react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import { scrollFocusedIntoView } from "../../hooks/useKeyboardInset";
import VoiceRecorderBar from "./VoiceRecorderBar";

/**
 * Chat composer / input bar (mirrors the web message composer). Shows the
 * voice-recording UI while recording, otherwise the inline emoji/keyboard
 * toggle (Signal-style), attach "+" button, the multiline text input, and a
 * send/mic toggle. Presentational — all state, the recorder/audio-session logic
 * and the docked emoji-keyboard live in the parent.
 *
 * `ref` is forwarded to the TextInput so the parent can blur/focus it when
 * switching between the system keyboard and the in-app emoji keyboard.
 */
const Composer = forwardRef<TextInput, {
  text: string;
  editing: boolean;
  uploading: boolean;
  isRecording: boolean;
  recordingMillis: number;
  bottomInset: number;
  emojiKeyboardOpen: boolean;
  onChangeText: (v: string) => void;
  onSend: () => void;
  onSaveEdit: () => void;
  onOpenAttach: () => void;
  onToggleEmojiKeyboard: () => void;
  onInputFocus: () => void;
  onStartRecording: () => void;
  onCancelRecording: () => void;
  onStopAndSend: () => void;
}>(function Composer(
  {
    text,
    editing,
    uploading,
    isRecording,
    recordingMillis,
    bottomInset,
    emojiKeyboardOpen,
    onChangeText,
    onSend,
    onSaveEdit,
    onOpenAttach,
    onToggleEmojiKeyboard,
    onInputFocus,
    onStartRecording,
    onCancelRecording,
    onStopAndSend,
  },
  ref
) {
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
          <View style={styles.pill}>
            <Pressable
              style={styles.emojiToggle}
              onPress={onToggleEmojiKeyboard}
              hitSlop={6}
            >
              {emojiKeyboardOpen ? (
                <Keyboard size={22} color={theme.textSecondary} />
              ) : (
                <Smile size={22} color={theme.textSecondary} />
              )}
            </Pressable>
            <TextInput
              ref={ref}
              style={styles.input}
              placeholder={editing ? "Edit message" : "Message"}
              placeholderTextColor={theme.textMuted}
              value={text}
              onChangeText={onChangeText}
              onFocus={() => {
                onInputFocus();
                scrollFocusedIntoView();
              }}
              // Prevent the system keyboard from auto-opening when we want the
              // in-app emoji keyboard instead. The parent re-enables it by
              // calling focus() after setting emojiKeyboardOpen=false.
              showSoftInputOnFocus={!emojiKeyboardOpen}
              multiline
            />
          </View>
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
});

export default Composer;

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
    // Rounded "pill" holding the inline emoji toggle + the text input, so the
    // emoji button sits inside the field (Signal-style).
    pill: {
      flex: 1,
      flexDirection: "row",
      alignItems: "flex-end",
      backgroundColor: theme.inputBg,
      borderWidth: 1,
      borderColor: theme.inputBorder,
      borderRadius: 20,
      maxHeight: 120,
    },
    emojiToggle: {
      width: 38,
      height: 40,
      alignItems: "center",
      justifyContent: "center",
    },
    input: {
      flex: 1,
      maxHeight: 118,
      paddingRight: 16,
      paddingLeft: 4,
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