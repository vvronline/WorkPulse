import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { CornerUpLeft, X as XIcon } from "lucide-react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import type { ChatMessage } from "../../features";

/**
 * Composer "replying to…" strip shown above the input bar (mirrors the web
 * ReplyPreview). Tapping the X cancels the reply.
 */
export default function ReplyPreview({
  replyTo,
  onCancel,
}: {
  replyTo: ChatMessage;
  onCancel: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View style={styles.replyBar}>
      <CornerUpLeft size={16} color={theme.primary} />
      <View style={{ flex: 1 }}>
        <Text style={styles.replyBarName} numberOfLines={1}>
          Replying to {replyTo.sender_name || "message"}
        </Text>
        <Text style={styles.replyBarText} numberOfLines={1}>
          {replyTo.content || "Attachment"}
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
    replyBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 14,
      paddingVertical: 8,
      backgroundColor: theme.bgSecondary,
      borderTopWidth: 1,
      borderTopColor: theme.border,
    },
    replyBarName: {
      fontSize: 12,
      fontWeight: "700",
      color: theme.primaryLight,
    },
    replyBarText: { fontSize: 12, color: theme.textSecondary },
  });