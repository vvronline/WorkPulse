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
 * A single chat message row (WhatsApp-style). Own messages render as a solid
 * accent-filled bubble with a tail on the top-right; incoming messages use a
 * solid elevated surface with a tail on the top-left. The time + delivery
 * ticks sit inline on the bottom-right of the bubble, mirroring WhatsApp.
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
  // name shows on the first of a group; the tail renders on the last.
  firstInGroup?: boolean;
  lastInGroup?: boolean;
  registerRef: (id: number, node: View | null) => void;
  onLongPress: (message: ChatMessage, mine: boolean) => void;
  onReact: (message: ChatMessage, emoji: string) => void;
  onAddReaction: (message: ChatMessage, mine: boolean) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  return (
    <View
      style={[styles.bubbleRow, mine ? styles.rowMine : styles.rowTheirs]}
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
            // Grouped (non-tail) bubbles get fully-rounded tail-side corners.
            !lastInGroup && (mine ? styles.bubbleMineGrouped : styles.bubbleTheirsGrouped),
            message._pending && styles.bubblePending,
          ]}
        >
          {/* Layered tail keeps the pointer edge crisp with the bubble border.
              Only the LAST message in a group shows the tail. */}
          {lastInGroup ? (
            <>
              <View
                style={[mine ? styles.tailMineBorder : styles.tailTheirsBorder]}
                pointerEvents="none"
              />
              <View
                style={[mine ? styles.tailMineFill : styles.tailTheirsFill]}
                pointerEvents="none"
              />
            </>
          ) : null}

          {!mine && firstInGroup && message.sender_name ? (
            <Text style={styles.sender}>{message.sender_name}</Text>
          ) : null}
          {message.reply_to_id && !deleted ? (
            <ReplyQuote message={message} />
          ) : null}
          {message.file_url && !deleted ? (
            <FilePreview message={message} />
          ) : null}
          <MessageContent message={message} />
          <View style={styles.metaLine}>
            {pinned ? <Pin size={10} color={theme.textMuted} /> : null}
            {starred ? <Star size={10} color={theme.warning} /> : null}
            {message.edited_at && !deleted ? (
              <Text style={styles.edited}>edited</Text>
            ) : null}
            <Text style={styles.time}>{fmtTime(message.created_at)}</Text>
            <MsgTicks
              mine={mine}
              msg={message}
              participantCount={participantCount}
              readReceipts={readReceipts}
              userId={userId}
            />
          </View>
        </Pressable>

        {/* Reactions render as a separate row BELOW the bubble (outside it),
            exactly like the web MessageBubble. */}
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
    bubbleRow: { flexDirection: "row", alignItems: "center", gap: 4 },
    rowMine: { justifyContent: "flex-end" },
    rowTheirs: { justifyContent: "flex-start" },
    bubbleCol: { maxWidth: "82%" },
    bubble: {
      position: "relative",
      alignSelf: "stretch",
      borderRadius: 16,
      paddingHorizontal: 12,
      paddingVertical: 7,
      gap: 2,
    },
    // Own messages — solid neutral fill, squared top-right corner (tail side).
    bubbleMine: {
      backgroundColor: theme.chatOutBg,
      borderTopRightRadius: 4,
      borderWidth: 1,
      borderColor: theme.chatBubbleBorder,
    },
    // Incoming messages — solid neutral surface, squared top-left corner.
    bubbleTheirs: {
      backgroundColor: theme.chatInBg,
      borderTopLeftRadius: 4,
      borderWidth: 1,
      borderColor: theme.chatBubbleBorder,
    },
    // Grouped (non-tail) bubbles round the tail-side corner fully so only the
    // last message in a group shows the squared tail corner.
    bubbleMineGrouped: { borderTopRightRadius: 16 },
    bubbleTheirsGrouped: { borderTopLeftRadius: 16 },
    bubblePending: { opacity: 0.7 },
    // Layered triangular tail: border layer + fill layer.
    tailMineBorder: {
      position: "absolute",
      top: -1,
      right: -8,
      width: 0,
      height: 0,
      borderTopWidth: 9,
      borderTopColor: theme.chatBubbleBorder,
      borderRightWidth: 9,
      borderRightColor: "transparent",
    },
    tailMineFill: {
      position: "absolute",
      top: 0,
      right: -6,
      width: 0,
      height: 0,
      borderTopWidth: 8,
      borderTopColor: theme.chatOutBg,
      borderRightWidth: 8,
      borderRightColor: "transparent",
    },
    tailTheirsBorder: {
      position: "absolute",
      top: -1,
      left: -8,
      width: 0,
      height: 0,
      borderTopWidth: 9,
      borderTopColor: theme.chatBubbleBorder,
      borderLeftWidth: 9,
      borderLeftColor: "transparent",
    },
    tailTheirsFill: {
      position: "absolute",
      top: 0,
      left: -6,
      width: 0,
      height: 0,
      borderTopWidth: 8,
      borderTopColor: theme.chatInBg,
      borderLeftWidth: 8,
      borderLeftColor: "transparent",
    },
    sender: { fontSize: 11, fontWeight: "700", color: theme.primaryLight },
    metaLine: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      alignSelf: "flex-end",
      marginTop: -2,
    },
    edited: { fontSize: 10, color: theme.textMuted, fontStyle: "italic" },
    time: { fontSize: 10, color: theme.textMuted },
  });
