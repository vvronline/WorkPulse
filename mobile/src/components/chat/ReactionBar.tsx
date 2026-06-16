import { useMemo } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { CornerUpLeft, MoreHorizontal, Smile } from "lucide-react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import { EMOJIS } from "./chatUtils";

/**
 * Long-press reaction bar (mirrors the web MessageToolbar / ReactionPicker):
 * a single horizontal pill → quick emojis · smiley(all emoji) · divider ·
 * reply · ⋯(more).
 *
 * animationType is "none" (not "fade"): on Android a fading modal is a
 * separate native window whose fade-out masks the optimistic reaction chip
 * applied to the list behind it — making the reaction look delayed vs. the
 * web. Closing instantly reveals the already-applied chip immediately.
 *
 * Positioning lives in the parent (it depends on the long-pressed bubble's
 * measured rect); the parent passes the computed `positionStyle` and an
 * `onLayout` to feed back the measured bar size.
 */
export default function ReactionBar({
  visible,
  positionStyle,
  onLayout,
  onReact,
  onOpenAllEmoji,
  onReply,
  onMore,
  onClose,
}: {
  visible: boolean;
  positionStyle: StyleProp<ViewStyle>;
  onLayout: (e: LayoutChangeEvent) => void;
  onReact: (emoji: string) => void;
  onOpenAllEmoji: () => void;
  onReply: () => void;
  onMore: () => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
    >
      <Pressable style={styles.pickerOverlay} onPress={onClose}>
        <Pressable
          style={[styles.pickerBar, positionStyle]}
          onPress={() => {}}
          onLayout={onLayout}
        >
          {EMOJIS.map((e) => (
            <Pressable
              key={e}
              style={styles.emojiBtn}
              onPress={() => onReact(e)}
            >
              <Text style={styles.emojiText}>{e}</Text>
            </Pressable>
          ))}
          <Pressable style={styles.barIconBtn} onPress={onOpenAllEmoji}>
            <Smile size={18} color={theme.textSecondary} />
          </Pressable>
          <View style={styles.barDivider} />
          <Pressable style={styles.barIconBtn} onPress={onReply}>
            <CornerUpLeft size={17} color={theme.textSecondary} />
          </Pressable>
          <Pressable style={styles.barIconBtn} onPress={onMore}>
            <MoreHorizontal size={17} color={theme.textSecondary} />
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    pickerOverlay: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.5)",
      alignItems: "center",
      justifyContent: "center",
    },
    // Single horizontal reaction bar matching the web screenshot: rounded
    // pill, quick emojis, then a smiley (all-emoji), divider, reply, ⋯ (more).
    pickerBar: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: theme.bgSecondary,
      borderRadius: theme.radiusFull,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      paddingHorizontal: 4,
      paddingVertical: 3,
      maxWidth: "96%",
      shadowColor: "#000",
      shadowOpacity: 0.3,
      shadowRadius: 24,
      shadowOffset: { width: 0, height: 8 },
      elevation: 10,
    },
    emojiBtn: {
      width: 32,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 16,
    },
    emojiText: { fontSize: 20 },
    barIconBtn: {
      width: 30,
      height: 30,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 15,
    },
    barDivider: {
      width: 1,
      height: 20,
      backgroundColor: theme.glassBorder,
      marginHorizontal: 2,
    },
  });