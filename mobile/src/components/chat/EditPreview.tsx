import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Pencil, X as XIcon } from "../../icons";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";

/**
 * Composer "editing message…" strip shown above the input bar while a message
 * is being edited (mirrors Signal-Android's edit affordance, which surfaces a
 * dedicated "Edit message" banner with the original text + a cancel control).
 * Without this, the only edit cue was the placeholder — which never shows since
 * the field is prefilled — leaving no indication an edit was in progress and no
 * way to cancel it. Tapping the X cancels the edit.
 */
export default function EditPreview({
  text,
  onCancel,
}: {
  text: string;
  onCancel: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View style={styles.editBar}>
      <Pencil size={16} color={theme.primary} />
      <View style={{ flex: 1 }}>
        <Text style={styles.editBarTitle} numberOfLines={1}>
          Editing message
        </Text>
        <Text style={styles.editBarText} numberOfLines={1}>
          {text || "Edit your message"}
        </Text>
      </View>
      <Pressable onPress={onCancel} hitSlop={8}>
        <XIcon size={18} color={theme.textSecondary} />
      </Pressable>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    editBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      marginHorizontal: 8,
      marginBottom: 4,
      paddingHorizontal: 12,
      paddingVertical: 8,
      backgroundColor: theme.inputBg,
      borderRadius: 12,
      // Signal-style left accent bar instead of a full-width footer divider.
      borderLeftWidth: 3,
      borderLeftColor: theme.primary,
    },
    editBarTitle: {
      fontSize: 12,
      fontWeight: "700",
      color: theme.primaryLight,
    },
    editBarText: { fontSize: 12, color: theme.textSecondary },
  });
