import { forwardRef, useMemo } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { Camera, Keyboard, Mic, Plus, Send, Smile } from "lucide-react-native";
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
  onOpenCamera: () => void;
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
    onOpenCamera,
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
          <View style={styles.pill}>
            <Pressable
              style={styles.emojiToggle}
              onPress={onToggleEmojiKeyboard}
              hitSlop={6}
            >
              {emojiKeyboardOpen ? (
                <Keyboard size={24} color={theme.textSecondary} />
              ) : (
                <Smile size={24} color={theme.textSecondary} />
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
            {/* Signal-style: camera + mic live INSIDE the pill on the right.
                They collapse while the user is typing so the send button can
                take over. */}
            {!text.trim() && !editing ? (
              <>
                <Pressable
                  style={styles.innerIconBtn}
                  onPress={onOpenCamera}
                  disabled={uploading}
                  hitSlop={6}
                >
                  <Camera size={22} color={theme.textSecondary} />
                </Pressable>
                <Pressable
                  style={styles.innerIconBtn}
                  onPress={onStartRecording}
                  disabled={uploading}
                  hitSlop={6}
                >
                  <Mic size={22} color={theme.textSecondary} />
                </Pressable>
              </>
            ) : null}
          </View>
          {text.trim() || editing ? (
            <Pressable
              style={styles.sendBtn}
              onPress={editing ? onSaveEdit : onSend}
            >
              <Send size={18} color="#fff" />
            </Pressable>
          ) : (
            /* "+" attach button now sits OUTSIDE the pill, on the right
               (Signal-Android layout). */
            <Pressable
              style={styles.plusBtn}
              onPress={onOpenAttach}
              disabled={uploading || editing}
              hitSlop={6}
            >
              {uploading ? (
                <ActivityIndicator size="small" color={theme.textSecondary} />
              ) : (
                <Plus size={24} color={theme.text} />
              )}
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
      // A little more top padding so the input row never sits flush against the
      // last message bubble / typing indicator above it (the top border would
      // otherwise touch the newest bubble).
      paddingTop: 10,
      borderTopWidth: 1,
      borderTopColor: theme.border,
      backgroundColor: theme.bgSecondary,
    },
    // "+" attach button — outside the pill, on the right (Signal-style).
    plusBtn: {
      width: 44,
      height: 44,
      borderRadius: 22,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.glassBorder,
    },
    // Camera / mic icons that live inside the pill on the right.
    innerIconBtn: {
      width: 38,
      height: 40,
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
      paddingRight: 4,
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