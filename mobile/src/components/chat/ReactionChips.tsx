import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Plus } from "lucide-react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import type { ChatMessage } from "../../features";

/**
 * Reaction chips row rendered BELOW the bubble (mirrors the web ReactionBar /
 * MessageBubble reactions row). Aggregates a message's reactions by emoji and
 * highlights the current user's own reactions.
 */
export default function ReactionChips({
  message,
  mine,
  userId,
  onToggle,
  onAdd,
}: {
  message: ChatMessage;
  mine: boolean;
  userId?: number;
  onToggle: (message: ChatMessage, emoji: string) => void;
  onAdd: (message: ChatMessage, mine: boolean) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  // Aggregate reactions by emoji.
  const groups: Record<string, { count: number; mine: boolean }> = {};
  (message.reactions || []).forEach((r) => {
    if (!groups[r.emoji]) groups[r.emoji] = { count: 0, mine: false };
    groups[r.emoji].count += 1;
    if (r.userId === userId) groups[r.emoji].mine = true;
  });

  if (Object.keys(groups).length === 0) return null;

  return (
    <View
      style={[
        styles.reactions,
        mine ? styles.reactionsMine : styles.reactionsTheirs,
      ]}
    >
      {Object.entries(groups).map(([emoji, g]) => (
        <Pressable
          key={emoji}
          style={[styles.reactionChip, g.mine && styles.myReactionChip]}
          onPress={() => onToggle(message, emoji)}
        >
          <Text style={styles.reactionEmoji}>{emoji}</Text>
          <Text style={styles.reactionCount}>{g.count}</Text>
        </Pressable>
      ))}
      <Pressable style={styles.addReactionBtn} onPress={() => onAdd(message, mine)}>
        <Plus size={13} color={theme.textMuted} />
      </Pressable>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    // Reaction chips row BELOW the bubble (web .reactions: margin-top 4px).
    reactions: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 4,
      marginTop: 4,
      paddingHorizontal: 2,
    },
    reactionsMine: { justifyContent: "flex-end" },
    reactionsTheirs: { justifyContent: "flex-start" },
    reactionChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 3,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radiusFull,
      paddingHorizontal: 7,
      paddingVertical: 3,
    },
    myReactionChip: {
      backgroundColor: "rgba(35,131,226,0.18)",
      borderColor: "rgba(35,131,226,0.35)",
    },
    reactionEmoji: { fontSize: 15 },
    reactionCount: {
      fontSize: 11,
      color: theme.textSecondary,
      fontWeight: "600",
    },
    addReactionBtn: {
      width: 26,
      height: 24,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radiusFull,
    },
  });