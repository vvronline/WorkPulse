import { useMemo } from "react";
import { StyleSheet, Text } from "react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import type { ChatMessage } from "../../features";

/**
 * WhatsApp-style delivery indicator for the current user's own messages.
 * Mirrors the web `DeliveryStatus` component:
 *   ○  pending (optimistic, not yet acked by server)
 *   ✓  sent
 *   ✓✓ delivered (grey)
 *   ✓✓ read (blue)
 */
export default function MsgTicks({
  mine,
  msg,
  participantCount,
  readReceipts,
  userId,
}: {
  mine: boolean;
  msg: ChatMessage;
  participantCount: number;
  readReceipts: Record<number, string>;
  userId?: number;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  if (!mine) return null;
  if (msg._pending || msg.id < 0) {
    return <Text style={styles.tickSent}>○</Text>;
  }
  const others = (participantCount || 2) - 1;
  if (others <= 0) return null;

  const delivered = msg.delivered_to || [];
  const msgTime = new Date(msg.created_at).getTime();
  const otherReaders = Object.entries(readReceipts).filter(
    ([uid, readAt]) =>
      Number(uid) !== userId && new Date(readAt).getTime() >= msgTime,
  );

  if (
    otherReaders.length >= others ||
    (otherReaders.length > 0 && delivered.length >= others)
  ) {
    return <Text style={styles.tickRead}>✓✓</Text>;
  }
  if (delivered.length >= others || delivered.length > 0) {
    return <Text style={styles.tickDelivered}>✓✓</Text>;
  }
  return <Text style={styles.tickSent}>✓</Text>;
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    tickSent: { fontSize: 11, color: theme.textMuted },
    tickDelivered: { fontSize: 11, color: theme.textMuted },
    tickRead: { fontSize: 11, color: theme.primary, fontWeight: "700" },
  });