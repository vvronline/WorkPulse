import { useMemo } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { X as XIcon } from "lucide-react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import { ALL_EMOJIS } from "./chatUtils";

/**
 * Full emoji grid sheet (mirrors the web EmojiGifPicker). Opened either from
 * the reaction bar ("react" mode) or the composer "+" menu ("compose" mode).
 */
export default function EmojiPicker({
  visible,
  mode,
  onPick,
  onClose,
}: {
  visible: boolean;
  mode: "react" | "compose";
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  if (!visible) return null;
  return (
    <View style={styles.allOverlay}>
      <Pressable style={styles.allScrim} onPress={onClose} />
      <View style={styles.allSheet}>
        <View style={styles.allHeader}>
          <Text style={styles.allTitle}>
            {mode === "compose" ? "Insert emoji" : "Pick a reaction"}
          </Text>
          <Pressable onPress={onClose} hitSlop={8}>
            <XIcon size={22} color={theme.textSecondary} />
          </Pressable>
        </View>
        <FlatList
          data={ALL_EMOJIS}
          keyExtractor={(e, i) => `${e}-${i}`}
          numColumns={8}
          contentContainerStyle={styles.allGrid}
          renderItem={({ item: e }) => (
            <Pressable style={styles.gridEmoji} onPress={() => onPick(e)}>
              <Text style={styles.gridEmojiText}>{e}</Text>
            </Pressable>
          )}
        />
      </View>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    allOverlay: { flex: 1, justifyContent: "flex-end" },
    allScrim: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: "rgba(0,0,0,0.6)",
    },
    allSheet: {
      backgroundColor: theme.bgElevated,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingHorizontal: 12,
      paddingTop: 12,
      paddingBottom: 24,
      maxHeight: "60%",
    },
    allHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: 6,
      paddingBottom: 10,
    },
    allTitle: { fontSize: 16, fontWeight: "700", color: theme.text },
    allGrid: { gap: 2 },
    gridEmoji: {
      flex: 1,
      aspectRatio: 1,
      alignItems: "center",
      justifyContent: "center",
      maxWidth: `${100 / 8}%`,
    },
    gridEmojiText: { fontSize: 28 },
  });