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

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Image,
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
  Copy,
  Forward,
  MoreHorizontal,
  Pencil,
  Pin,
  SmilePlus,
  Star,
  Trash2,
} from "lucide-react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import type { ChatMessage } from "../../features";
import { uploadUrl } from "../../config";
import { AuthedImage } from "../AuthedImage";
import { EMOJIS, isImageFile } from "./chatUtils";
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

  // The toolbar shows Edit INLINE and tucks the rest (Pin, Save, Forward, Copy,
  // Delete) behind a "more" (3-dots) button that opens a small context menu.
  // (Reply is handled by swipe-to-reply on the bubble, so it's not in the bar.)
  // `moreOpen` toggles that secondary menu.
  const [moreOpen, setMoreOpen] = useState(false);
  // Reset the secondary menu whenever the overlay re-opens.
  useEffect(() => {
    if (visible) setMoreOpen(false);
  }, [visible]);

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

  // Web's "canEdit": only own text messages (no attachment, not a poll) can be
  // edited — so the inline pencil shows under the same rule. (Mobile flags polls
  // via metadata.pollId rather than a format_type field.)
  const canEdit =
    isOwn &&
    !message?.file_url &&
    !message?.metadata?.pollId &&
    !message?.deleted_at;

  // Secondary "more" context menu (opened from the inline 3-dots). Edit lives
  // inline on the toolbar, so it's excluded here; this list carries the
  // remaining actions (Forward, Copy, Save, Pin, Delete) — mirroring the web
  // ContextMenu opened from the toolbar's "..." button.
  const actions = useMemo(() => {
    const rows: {
      key: string;
      label: string;
      icon: React.ReactNode;
      onPress: () => void;
      danger?: boolean;
    }[] = [];
    rows.push({
      key: "pin",
      label: message?.pinned_at ? "Unpin" : "Pin",
      icon: <Pin size={18} color={theme.text} />,
      onPress: onPin,
    });
    rows.push({
      key: "star",
      label: isStarred ? "Unsave" : "Save",
      icon: <Star size={18} color={theme.text} />,
      onPress: onStar,
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
    if (isOwn) {
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

  // Secondary "more" context menu (vertical list) — only shown when the 3-dots
  // is tapped. Its height is the row count plus the container's padding.
  const menuH = actions.length * MENU_ROW_H + 10;
  const neededTop = insets.top + margin + PILL_HEIGHT + PILL_GAP;
  const neededBottom = winH - insets.bottom - margin - MENU_GAP;

  let bubbleTop = a.y;
  const bubbleH = a.height;
  if (bubbleTop < neededTop) bubbleTop = neededTop;
  if (bubbleTop + bubbleH > neededBottom) {
    bubbleTop = Math.max(neededTop, neededBottom - bubbleH);
  }

  // Inline web-style toolbar sits above the bubble, aligned to the sender side.
  // It carries: 6 quick emojis + a "more reactions" smiley, a divider, then
  // edit (own text only) and a 3-dots "more". The toolbar can be wider than the
  // screen, so it scrolls horizontally and we clamp its box to the viewport
  // width. (Reply is via swipe-to-reply on the bubble, not the toolbar.)
  const pillTop = bubbleTop - PILL_HEIGHT - PILL_GAP;
  const toolbarItems =
    EMOJIS.length + 1 /* more-reactions */ + (canEdit ? 1 : 0) + 1; /* more */
  const pillW = Math.min(winW - margin * 2, toolbarItems * 40 + 24);
  let pillLeft = a.mine ? bubbleLeft + bubbleW - pillW : bubbleLeft;
  pillLeft = Math.max(margin, Math.min(pillLeft, winW - pillW - margin));

  // Secondary "more" menu sits below the bubble, aligned to the sender side.
  // Sized snug to its short labels (Pin/Save/Forward/Copy/Delete) so there's no
  // dead horizontal space (Signal sizes the context menu to its content).
  const menuTop = bubbleTop + bubbleH + MENU_GAP;
  const menuW = 184;
  let menuLeft = a.mine ? bubbleLeft + bubbleW - menuW : bubbleLeft;
  menuLeft = Math.max(margin, Math.min(menuLeft, winW - menuW - margin));

  // Which quick-emoji (if any) the user has already reacted with.
  const myReaction = (message.reactions || []).find(
    (r) => r.userId === userId
  )?.emoji;

  // Lifted-clone media handling. For image attachments the clone must show the
  // actual photo (Signal parity) instead of the file name on a gray box — that
  // was the bug where long-pressing an image hid it behind its name. A
  // media-only image (no caption, not view-once) lifts edge-to-edge with a
  // transparent container; an image WITH a caption keeps the bubble fill and
  // stacks the caption under the photo.
  const isViewOnce = !!message.metadata?.viewOnce;
  const cloneIsImage =
    !message.deleted_at && isImageFile(message) && !!message.file_url && !isViewOnce;
  const cloneCaption = String(message.content || "").trim();
  const cloneMediaOnly = cloneIsImage && !cloneCaption;
  const cloneImageUri = cloneIsImage
    ? uploadUrl(message.file_url) || undefined
    : undefined;
  const cloneImageIsLocal =
    !!cloneImageUri && /^(file|content|data):/i.test(cloneImageUri);

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

        {/* Inline web-style toolbar (mirrors the web MessageToolbar): six quick
            emojis + a "more reactions" smiley, a divider, then edit (own text
            only) and a 3-dots "more". Reply is via swipe-to-reply on the bubble.
            Scrolls horizontally if it can't fit so nothing is clipped. */}
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

            <View style={styles.toolbarDivider} />

            {/* Edit — own text messages only (web canEdit). */}
            {canEdit ? (
              <Pressable style={styles.toolbarBtn} onPress={onEdit}>
                <Pencil size={18} color={theme.textSecondary} />
              </Pressable>
            ) : null}
            {/* More — toggles the secondary context menu below the bubble. */}
            <Pressable
              style={[styles.toolbarBtn, moreOpen && styles.toolbarBtnActive]}
              onPress={() => setMoreOpen((v) => !v)}
            >
              <MoreHorizontal size={19} color={theme.textSecondary} />
            </Pressable>
          </ScrollView>
        </Animated.View>

        {/* Lifted bubble clone — rendered at the EXACT measured rect (no scale)
            so the bubble keeps its original size when lifted (Signal lifts the
            bubble 1:1; scaling it made the bubble appear to grow).

            For an image attachment we render the ACTUAL photo (Signal parity) so
            the preview stays visible while the reaction toolbar is open —
            previously the clone only rendered the file NAME on a gray box, which
            hid the image. Media-only images lift edge-to-edge on a transparent
            container; images with a caption keep the bubble fill and stack the
            caption under the photo. */}
        <Animated.View
          style={[
            styles.bubbleClone,
            cloneMediaOnly
              ? styles.bubbleCloneMedia
              : a.mine
                ? styles.bubbleMine
                : styles.bubbleTheirs,
            {
              top: bubbleTop,
              left: bubbleLeft,
              width: bubbleW,
              height: bubbleH,
              opacity: progress,
            },
          ]}
        >
          {cloneIsImage && cloneImageUri ? (
            <>
              {cloneImageIsLocal ? (
                <Image
                  source={{ uri: cloneImageUri }}
                  style={[
                    styles.cloneImage,
                    {
                      width: cloneMediaOnly ? bubbleW : "100%",
                      height: cloneMediaOnly
                        ? bubbleH
                        : Math.max(0, bubbleH - 28),
                    },
                  ]}
                  resizeMode="cover"
                />
              ) : (
                <AuthedImage
                  uri={cloneImageUri}
                  style={[
                    styles.cloneImage,
                    {
                      width: cloneMediaOnly ? bubbleW : "100%",
                      height: cloneMediaOnly
                        ? bubbleH
                        : Math.max(0, bubbleH - 28),
                    },
                  ]}
                  resizeMode="cover"
                />
              )}
              {!cloneMediaOnly ? (
                <Text
                  style={[styles.cloneText, a.mine && styles.cloneTextMine]}
                  numberOfLines={3}
                >
                  {cloneCaption}
                </Text>
              ) : null}
            </>
          ) : (
            <>
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
            </>
          )}
        </Animated.View>

        {/* Secondary context menu (vertical list) — only when the 3-dots "more"
            is tapped. Mirrors the web ContextMenu opened from the toolbar's
            "..." button. */}
        {moreOpen ? (
          <Animated.View
            style={[
              styles.actionWrap,
              {
                top: menuTop,
                left: menuLeft,
                width: menuW,
                opacity: progress,
                transform: [{ scale: contentScale }],
              },
            ]}
          >
            <ScrollView
              bounces={false}
              style={[styles.menu, { maxHeight: winH * 0.5 }]}
            >
              {actions.map((row) => (
                <Pressable
                  key={row.key}
                  style={styles.menuRow}
                  onPress={row.onPress}
                >
                  {row.icon}
                  <Text
                    style={[
                      styles.menuText,
                      row.danger && { color: theme.danger },
                    ]}
                  >
                    {row.label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </Animated.View>
        ) : null}
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
    // Inline action button (more-reactions / edit / more) — matches the web
    // MessageToolbar's .toolbarBtn sizing.
    toolbarBtn: {
      width: 38,
      height: 38,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 19,
    },
    toolbarBtnActive: {
      backgroundColor: theme.surface,
    },
    // Vertical divider between the reaction emojis and the action icons
    // (web .toolbarDivider).
    toolbarDivider: {
      width: 1,
      height: 22,
      marginHorizontal: 4,
      backgroundColor: theme.glassBorder,
    },
    bubbleClone: {
      position: "absolute",
      borderRadius: 18,
      // Match the real bubble's Signal-Android padding (12dp × 8dp).
      paddingHorizontal: 12,
      paddingVertical: 8,
      shadowColor: "#000",
      shadowOpacity: 0.3,
      shadowRadius: 16,
      shadowOffset: { width: 0, height: 6 },
      elevation: 10,
    },
    bubbleMine: { backgroundColor: theme.chatOutBg },
    bubbleTheirs: { backgroundColor: theme.chatInBg },
    // Media-only image clone: no bubble fill/padding so the photo lifts
    // edge-to-edge (Signal-style) and the gray bubble no longer covers it.
    bubbleCloneMedia: {
      backgroundColor: "transparent",
      paddingHorizontal: 0,
      paddingVertical: 0,
      overflow: "hidden",
    },
    cloneImage: {
      borderRadius: 14,
      backgroundColor: theme.surface,
    },
    // Match the real bubble's Signal-Android sizing 1:1 so the lifted clone is
    // pixel-identical (sender 13sp, body 16sp/22, footer 11sp).
    sender: { fontSize: 13, fontWeight: "700", color: theme.primaryLight, marginBottom: 2 },
    cloneText: { fontSize: 16, color: theme.text, lineHeight: 22 },
    cloneTextMine: { color: "#fff" },
    cloneTime: {
      fontSize: 11,
      color: theme.textMuted,
      alignSelf: "flex-end",
      marginTop: 2,
    },
    cloneTimeMine: { color: theme.chatOutMeta },
    actionWrap: {
      position: "absolute",
    },
    menu: {
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
