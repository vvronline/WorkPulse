import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { Keyframe } from "react-native-reanimated";
import { Plus } from "lucide-react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import type { ChatMessage } from "../../features";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// Gentle zoom (no bounce, no layout slide). Starts/ends at 0.7 scale + fades so
// chips softly zoom in when added and zoom out when removed — identical for text
// and media bubbles. We deliberately DON'T use `layout` here: an image loads
// after the chat opens and grows the bubble, and a layout transition would make
// the pills "fall" to follow the new image height.
const CHIP_IN = new Keyframe({
  0: { opacity: 0, transform: [{ scale: 0.7 }] },
  100: { opacity: 1, transform: [{ scale: 1 }] },
}).duration(160);

const CHIP_OUT = new Keyframe({
  0: { opacity: 1, transform: [{ scale: 1 }] },
  100: { opacity: 0, transform: [{ scale: 0.7 }] },
}).duration(130);

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

  if (message.deleted_at || Object.keys(groups).length === 0) return null;

  return (
    <View
      style={[
        styles.reactions,
        mine ? styles.reactionsMine : styles.reactionsTheirs,
      ]}
    >
      {Object.entries(groups).map(([emoji, g]) => (
        // Gentle zoom in/out on add/remove — no layout slide, so reactions on
        // images don't "fall" when the image loads and grows the bubble.
        <AnimatedPressable
          key={emoji}
          entering={CHIP_IN}
          exiting={CHIP_OUT}
          style={[styles.reactionChip, g.mine && styles.myReactionChip]}
          onPress={() => onToggle(message, emoji)}
        >
          <Text style={styles.reactionEmoji}>{emoji}</Text>
          <Text style={styles.reactionCount}>{g.count}</Text>
        </AnimatedPressable>
      ))}
      <Pressable style={styles.addReactionBtn} onPress={() => onAdd(message, mine)}>
        <Plus size={13} color={theme.textMuted} />
      </Pressable>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    // Signal-style: reaction pills overlap the bottom edge of the bubble. A
    // negative top margin pulls them up over the bubble; horizontal padding +
    // alignment nudges them toward the sender side.
    reactions: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 4,
      marginTop: -10,
      paddingHorizontal: 8,
      zIndex: 2,
    },
    reactionsMine: { justifyContent: "flex-end" },
    reactionsTheirs: { justifyContent: "flex-start" },
    reactionChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 3,
      backgroundColor: theme.bgElevated,
      borderWidth: 1,
      borderColor: theme.bg,
      borderRadius: theme.radiusFull,
      paddingHorizontal: 7,
      paddingVertical: 3,
      // Subtle lift so the pill reads as floating over the bubble edge.
      shadowColor: "#000",
      shadowOpacity: 0.25,
      shadowRadius: 2,
      shadowOffset: { width: 0, height: 1 },
      elevation: 2,
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