import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Pin, Star } from "lucide-react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import type { ChatMessage } from "../../features";
import MsgTicks from "./MsgTicks";
import ReplyQuote from "./ReplyQuote";
import FilePreview from "./FilePreview";
import MessageContent from "./MessageContent";
import ReactionChips from "./ReactionChips";
import { fmtTime } from "./chatUtils";

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
  onRetry?: (message: ChatMessage) => void;
  onCancelUpload?: (message: ChatMessage) => void;
  onRetryUpload?: (message: ChatMessage) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

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
      <View style={styles.bubbleCol}>
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
            />
          ) : null}
          {/* Signal inline footer: the message text and the time+ticks live in
              a SINGLE wrapping row. When the last line of text plus the footer
              fit within the bubble width, the time/ticks sit on the SAME line as
              the text (Signal's compact look); when they don't fit, the footer
              wraps to the bottom-right of the next line. The left margin keeps
              the footer from visually colliding with the text. */}
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
                onAccent={mine}
                onRetry={mine ? () => onRetry?.(message) : undefined}
              />
            </View>
          </View>
        </Pressable>

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
  });