import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import type { ChatMessage } from "../../features";

/**
 * In-bubble quoted reply preview (mirrors the web ReplyPreview when rendered
 * inside a MessageBubble). Shows the original sender + a one-line snippet.
 */
export default function ReplyQuote({ message }: { message: ChatMessage }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View style={styles.replyQuote}>
      <Text style={styles.replyQuoteName} numberOfLines={1}>
        {message.reply_to_sender_name || "Reply"}
      </Text>
      <Text style={styles.replyQuoteText} numberOfLines={1}>
        {message.reply_to_content || "Attachment"}
      </Text>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    replyQuote: {
      borderLeftWidth: 3,
      borderLeftColor: theme.primary,
      backgroundColor: "rgba(255,255,255,0.06)",
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 4,
      marginBottom: 4,
      gap: 1,
    },
    replyQuoteName: {
      fontSize: 11,
      fontWeight: "700",
      color: theme.primaryLight,
    },
    replyQuoteText: { fontSize: 12, color: theme.textSecondary },
  });