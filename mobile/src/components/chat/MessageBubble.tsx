import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  runOnJS,
} from "react-native-reanimated";
import { CornerUpLeft, Pin, Star } from "lucide-react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import type { ChatMessage } from "../../features";
import MsgTicks from "./MsgTicks";
import ReplyQuote from "./ReplyQuote";
import FilePreview from "./FilePreview";
import MessageContent from "./MessageContent";
import ReactionChips from "./ReactionChips";
import { fmtTime } from "./chatUtils";

// Horizontal drag distance (px) past which releasing triggers a reply, and the
// max the bubble is allowed to travel (Signal-style swipe-to-reply).
const SWIPE_TRIGGER = 56;
const SWIPE_MAX = 80;

/**
 * A single chat message row (Signal-Android style). Own messages render as a
 * solid brand-accent bubble with white text; incoming messages use a flat,
 * borderless dark surface. There are NO triangular tails — Signal conveys
 * message grouping purely through corner-radius variation: the corner on the
 * sender's side is tightened (4px) for messages that are connected to an
 * adjacent message in the same group, and fully rounded (18px) otherwise. The
 * time + delivery ticks sit inline on the bottom-right of the bubble.
 *
 * The bubble's host node is registered into the parent's ref map via
 * `registerRef` so the parent can `measureInWindow` it to anchor the
 * long-press reaction bar. IMPORTANT: the ref MUST point at the host node so
 * `measureInWindow` can be invoked ON it — see the parent's `openReactionBar`.
 */
export default function MessageBubble({
  message,
  mine,
  deleted,
  starred,
  pinned,
  participantCount,
  readReceipts,
  userId,
  firstInGroup = true,
  lastInGroup = true,
  registerRef,
  onLongPress,
  onReact,
  onAddReaction,
  onReply,
  onRetry,
  onCancelUpload,
  onRetryUpload,
}: {
  message: ChatMessage;
  mine: boolean;
  deleted: boolean;
  starred: boolean;
  pinned: boolean;
  participantCount: number;
  readReceipts: Record<number, string>;
  userId?: number;
  // Consecutive-message grouping (see docs/CHAT_DESIGN_SPEC.md §4). The sender
  // name shows on the first of a group; Signal tightens the sender-side corners
  // on the connected edges so a group reads as a single stacked column.
  firstInGroup?: boolean;
  lastInGroup?: boolean;
  registerRef: (id: number, node: View | null) => void;
  onLongPress: (message: ChatMessage, mine: boolean) => void;
  onReact: (message: ChatMessage, emoji: string) => void;
  onAddReaction: (message: ChatMessage, mine: boolean) => void;
  // Swipe-to-reply (Signal-style): triggered when the bubble is dragged toward
  // the center past the threshold and released.
  onReply?: (message: ChatMessage) => void;
  onRetry?: (message: ChatMessage) => void;
  onCancelUpload?: (message: ChatMessage) => void;
  onRetryUpload?: (message: ChatMessage) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  // Swipe-to-reply gesture. Own (right-aligned) bubbles swipe LEFT; incoming
  // (left-aligned) bubbles swipe RIGHT — both toward the screen center, like
  // Signal. A reply icon fades/slides in behind the bubble as it moves; passing
  // SWIPE_TRIGGER and releasing fires onReply.
  const translateX = useSharedValue(0);
  const iconProgress = useSharedValue(0);

  const fireReply = () => {
    if (deleted) return;
    onReply?.(message);
  };

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX(mine ? [-12, 9999] : [-9999, 12])
        .failOffsetY([-12, 12])
        .enabled(!deleted && !!onReply)
        .onUpdate((e) => {
          // Clamp to the allowed direction only.
          let tx = e.translationX;
          if (mine) tx = Math.min(0, Math.max(-SWIPE_MAX, tx));
          else tx = Math.max(0, Math.min(SWIPE_MAX, tx));
          translateX.value = tx;
          iconProgress.value = Math.min(1, Math.abs(tx) / SWIPE_TRIGGER);
        })
        .onEnd(() => {
          if (Math.abs(translateX.value) >= SWIPE_TRIGGER) {
            runOnJS(fireReply)();
          }
          translateX.value = withSpring(0, { damping: 18, stiffness: 220 });
          iconProgress.value = withTiming(0, { duration: 160 });
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mine, deleted, onReply, message],
  );

  const bubbleAnim = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));
  const iconAnim = useAnimatedStyle(() => ({
    opacity: iconProgress.value,
    transform: [{ scale: 0.6 + iconProgress.value * 0.4 }],
  }));

  // Media-only message (image/video attachment with no caption text, not a
  // view-once pill) renders edge-to-edge — no bubble padding/background, like
  // Signal.
  const ft = typeof message.file_type === "string" ? message.file_type : "";
  const isImageType = ft.startsWith("image/") || ft.startsWith("video/");
  const isViewOnce = !!message.metadata?.viewOnce;
  const isMediaOnly =
    !!message.file_url &&
    !deleted &&
    isImageType &&
    !isViewOnce &&
    !String(message.content || "").trim();

  // Signal corner-radius grouping. Base radius is 18; the sender-side corner is
  // tightened to 4 on edges that connect to an adjacent message in the group.
  // - mine (right-aligned): the RIGHT corners are the sender side.
  // - theirs (left-aligned): the LEFT corners are the sender side.
  const R = 18;
  const TIGHT = 4;
  const cornerStyle = mine
    ? {
        borderTopRightRadius: firstInGroup ? R : TIGHT,
        borderBottomRightRadius: lastInGroup ? R : TIGHT,
      }
    : {
        borderTopLeftRadius: firstInGroup ? R : TIGHT,
        borderBottomLeftRadius: lastInGroup ? R : TIGHT,
      };

  return (
    <View
      style={[
        styles.bubbleRow,
        mine ? styles.rowMine : styles.rowTheirs,
        // Tighter spacing between grouped messages, looser between groups.
        firstInGroup ? styles.rowGroupStart : styles.rowGrouped,
      ]}
    >
      {/* Reply affordance revealed behind the bubble while swiping. */}
      <Animated.View
        style={[
          styles.replyHint,
          mine ? styles.replyHintMine : styles.replyHintTheirs,
          iconAnim,
        ]}
        pointerEvents="none"
      >
        <View style={styles.replyHintCircle}>
          <CornerUpLeft size={16} color={theme.text} />
        </View>
      </Animated.View>
      <View style={styles.bubbleCol}>
        <GestureDetector gesture={panGesture}>
          <Animated.View style={bubbleAnim}>
        <Pressable
          ref={(node) => {
            registerRef(message.id, node as unknown as View | null);
          }}
          onLongPress={() => {
            if (deleted) return;
            onLongPress(message, mine);
          }}
          delayLongPress={250}
          style={[
            styles.bubble,
            mine ? styles.bubbleMine : styles.bubbleTheirs,
            isMediaOnly && styles.bubbleMediaOnly,
            cornerStyle,
            message._pending && styles.bubblePending,
          ]}
        >
          {!mine && firstInGroup && message.sender_name ? (
            <Text style={styles.sender}>{message.sender_name}</Text>
          ) : null}
          {message.reply_to_id && !deleted ? (
            <ReplyQuote message={message} />
          ) : null}
          {message.file_url && !deleted ? (
            <FilePreview
              message={message}
              onCancelUpload={onCancelUpload}
              onRetryUpload={onRetryUpload}
              // Long-pressing an image/file must open the reaction bar (Signal
              // parity). The inner image/file Pressable would otherwise swallow
              // the gesture, so forward the bubble's long-press into it.
              onLongPress={() => {
                if (deleted) return;
                onLongPress(message, mine);
              }}
            />
          ) : null}
          {/* Signal inline footer: the message text and the time+ticks live in
              a SINGLE wrapping row. When the last line of text plus the footer
              fit within the bubble width, the time/ticks sit on the SAME line as
              the text (Signal's compact look); when they don't fit, the footer
              wraps to the bottom-right of the next line. The left margin keeps
              the footer from visually colliding with the text.

              For MEDIA-ONLY messages (an image/video with no caption) there is
              no text row — the time + ticks are overlaid on the bottom-right of
              the image inside a translucent dark pill (web parity), so the read
              receipt is never cropped by the bubble's edge. */}
          {isMediaOnly ? (
            <View style={styles.mediaMeta} pointerEvents="box-none">
              {pinned ? <Pin size={10} color="#fff" /> : null}
              {starred ? <Star size={10} color="#fff" /> : null}
              {message.edited_at && !deleted ? (
                <Text style={styles.mediaMetaText}>edited</Text>
              ) : null}
              <Text style={styles.mediaMetaText}>
                {fmtTime(message.created_at)}
              </Text>
              <MsgTicks
                mine={mine}
                msg={message}
                participantCount={participantCount}
                readReceipts={readReceipts}
                userId={userId}
                onMedia
                onRetry={mine ? () => onRetry?.(message) : undefined}
              />
            </View>
          ) : (
            <View style={styles.contentRow}>
              <MessageContent message={message} mine={mine} />
              <View style={styles.metaLine}>
                {pinned ? (
                  <Pin size={10} color={mine ? theme.chatOutMeta : theme.textMuted} />
                ) : null}
                {starred ? (
                  <Star size={10} color={mine ? theme.chatOutMeta : theme.warning} />
                ) : null}
                {message.edited_at && !deleted ? (
                  <Text style={[styles.edited, mine && styles.editedMine]}>
                    edited
                  </Text>
                ) : null}
                <Text style={[styles.time, mine && styles.timeMine]}>
                  {fmtTime(message.created_at)}
                </Text>
                <MsgTicks
                  mine={mine}
                  msg={message}
                  participantCount={participantCount}
                  readReceipts={readReceipts}
                  userId={userId}
                  onRetry={mine ? () => onRetry?.(message) : undefined}
                />
              </View>
            </View>
          )}
        </Pressable>
          </Animated.View>
        </GestureDetector>

        {/* Reaction chips overlap the bottom edge of the bubble (Signal-style),
            rendered just below it and aligned toward the sender side. */}
        <ReactionChips
          message={message}
          mine={mine}
          userId={userId}
          onToggle={onReact}
          onAdd={onAddReaction}
        />
      </View>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    bubbleRow: { flexDirection: "row", alignItems: "center" },
    replyHint: {
      position: "absolute",
      top: 0,
      bottom: 0,
      justifyContent: "center",
    },
    replyHintMine: { right: 4 },
    replyHintTheirs: { left: 4 },
    replyHintCircle: {
      width: 30,
      height: 30,
      borderRadius: 15,
      backgroundColor: theme.surface,
      alignItems: "center",
      justifyContent: "center",
    },
    rowMine: { justifyContent: "flex-end" },
    rowTheirs: { justifyContent: "flex-start" },
    // 8px between distinct groups, 2px between messages within a group.
    rowGroupStart: { marginTop: 6 },
    rowGrouped: { marginTop: 2 },
    bubbleCol: { maxWidth: "82%" },
    bubble: {
      position: "relative",
      alignSelf: "stretch",
      borderRadius: 18,
      paddingHorizontal: 12,
      paddingVertical: 7,
      gap: 2,
    },
    // Own messages — clean neutral fill (no brand color), borderless.
    bubbleMine: {
      backgroundColor: theme.bgElevated,
    },
    // Incoming messages — flat neutral surface, borderless.
    bubbleTheirs: {
      backgroundColor: theme.surface,
    },
    // Media-only bubble: frameless, edge-to-edge image/video (Signal-style).
    bubbleMediaOnly: {
      backgroundColor: "transparent",
      paddingHorizontal: 0,
      paddingVertical: 0,
      overflow: "hidden",
    },
    bubblePending: { opacity: 0.7 },
    sender: {
      fontSize: 11,
      fontFamily: theme.fontSemiBold,
      color: theme.primaryLight,
    },
    // Signal inline footer: content + meta share one wrapping row so the
    // time/ticks tuck onto the last text line when there's room, else wrap to
    // the bottom-right.
    contentRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "flex-end",
    },
    metaLine: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      // Pushes the footer to the right of the text on the same line; once the
      // row wraps, `marginLeft:auto` keeps it bottom-right.
      marginLeft: "auto",
      // A little left padding so the time never butts up against the last word
      // when they share a line.
      paddingLeft: 8,
    },
    edited: {
      fontSize: 10,
      color: theme.textMuted,
      fontStyle: "italic",
      fontFamily: theme.fontRegular,
    },
    editedMine: { color: theme.chatOutMeta },
    time: { fontSize: 10, color: theme.textMuted, fontFamily: theme.fontRegular },
    timeMine: { color: theme.chatOutMeta },
    // Media-only footer overlaid on the image bottom-right inside a translucent
    // dark pill (web parity — .mediaOnly .meta). Absolutely positioned so the
    // read tick is never clipped by the bubble's overflow:hidden corners.
    mediaMeta: {
      position: "absolute",
      right: 8,
      bottom: 8,
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 10,
      backgroundColor: "rgba(0,0,0,0.45)",
    },
    mediaMetaText: {
      fontSize: 10,
      color: "#fff",
      fontFamily: theme.fontRegular,
    },
  });
