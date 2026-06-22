// Signal-style long-press reaction + context overlay (mirrors Signal-Android's
// ConversationReactionOverlay). On long-press the whole screen dims, the
// pressed bubble "lifts" out (a clone is rendered at its measured window rect
// and scales in), a rounded reaction pill floats just above it (quick emoji +
// "+"), and a vertical context-action menu appears below it.
//
// Positioning is derived from the measured bubble rect (`anchor`) passed by the
// parent. The pill prefers to sit above the bubble and flips below when near
// the top; the action menu sits on the opposite side. Everything is clamped to
// the safe area.
//
// See docs/CHAT_DESIGN_SPEC.md §4.

import { useEffect, useMemo, useRef } from "react";
import {
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Copy,
  CornerUpLeft,
  Forward,
  Pencil,
  Pin,
  Plus,
  Star,
  Trash2,
} from "lucide-react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import type { ChatMessage } from "../../features";
import { EMOJIS } from "./chatUtils";
import { fmtTime } from "./chatUtils";

export interface ReactionAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
  mine: boolean;
}

const PILL_HEIGHT = 46;
const PILL_GAP = 8;
const MENU_GAP = 8;
const MENU_ROW_H = 46;

export default function ReactionOverlay({
  visible,
  anchor,
  message,
  isOwn,
  isStarred,
  userId,
  onReact,
  onOpenAllEmoji,
  onReply,
  onForward,
  onCopy,
  onStar,
  onPin,
  onEdit,
  onDelete,
  onClose,
}: {
  visible: boolean;
  anchor: ReactionAnchor | null;
  message: ChatMessage | null;
  isOwn: boolean;
  isStarred: boolean;
  userId?: number;
  onReact: (emoji: string) => void;
  onOpenAllEmoji: () => void;
  onReply: () => void;
  onForward: () => void;
  onCopy: () => void;
  onStar: () => void;
  onPin: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const insets = useSafeAreaInsets();
  const { width: winW, height: winH } = useWindowDimensions();

  // Entrance animation (scrim fade + content scale/fade).
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (visible) {
      progress.setValue(0);
      Animated.timing(progress, {
        toValue: 1,
        duration: 160,
        useNativeDriver: true,
      }).start();
    }
  }, [visible, progress]);

  // The action rows available for this message.
  const actions = useMemo(() => {
    const rows: {
      key: string;
      label: string;
      icon: React.ReactNode;
      onPress: () => void;
      danger?: boolean;
    }[] = [];
    rows.push({
      key: "reply",
      label: "Reply",
      icon: <CornerUpLeft size={18} color={theme.text} />,
      onPress: onReply,
    });
    rows.push({
      key: "forward",
      label: "Forward",
      icon: <Forward size={18} color={theme.text} />,
      onPress: onForward,
    });
    if (message?.content && !message?.deleted_at) {
      rows.push({
        key: "copy",
        label: "Copy",
        icon: <Copy size={18} color={theme.text} />,
        onPress: onCopy,
      });
    }
    rows.push({
      key: "star",
      label: isStarred ? "Unsave" : "Save",
      icon: <Star size={18} color={theme.text} />,
      onPress: onStar,
    });
    rows.push({
      key: "pin",
      label: message?.pinned_at ? "Unpin" : "Pin",
      icon: <Pin size={18} color={theme.text} />,
      onPress: onPin,
    });
    if (isOwn) {
      rows.push({
        key: "edit",
        label: "Edit",
        icon: <Pencil size={18} color={theme.text} />,
        onPress: onEdit,
      });
      rows.push({
        key: "delete",
        label: "Delete",
        icon: <Trash2 size={18} color={theme.danger} />,
        onPress: onDelete,
        danger: true,
      });
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message, isOwn, isStarred, theme]);

  if (!message) return null;

  // ── Layout maths ──────────────────────────────────────────────────────────
  // Fall back to a centered layout if we somehow have no anchor.
  const a: ReactionAnchor = anchor || {
    x: winW / 2 - 120,
    y: winH / 2 - 30,
    width: 240,
    height: 60,
    mine: isOwn,
  };

  const margin = 10;
  // Clamp the lifted-bubble clone width so very wide measured rects stay sane.
  const bubbleW = Math.min(a.width, winW * 0.82);
  const bubbleLeft = a.mine
    ? Math.min(a.x, winW - bubbleW - margin)
    : Math.max(margin, a.x);

  // Keep the bubble roughly where it was, but ensure there's room for the pill
  // above and the menu below. If the bubble sits too high, nudge it down.
  const menuH = actions.length * MENU_ROW_H + 12;
  const neededTop = insets.top + margin + PILL_HEIGHT + PILL_GAP;
  const neededBottom = winH - insets.bottom - margin - menuH - MENU_GAP;

  let bubbleTop = a.y;
  const bubbleH = a.height;
  if (bubbleTop < neededTop) bubbleTop = neededTop;
  if (bubbleTop + bubbleH > neededBottom) {
    bubbleTop = Math.max(neededTop, neededBottom - bubbleH);
  }

  // Reaction pill sits above the bubble, aligned to the sender side.
  const pillTop = bubbleTop - PILL_HEIGHT - PILL_GAP;
  // Pill width ≈ 6 emoji (40) + "+" (40) + padding.
  const pillW = Math.min(winW - margin * 2, EMOJIS.length * 40 + 52);
  let pillLeft = a.mine ? bubbleLeft + bubbleW - pillW : bubbleLeft;
  pillLeft = Math.max(margin, Math.min(pillLeft, winW - pillW - margin));

  // Action menu sits below the bubble, aligned to the sender side.
  const menuTop = bubbleTop + bubbleH + MENU_GAP;
  const menuW = 220;
  let menuLeft = a.mine ? bubbleLeft + bubbleW - menuW : bubbleLeft;
  menuLeft = Math.max(margin, Math.min(menuLeft, winW - menuW - margin));

  // Which quick-emoji (if any) the user has already reacted with.
  const myReaction = (message.reactions || []).find(
    (r) => r.userId === userId
  )?.emoji;

  const scrimOpacity = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1],
  });
  const contentScale = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [0.92, 1],
  });

  const close = () => onClose();

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={close}>
      <Pressable style={StyleSheet.absoluteFill} onPress={close}>
        <Animated.View style={[styles.scrim, { opacity: scrimOpacity }]} />

        {/* Reaction pill */}
        <Animated.View
          style={[
            styles.pill,
            {
              top: pillTop,
              left: pillLeft,
              width: pillW,
              opacity: progress,
              transform: [{ scale: contentScale }],
            },
          ]}
        >
          {EMOJIS.map((e) => {
            const active = myReaction === e;
            return (
              <Pressable
                key={e}
                style={[styles.pillEmojiBtn, active && styles.pillEmojiActive]}
                onPress={() => onReact(e)}
              >
                <Text style={styles.pillEmoji}>{e}</Text>
              </Pressable>
            );
          })}
          <Pressable style={styles.pillPlusBtn} onPress={onOpenAllEmoji}>
            <Plus size={20} color={theme.textSecondary} />
          </Pressable>
        </Animated.View>

        {/* Lifted bubble clone */}
        <Animated.View
          style={[
            styles.bubbleClone,
            a.mine ? styles.bubbleMine : styles.bubbleTheirs,
            {
              top: bubbleTop,
              left: bubbleLeft,
              width: bubbleW,
              minHeight: bubbleH,
              opacity: progress,
              transform: [{ scale: contentScale }],
            },
          ]}
        >
          {!a.mine && message.sender_name ? (
            <Text style={styles.sender}>{message.sender_name}</Text>
          ) : null}
          <Text
            style={[styles.cloneText, a.mine && styles.cloneTextMine]}
            numberOfLines={12}
          >
            {message.deleted_at
              ? "This message was deleted"
              : message.content || (message.file_name ?? "Attachment")}
          </Text>
          <Text style={[styles.cloneTime, a.mine && styles.cloneTimeMine]}>
            {fmtTime(message.created_at)}
          </Text>
        </Animated.View>

        {/* Vertical context-action menu */}
        <Animated.View
          style={[
            styles.menu,
            {
              top: menuTop,
              left: menuLeft,
              width: menuW,
              opacity: progress,
              transform: [{ scale: contentScale }],
            },
          ]}
        >
          <ScrollView bounces={false} style={{ maxHeight: winH * 0.5 }}>
            {actions.map((row) => (
              <Pressable
                key={row.key}
                style={styles.menuRow}
                onPress={row.onPress}
              >
                {row.icon}
                <Text
                  style={[styles.menuText, row.danger && { color: theme.danger }]}
                >
                  {row.label}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    scrim: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: "rgba(0,0,0,0.65)",
    },
    pill: {
      position: "absolute",
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      backgroundColor: theme.bgElevated,
      borderRadius: theme.radiusFull,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      paddingHorizontal: 6,
      height: PILL_HEIGHT,
      shadowColor: "#000",
      shadowOpacity: 0.35,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 6 },
      elevation: 12,
    },
    pillEmojiBtn: {
      width: 38,
      height: 38,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 19,
    },
    pillEmojiActive: {
      backgroundColor: theme.primaryGlow,
    },
    pillEmoji: { fontSize: 24 },
    pillPlusBtn: {
      width: 38,
      height: 38,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 19,
      backgroundColor: theme.surface,
    },
    bubbleClone: {
      position: "absolute",
      borderRadius: 18,
      paddingHorizontal: 12,
      paddingVertical: 7,
      shadowColor: "#000",
      shadowOpacity: 0.3,
      shadowRadius: 16,
      shadowOffset: { width: 0, height: 6 },
      elevation: 10,
    },
    bubbleMine: { backgroundColor: theme.chatOutBg },
    bubbleTheirs: { backgroundColor: theme.chatInBg },
    sender: { fontSize: 11, fontWeight: "700", color: theme.primaryLight, marginBottom: 2 },
    cloneText: { fontSize: 15, color: theme.text, lineHeight: 20 },
    cloneTextMine: { color: "#fff" },
    cloneTime: {
      fontSize: 10,
      color: theme.textMuted,
      alignSelf: "flex-end",
      marginTop: 2,
    },
    cloneTimeMine: { color: theme.chatOutMeta },
    menu: {
      position: "absolute",
      backgroundColor: theme.bgElevated,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      paddingVertical: 4,
      shadowColor: "#000",
      shadowOpacity: 0.35,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 6 },
      elevation: 12,
      overflow: "hidden",
    },
    menuRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      paddingHorizontal: 16,
      height: MENU_ROW_H,
    },
    menuText: { fontSize: 15, color: theme.text, fontWeight: "500" },
  });