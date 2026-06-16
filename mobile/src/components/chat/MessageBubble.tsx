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
 * A single chat message row (mirrors the web `MessageBubble`). Renders the
 * bubble (sender name, reply quote, file preview, content, meta line with
 * pin/star/edited/time/ticks) plus the reaction chips row below it.
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
            message._pending && styles.bubblePending,
          ]}
        >
          {!mine && message.sender_name ? (
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
      borderRadius: 14,
      paddingHorizontal: 12,
      paddingVertical: 8,
      gap: 2,
    },
    bubbleMine: {
      backgroundColor: "rgba(35,131,226,0.18)",
      borderWidth: 1,
      borderColor: "rgba(35,131,226,0.25)",
    },
    bubbleTheirs: {
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.glassBorder,
    },
    bubblePending: { opacity: 0.6 },
    sender: { fontSize: 11, fontWeight: "700", color: theme.primaryLight },
    metaLine: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      alignSelf: "flex-end",
    },
    edited: { fontSize: 10, color: theme.textMuted, fontStyle: "italic" },
    time: { fontSize: 10, color: theme.textMuted },
  });