import { memo, useEffect, useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  withSequence,
  runOnJS,
  interpolateColor,
} from "react-native-reanimated";
import { Check, CornerUpLeft, Pin, Star } from "../../icons";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import type { ChatMessage } from "../../features";
import MsgTicks from "./MsgTicks";
import ReplyQuote from "./ReplyQuote";
import FilePreview from "./FilePreview";
import MessageContent from "./MessageContent";
import ReactionChips from "./ReactionChips";
import { fmtTime, isEmojiOnlyMessage } from "./chatUtils";

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
type MessageBubbleProps = {
  message: ChatMessage;
  mine: boolean;
  deleted: boolean;
  starred: boolean;
  pinned: boolean;
  participantCount: number;
  readReceiptTimes: readonly (readonly [number, number])[];
  userId?: number;
  // Consecutive-message grouping (see docs/CHAT_DESIGN_SPEC.md §4). The sender
  // name shows on the first of a group; Signal tightens the sender-side corners
  // on the connected edges so a group reads as a single stacked column.
  firstInGroup?: boolean;
  lastInGroup?: boolean;
  // Signal in-conversation search: when this bubble is the active search match
  // the row briefly flashes a highlight tint so the user can spot it after the
  // list scrolls to it.
  highlighted?: boolean;
  // Signal-style multi-select: `selected` marks this row as part of the current
  // selection (persistent tint + check), `selectionActive` means selection mode
  // is on (so a plain tap toggles selection instead of doing nothing).
  selected?: boolean;
  selectionActive?: boolean;
  registerRef: (id: number, node: View | null) => void;
  onLongPress: (message: ChatMessage, mine: boolean) => void;
  // Tap handler used while in selection mode to toggle this row in/out.
  onPressSelect?: (message: ChatMessage) => void;
  onReact: (message: ChatMessage, emoji: string) => void;
  onAddReaction: (message: ChatMessage, mine: boolean) => void;
  // Swipe-to-reply (Signal-style): triggered when the bubble is dragged toward
  // the center past the threshold and released.
  onReply?: (message: ChatMessage) => void;
  onRetry?: (message: ChatMessage) => void;
  onCancelUpload?: (message: ChatMessage) => void;
  onRetryUpload?: (message: ChatMessage) => void;
  // Signal-style: tapping the in-bubble quoted reply scrolls to + flashes the
  // original message it is replying to.
  onJumpToReply?: (message: ChatMessage) => void;
  // Whether this bubble may play its FadeIn enter / LinearTransition layout
  // animation. The list keeps this FALSE for the initial batch so opening a
  // conversation slides in as a complete, static screen (no per-row fade
  // flicker competing with the navigation transition); it flips TRUE after the
  // open settles so genuinely new incoming/sent messages still fade into place
  // (Signal-Android behaviour).
  animateEntry?: boolean;
};

function MessageBubbleImpl({
  message,
  mine,
  deleted,
  starred,
  pinned,
  participantCount,
  readReceiptTimes,
  userId,
  firstInGroup = true,
  lastInGroup = true,
  highlighted = false,
  selected = false,
  selectionActive = false,
  registerRef,
  onLongPress,
  onPressSelect,
  onReact,
  onAddReaction,
  onReply,
  onRetry,
  onCancelUpload,
  onRetryUpload,
  onJumpToReply,
  animateEntry = true,
}: MessageBubbleProps) {
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

  // Signal-style press feedback: while the finger is down the bubble eases to a
  // slightly smaller scale, then springs back on release. Combined with the
  // reaction overlay's scale-in this reads as one continuous "lift" gesture.
  const pressScale = useSharedValue(1);
  const onPressIn = () => {
    pressScale.value = withTiming(0.97, { duration: 140 });
  };
  const onPressOut = () => {
    pressScale.value = withSpring(1, { damping: 14, stiffness: 260 });
  };

  const bubbleAnim = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }, { scale: pressScale.value }],
  }));
  const iconAnim = useAnimatedStyle(() => ({
    opacity: iconProgress.value,
    transform: [{ scale: 0.6 + iconProgress.value * 0.4 }],
  }));

  // Signal search-match highlight: a brief background tint flash that fades back
  // out so the matched message is easy to spot after the list scrolls to it.
  const highlight = useSharedValue(0);
  useEffect(() => {
    if (highlighted) {
      highlight.value = withSequence(
        withTiming(1, { duration: 220 }),
        withTiming(0, { duration: 900 }),
      );
    }
  }, [highlighted, highlight]);
  const highlightAnim = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      highlight.value,
      [0, 1],
      ["transparent", "rgba(35,131,226,0.22)"],
    ),
  }));

  // Persistent selection tint (Signal-style): selected rows keep a soft accent
  // wash across the full row so multi-selection is clearly visible.
  const selectionRowStyle = selected
    ? { backgroundColor: "rgba(35,131,226,0.16)" }
    : null;

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
  const isEmojiOnly =
    !deleted &&
    !message.file_url &&
    isEmojiOnlyMessage(message.content);

  // While a media attachment is still uploading (or failed mid-upload) the
  // FilePreview shows a single progress/retry overlay on the card. Suppress the
  // delivery-status ticks (and their "sending" spinner) in that window so the
  // bubble shows exactly ONE indicator, matching WhatsApp/Signal.
  const mediaUploadInProgress =
    !!message.file_url &&
    !deleted &&
    (message._pending ||
      message._failed ||
      message._mediaState === "queued" ||
      message._mediaState === "uploading" ||
      message._mediaState === "failed");

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
    <Animated.View
      // PERF ROOT-CAUSE FIX (the compounding "gradually lags very much then
      // freezes" bug): this row used to carry Reanimated LAYOUT animations —
      // first `layout={LinearTransition.springify()}`, then `entering={FadeIn}`.
      // Reanimated layout animations (`entering`/`exiting`/`layout`) are UNSAFE
      // on virtualized FlatList rows under the New Architecture (Fabric): the
      // LIST controls when a row is mounted/recycled, so the animation manager
      // races the Fabric surface teardown. When a row is recycled or the thread
      // unmounts, Reanimated keeps trying to update a view whose surface is gone
      // → `Unable to find SurfaceMountingManager for tag`, retried every frame
      // forever (confirmed on-device: 20M+ `synchronouslyUpdateUIProps failed`
      // lines that saturate the UI thread). WhatsApp/Signal/Telegram animate
      // recycled rows via the RecyclerView item-animator, NOT per-row JS layout
      // animations — new messages just appear. So ALL layout animations are
      // removed from the row; `animateEntry` is now unused (kept in the prop
      // type for call-site compatibility). This Animated.View remains ONLY for
      // the `highlightAnim` value-style (a shared-value background tint on the
      // stable mounted view — safe, not a layout animation).
      style={[
        styles.bubbleRow,
        mine ? styles.rowMine : styles.rowTheirs,
        // Tighter spacing between grouped messages, looser between groups.
        firstInGroup ? styles.rowGroupStart : styles.rowGrouped,
        selectionRowStyle,
        highlightAnim,
      ]}
    >
      {/* Selection check indicator (Signal-style) shown on the leading edge of
          the row while in selection mode. */}
      {selectionActive ? (
        <View
          style={[
            styles.selectCircle,
            selected && styles.selectCircleOn,
            mine ? styles.selectCircleMine : styles.selectCircleTheirs,
          ]}
        >
          {selected ? <Check size={14} color="#fff" /> : null}
        </View>
      ) : null}
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
              onPressIn={onPressIn}
              onPressOut={onPressOut}
              onPress={() => {
                // While in selection mode, a plain tap toggles this row in/out of
                // the selection instead of doing nothing (Signal-style).
                if (selectionActive) onPressSelect?.(message);
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
                isEmojiOnly && styles.bubbleEmojiOnly,
                isEmojiOnly &&
                  (mine ? styles.bubbleEmojiOnlyMine : styles.bubbleEmojiOnlyTheirs),
                cornerStyle,
                message._pending && styles.bubblePending,
              ]}
            >
              {!mine && firstInGroup && message.sender_name ? (
                // On media-only bubbles the container padding is stripped to let the
                // image lift edge-to-edge — which clipped the sender name's first
                // letter. Re-add horizontal padding to the name in that case so it
                // clears the bubble edge.
                <Text
                  style={[styles.sender, isMediaOnly && styles.senderMedia]}
                >
                  {message.sender_name}
                </Text>
              ) : null}
              {message.reply_to_id && !deleted ? (
                <ReplyQuote
                  message={message}
                  onPress={
                    onJumpToReply ? () => onJumpToReply(message) : undefined
                  }
                />
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
                mediaUploadInProgress ? null : (
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
                        readReceiptTimes={readReceiptTimes}
                        userId={userId}
                        onMedia
                        onRetry={mine ? () => onRetry?.(message) : undefined}
                      />
                  </View>
                )
              ) : (
                <View style={styles.contentRow}>
                  <MessageContent message={message} mine={mine} />
                  <View style={styles.metaLine}>
                    {pinned ? (
                      <Pin
                        size={10}
                        color={mine ? theme.chatOutMeta : theme.textMuted}
                      />
                    ) : null}
                    {starred ? (
                      <Star
                        size={10}
                        color={mine ? theme.chatOutMeta : theme.warning}
                      />
                    ) : null}
                    {message.edited_at && !deleted ? (
                      <Text style={[styles.edited, mine && styles.editedMine]}>
                        edited
                      </Text>
                    ) : null}
                    <Text style={[styles.time, mine && styles.timeMine]}>
                      {fmtTime(message.created_at)}
                    </Text>
                    {mediaUploadInProgress ? null : (
                      <MsgTicks
                        mine={mine}
                        msg={message}
                        participantCount={participantCount}
                        readReceiptTimes={readReceiptTimes}
                        userId={userId}
                        onRetry={mine ? () => onRetry?.(message) : undefined}
                      />
                    )}
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
    </Animated.View>
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
    // Signal-style selection check circle shown on the row's leading edge while
    // selection mode is active.
    selectCircle: {
      width: 22,
      height: 22,
      borderRadius: 11,
      borderWidth: 2,
      borderColor: theme.textMuted,
      alignItems: "center",
      justifyContent: "center",
      marginHorizontal: 6,
    },
    selectCircleOn: {
      backgroundColor: theme.primary,
      borderColor: theme.primary,
    },
    // The check sits before the bubble on both sides; ordering is handled by the
    // row's flex direction so these are mostly future-proofing hooks.
    selectCircleMine: {},
    selectCircleTheirs: {},
    // 8px between distinct groups, 2px between messages within a group.
    rowGroupStart: { marginTop: 6 },
    rowGrouped: { marginTop: 2 },
    bubbleCol: { maxWidth: "82%" },
    bubble: {
      position: "relative",
      alignSelf: "stretch",
      borderRadius: 18,
      // Signal-Android conversation item padding (12dp horizontal, 8dp vertical).
      paddingHorizontal: 12,
      paddingVertical: 8,
      gap: 2,
    },
    // Own messages — a VERY light org-accent wash (tenant brand) so sent
    // bubbles read subtly branded against incoming ones, without the loud
    // solid accent fill. A hairline accent border keeps the edge defined on
    // dark surfaces.
    bubbleMine: {
      backgroundColor: theme.chatOutBgSubtle,
      borderWidth: 1,
      borderColor: theme.chatOutBorderSubtle,
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
    // Emoji-only text messages (Signal JUMBOMOJI): NO bubble at all — the
    // glyphs float directly on the thread background, frameless and
    // borderless, exactly like Signal/WhatsApp. The old translucent bordered
    // box read as a washed-out frame around the emoji.
    bubbleEmojiOnly: {
      backgroundColor: "transparent",
      borderWidth: 0,
      paddingHorizontal: 2,
      paddingVertical: 0,
    },
    bubbleEmojiOnlyMine: {},
    bubbleEmojiOnlyTheirs: {},
    bubblePending: { opacity: 0.7 },
    sender: {
      // Signal-Android group sender name (13sp).
      fontSize: 13,
      fontFamily: theme.fontSemiBold,
      color: theme.primaryLight,
    },
    // Media-only bubbles strip the container's horizontal padding so the image
    // lifts edge-to-edge; re-add it on the sender name so its first letter
    // isn't clipped against the bubble edge.
    senderMedia: { paddingHorizontal: 12, paddingTop: 4 },
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
      // Signal-Android footer text (11sp).
      fontSize: 11,
      color: theme.textMuted,
      fontStyle: "italic",
      fontFamily: theme.fontRegular,
    },
    editedMine: { color: theme.chatOutMeta },
    time: {
      fontSize: 11,
      color: theme.textMuted,
      fontFamily: theme.fontRegular,
    },
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

/**
 * Memoized export. The message FlatList re-renders on every state change
 * (incoming message, typing, reaction toggle, etc.), and without memoization
 * EVERY mounted bubble re-rendered each time — the main cause of jank on long
 * threads and low-end devices. This comparator re-renders a row ONLY when
 * something it actually displays changes. The callback props are stable
 * (useCallback in the parent hook), so they're intentionally not compared.
 */
function reactionsSig(m: ChatMessage): string {
  const rs = m.reactions || [];
  let s = "";
  for (const r of rs) s += `${r.userId}${r.emoji},`;
  return s;
}

function areEqual(prev: MessageBubbleProps, next: MessageBubbleProps): boolean {
  const a = prev.message;
  const b = next.message;
  return (
    a.id === b.id &&
    a.content === b.content &&
    a.created_at === b.created_at &&
    a.edited_at === b.edited_at &&
    a.deleted_at === b.deleted_at &&
    a.pinned_at === b.pinned_at &&
    a.file_url === b.file_url &&
    a.file_type === b.file_type &&
    a.file_name === b.file_name &&
    a.media_state === b.media_state &&
    a._pending === b._pending &&
    a._failed === b._failed &&
    a._mediaState === b._mediaState &&
    a._mediaProgress === b._mediaProgress &&
    reactionsSig(a) === reactionsSig(b) &&
    prev.mine === next.mine &&
    prev.deleted === next.deleted &&
    prev.starred === next.starred &&
    prev.pinned === next.pinned &&
    prev.participantCount === next.participantCount &&
    prev.readReceiptTimes === next.readReceiptTimes &&
    prev.userId === next.userId &&
    prev.firstInGroup === next.firstInGroup &&
    prev.lastInGroup === next.lastInGroup &&
    prev.highlighted === next.highlighted &&
    prev.selected === next.selected &&
    prev.selectionActive === next.selectionActive
  );
}

const MessageBubble = memo(MessageBubbleImpl, areEqual);

export default MessageBubble;
