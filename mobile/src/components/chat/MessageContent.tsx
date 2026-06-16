import { useMemo } from "react";
import { StyleSheet, Text } from "react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import type { ChatMessage } from "../../features";

/**
 * Renders a message's text body (mirrors the web MessageContent). Shows the
 * "deleted" placeholder when the message has been removed. Returns null when
 * there's nothing to show (e.g. an attachment-only message).
 */
export default function MessageContent({
  message,
  mine,
}: {
  message: ChatMessage;
  mine?: boolean;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const deleted = !!message.deleted_at;
  if (!message.content && !deleted) return null;
  return (
    <Text
      style={[
        styles.content,
        // WhatsApp-style: own bubbles use the accent fill, so text is white.
        mine && !deleted && styles.contentMine,
        deleted && styles.deleted,
      ]}
    >
      {deleted ? "This message was deleted" : message.content}
    </Text>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    content: { fontSize: 15, color: theme.text, lineHeight: 20 },
    contentMine: { color: "#fff" },
    deleted: { fontStyle: "italic", color: theme.textMuted },
  });
