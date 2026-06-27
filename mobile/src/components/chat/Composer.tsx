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
const Composer = forwardRef<
  TextInput,
  {
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
  }
>(function Composer(
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
  ref,
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
              hitSlop={8}
            >
              {emojiKeyboardOpen ? (
                <Keyboard size={23} color={theme.textSecondary} />
              ) : (
                <Smile size={23} color={theme.textSecondary} />
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
                  hitSlop={8}
                >
                  <Camera size={22} color={theme.textSecondary} />
                </Pressable>
                <Pressable
                  style={styles.innerIconBtn}
                  onPress={onStartRecording}
                  disabled={uploading}
                  hitSlop={8}
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
              <Send size={20} color="#fff" />
            </Pressable>
          ) : (
            /* "+" attach button now sits OUTSIDE the pill, on the right
               (Signal-Android layout). */
            <Pressable
              style={styles.plusBtn}
              onPress={onOpenAttach}
              disabled={uploading || editing}
              hitSlop={8}
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
      gap: 6,
      paddingHorizontal: 8,
      // Signal-style: the compose row blends straight into the conversation
      // background — no top divider / contrasting "footer" block. We match the
      // chat screen background (theme.bg) and drop the border so the pill reads
      // as floating over the thread.
      paddingTop: 6,
      backgroundColor: theme.bg,
    },
    // "+" attach button — outside the pill, on the right, in a circle
    // (Signal-style). Sized to match the send button so the row never reflows
    // when toggling between attach and send.
    plusBtn: {
      width: 46,
      height: 46,
      borderRadius: 23,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.glassBorder,
    },
    // Camera / mic icons that live inside the pill on the right. Square-ish tap
    // targets sized to the pill's single-line height so the icons sit centered.
    innerIconBtn: {
      width: 42,
      height: 46,
      alignItems: "center",
      justifyContent: "center",
    },
    // Long rounded "pill" holding the inline emoji toggle + the text input +
    // the inline camera/mic, so every composer control lives inside the field
    // (Signal-style). Fully-rounded ends (radius = half the min height).
    pill: {
      flex: 1,
      flexDirection: "row",
      alignItems: "flex-end",
      minHeight: 46,
      backgroundColor: theme.inputBg,
      borderWidth: 1,
      borderColor: theme.inputBorder,
      borderRadius: 23,
      paddingHorizontal: 4,
      maxHeight: 124,
    },
    emojiToggle: {
      width: 42,
      height: 46,
      alignItems: "center",
      justifyContent: "center",
    },
    input: {
      flex: 1,
      maxHeight: 120,
      paddingHorizontal: 4,
      // Vertically center the text on a single line within the 46pt pill while
      // still growing cleanly for multiline.
      paddingVertical: 12,
      color: theme.text,
      fontSize: 16,
    },
    sendBtn: {
      width: 46,
      height: 46,
      borderRadius: 23,
      backgroundColor: theme.primary,
      alignItems: "center",
      justifyContent: "center",
    },
  });
