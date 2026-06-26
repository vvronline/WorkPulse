// Long-press message context menu (Signal / WhatsApp / Telegram model). On
// long-press this single overlay shows BOTH:
//   1. a reaction pill (quick emojis + "more reactions") anchored to the bubble,
//   2. a compact action menu (Reply, Forward, Copy, Save, Pin, Edit, Select,
//      Delete) anchored next to it,
// over a dim scrim. Tapping outside closes.
//
// WHY THIS EXISTS (UX fix): long-press used to ALSO enter multi-select mode, so
// the reaction pill and the header selection action bar fired together \u2014 two
// different mental models ("react to this" vs "select messages") collided and
// felt broken. Reactions and selection are now separated: long-press reacts /
// acts on ONE message, and multi-select is the explicit "Select" action here.
//
// Positioning is derived from the measured bubble rect (`anchor`): the pill
// prefers to sit above the bubble (flips below near the top) and the action
// menu sits below, both clamped to the safe area and aligned to the sender side.

import { useEffect, useMemo, useRef } from "react";
import {
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  CheckSquare,
  CornerUpLeft,
  Copy,
  Forward,
  Pencil,
  Pin,
  SmilePlus,
  Star,
  Trash2,
} from "lucide-react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import type { ChatMessage } from "../../features";
import { EMOJIS } from "./chatUtils";

export interface ReactionAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
  mine: boolean;
}

const PILL_HEIGHT = 46;
const PILL_GAP = 8;
const MENU_WIDTH = 232;
const MENU_ROW_H = 48;

export default function ReactionOverlay({
  visible,
  anchor,
  message,
  isOwn,
  isStarred,
  isPinned,
  userId,
  onReact,
  onOpenAllEmoji,
  onReply,
  onForward,
  onCopy,
  onSave,
  onPin,
  onEdit,
  onSelect,
  onDelete,
  onClose,
}: {
  visible: boolean;
  anchor: ReactionAnchor | null;
  message: ChatMessage | null;
  isOwn: boolean;
  isStarred: boolean;
  isPinned: boolean;
  userId?: number;
  onReact: (emoji: string) => void;
  onOpenAllEmoji: () => void;
  onReply: () => void;
  onForward: () => void;
  onCopy: () => void;
  onSave: () => void;
  onPin: () => void;
  onEdit: () => void;
  onSelect: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const insets = useSafeAreaInsets();
  const { width: winW, height: winH } = useWindowDimensions();

  // Entrance animation (fade + slight scale-in for both pill and menu).
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

  // Web's "canEdit": only own text messages (no attachment, not a poll, not
  // deleted) can be edited.
  const canEdit =
    isOwn &&
    !message?.file_url &&
    !message?.metadata?.pollId &&
    !message?.deleted_at;
  const canCopy = !!String(message?.content || "").trim();

  if (!message) return null;

  // ── Layout maths ──────────────────────────────────────────────────────────
  const a: ReactionAnchor = anchor || {
    x: winW / 2 - 120,
    y: winH / 2 - 30,
    width: 240,
    height: 60,
    mine: isOwn,
  };

  const margin = 12;
  const bubbleW = Math.min(a.width, winW * 0.82);
  const bubbleLeft = a.mine
    ? Math.min(a.x, winW - bubbleW - margin)
    : Math.max(margin, a.x);

  // Reaction pill: six quick emojis + a "more reactions" smiley.
  const pillItems = EMOJIS.length + 1;
  const pillW = Math.min(winW - margin * 2, pillItems * 40 + 24);
  let pillLeft = a.mine ? bubbleLeft + bubbleW - pillW : bubbleLeft;
  pillLeft = Math.max(margin, Math.min(pillLeft, winW - pillW - margin));

  // Build the action list (icon + label + handler + optional danger flag).
  const actions: {
    key: string;
    label: string;
    icon: React.ReactNode;
    onPress: () => void;
    danger?: boolean;
  }[] = [
    {
      key: "reply",
      label: "Reply",
      icon: <CornerUpLeft size={18} color={theme.text} />,
      onPress: onReply,
    },
    {
      key: "forward",
      label: "Forward",
      icon: <Forward size={18} color={theme.text} />,
      onPress: onForward,
    },
  ];
  if (canCopy) {
    actions.push({
      key: "copy",
      label: "Copy",
      icon: <Copy size={18} color={theme.text} />,
      onPress: onCopy,
    });
  }
  actions.push({
    key: "save",
    label: isStarred ? "Unsave" : "Save",
    icon: <Star size={18} color={theme.text} />,
    onPress: onSave,
  });
  actions.push({
    key: "pin",
    label: isPinned ? "Unpin" : "Pin",
    icon: <Pin size={18} color={theme.text} />,
    onPress: onPin,
  });
  if (canEdit) {
    actions.push({
      key: "edit",
      label: "Edit",
      icon: <Pencil size={18} color={theme.text} />,
      onPress: onEdit,
    });
  }
  actions.push({
    key: "select",
    label: "Select",
    icon: <CheckSquare size={18} color={theme.text} />,
    onPress: onSelect,
  });
  // Delete is available for EVERY message (WhatsApp/Telegram/Signal): own
  // messages can be deleted for everyone, others can be deleted just for me.
  // The downstream handler presents the applicable options.
  actions.push({
    key: "delete",
    label: "Delete",
    icon: <Trash2 size={18} color={theme.danger} />,
    onPress: onDelete,
    danger: true,
  });

  // Action menu horizontal placement — aligned to the sender side, clamped.
  let menuLeft = a.mine ? bubbleLeft + bubbleW - MENU_WIDTH : bubbleLeft;
  menuLeft = Math.max(margin, Math.min(menuLeft, winW - MENU_WIDTH - margin));

  // Vertical placement. The reaction pill prefers to sit ABOVE the bubble with
  // the action menu BELOW it. When that doesn't fit (e.g. the bubble is near the
  // bottom of the screen), the pill and menu are stacked as a SINGLE group so
  // the pill can never be clamped on top of — and hidden behind — the menu
  // (the bug being fixed: long-pressing a bubble low in the thread put the
  // reaction bar behind the options panel).
  const topLimit = insets.top + margin;
  const bottomLimit = winH - insets.bottom - margin;
  const available = bottomLimit - topLimit;

  // Natural menu height, capped to the available space.
  let wantMenuH = Math.min(actions.length * MENU_ROW_H + 8, available);

  const pillFitsAbove = a.y - PILL_HEIGHT - PILL_GAP >= topLimit;
  const menuFitsBelow = a.y + a.height + PILL_GAP + wantMenuH <= bottomLimit;

  let pillTop: number;
  let menuTop: number;
  if (pillFitsAbove && menuFitsBelow) {
    // Preferred: pill hugs above the bubble, menu sits below it.
    pillTop = a.y - PILL_HEIGHT - PILL_GAP;
    menuTop = a.y + a.height + PILL_GAP;
  } else {
    // Fallback: stack pill directly on top of the menu as one group and fit the
    // whole group on-screen (prefer below the bubble, else above, else clamp).
    wantMenuH = Math.min(wantMenuH, available - PILL_HEIGHT - PILL_GAP);
    const groupH = PILL_HEIGHT + PILL_GAP + wantMenuH;
    let groupTop = a.y + a.height + PILL_GAP;
    if (groupTop + groupH > bottomLimit) groupTop = a.y - PILL_GAP - groupH;
    groupTop = Math.max(topLimit, Math.min(groupTop, bottomLimit - groupH));
    pillTop = groupTop;
    menuTop = groupTop + PILL_HEIGHT + PILL_GAP;
  }

  const myReaction = (message.reactions || []).find(
    (r) => r.userId === userId,
  )?.emoji;

  const scale = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [0.92, 1],
  });

  const close = () => onClose();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={close}
    >
      {/* Dim scrim so the menu reads clearly above the conversation. Tapping
          anywhere outside the pill/menu closes the overlay. */}
      <Pressable style={styles.scrim} onPress={close}>
        {/* Reaction pill */}
        <Animated.View
          style={[
            styles.pill,
            {
              top: pillTop,
              left: pillLeft,
              width: pillW,
              opacity: progress,
              transform: [{ scale }],
            },
          ]}
        >
          <ScrollView
            horizontal
            bounces={false}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.toolbarRow}
          >
            {EMOJIS.map((e) => {
              const active = myReaction === e;
              return (
                <Pressable
                  key={e}
                  style={[
                    styles.pillEmojiBtn,
                    active && styles.pillEmojiActive,
                  ]}
                  onPress={() => onReact(e)}
                >
                  <Text style={styles.pillEmoji}>{e}</Text>
                </Pressable>
              );
            })}
            <Pressable style={styles.toolbarBtn} onPress={onOpenAllEmoji}>
              <SmilePlus size={20} color={theme.textSecondary} />
            </Pressable>
          </ScrollView>
        </Animated.View>

        {/* Action menu */}
        <Animated.View
          style={[
            styles.menu,
            {
              top: menuTop,
              left: menuLeft,
              width: MENU_WIDTH,
              maxHeight: wantMenuH,
              opacity: progress,
              transform: [{ scale }],
            },
          ]}
        >
          <ScrollView bounces={false} showsVerticalScrollIndicator={false}>
            {actions.map((act, i) => (
              <Pressable
                key={act.key}
                style={[
                  styles.menuRow,
                  i < actions.length - 1 && styles.menuRowDivider,
                ]}
                onPress={act.onPress}
                android_ripple={{ color: theme.surfaceHover }}
              >
                {act.icon}
                <Text
                  style={[
                    styles.menuLabel,
                    act.danger && styles.menuLabelDanger,
                  ]}
                >
                  {act.label}
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
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.45)",
    },
    pill: {
      position: "absolute",
      backgroundColor: theme.bgElevated,
      borderRadius: theme.radiusFull,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      paddingHorizontal: 6,
      height: PILL_HEIGHT,
      justifyContent: "center",
      shadowColor: "#000",
      shadowOpacity: 0.35,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 6 },
      elevation: 12,
    },
    toolbarRow: {
      flexDirection: "row",
      alignItems: "center",
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
    toolbarBtn: {
      width: 38,
      height: 38,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 19,
    },
    menu: {
      position: "absolute",
      backgroundColor: theme.bgElevated,
      borderRadius: theme.radius,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      overflow: "hidden",
      shadowColor: "#000",
      shadowOpacity: 0.35,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 6 },
      elevation: 12,
    },
    menuRow: {
      height: MENU_ROW_H,
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      paddingHorizontal: 18,
    },
    menuRowDivider: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.glassBorder,
    },
    menuLabel: {
      fontSize: 15,
      color: theme.text,
      fontWeight: "500",
    },
    menuLabelDanger: {
      color: theme.danger,
    },
  });
