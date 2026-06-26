// Signal-style long-press reaction pill. On long-press the parent enters
// selection mode (the header swaps to a selection action bar with pin / save /
// forward / copy / delete) and this lightweight overlay floats a rounded
// reaction pill just above the pressed bubble (quick emoji + "more reactions" +
// inline Edit for own text).
//
// IMPORTANT (bug history): this overlay used to ALSO render a dimming scrim +
// a "lifted clone" of the pressed bubble + a secondary 3-dot context menu.
// Those caused two visible glitches:
//   1. the clone used different bubble colors than the real bubble, so the
//      lifted copy looked accent-tinted, and
//   2. the dim scrim left the REAL bubble faintly visible underneath, so the
//      message appeared duplicated.
// Both are gone now — actions live in the chat header selection bar instead,
// and there is no clone, so the real bubble simply stays in place.
//
// Positioning is derived from the measured bubble rect (`anchor`) passed by the
// parent: the pill prefers to sit above the bubble and flips below when near
// the top, clamped to the safe area.

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
import { Pencil, SmilePlus } from "lucide-react-native";
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

export default function ReactionOverlay({
  visible,
  anchor,
  message,
  isOwn,
  userId,
  onReact,
  onOpenAllEmoji,
  onEdit,
  onClose,
}: {
  visible: boolean;
  anchor: ReactionAnchor | null;
  message: ChatMessage | null;
  isOwn: boolean;
  userId?: number;
  onReact: (emoji: string) => void;
  onOpenAllEmoji: () => void;
  onEdit: () => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const insets = useSafeAreaInsets();
  const { width: winW, height: winH } = useWindowDimensions();

  // Entrance animation (pill fade + slight scale-in).
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
  // deleted) can be edited — so the inline pencil shows under the same rule.
  const canEdit =
    isOwn &&
    !message?.file_url &&
    !message?.metadata?.pollId &&
    !message?.deleted_at;

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
  const bubbleW = Math.min(a.width, winW * 0.82);
  const bubbleLeft = a.mine
    ? Math.min(a.x, winW - bubbleW - margin)
    : Math.max(margin, a.x);

  // Toolbar: six quick emojis + a "more reactions" smiley, a divider, then edit
  // (own text only). Scrolls horizontally if it can't fit so nothing is clipped.
  const toolbarItems = EMOJIS.length + 1 /* more-reactions */ + (canEdit ? 1 : 0);
  const pillW = Math.min(winW - margin * 2, toolbarItems * 40 + 24);
  let pillLeft = a.mine ? bubbleLeft + bubbleW - pillW : bubbleLeft;
  pillLeft = Math.max(margin, Math.min(pillLeft, winW - pillW - margin));

  // Prefer the pill above the bubble; flip below when too close to the top.
  let pillTop = a.y - PILL_HEIGHT - PILL_GAP;
  if (pillTop < insets.top + margin) {
    pillTop = a.y + a.height + PILL_GAP;
  }
  pillTop = Math.max(
    insets.top + margin,
    Math.min(pillTop, winH - insets.bottom - PILL_HEIGHT - margin),
  );

  // Which quick-emoji (if any) the user has already reacted with.
  const myReaction = (message.reactions || []).find(
    (r) => r.userId === userId
  )?.emoji;

  const contentScale = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [0.92, 1],
  });

  const close = () => onClose();

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={close}>
      {/* Transparent backdrop — NO dim scrim and NO lifted clone, so the real
          bubble stays in place (no duplicate, no color shift). Tapping anywhere
          outside the pill closes the overlay. */}
      <Pressable style={StyleSheet.absoluteFill} onPress={close}>
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
                  style={[styles.pillEmojiBtn, active && styles.pillEmojiActive]}
                  onPress={() => onReact(e)}
                >
                  <Text style={styles.pillEmoji}>{e}</Text>
                </Pressable>
              );
            })}
            {/* More reactions — opens the full emoji grid. */}
            <Pressable style={styles.toolbarBtn} onPress={onOpenAllEmoji}>
              <SmilePlus size={20} color={theme.textSecondary} />
            </Pressable>

            {/* Edit — own text messages only (web canEdit). */}
            {canEdit ? (
              <>
                <View style={styles.toolbarDivider} />
                <Pressable style={styles.toolbarBtn} onPress={onEdit}>
                  <Pencil size={18} color={theme.textSecondary} />
                </Pressable>
              </>
            ) : null}
          </ScrollView>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
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
    // Horizontal toolbar row inside the (scrollable) pill.
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
    // Inline action button (more-reactions / edit).
    toolbarBtn: {
      width: 38,
      height: 38,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 19,
    },
    // Vertical divider between the reaction emojis and the action icons.
    toolbarDivider: {
      width: 1,
      height: 22,
      marginHorizontal: 4,
      backgroundColor: theme.glassBorder,
    },
  });