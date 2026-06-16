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
  onAccent,
}: {
  mine: boolean;
  msg: ChatMessage;
  participantCount: number;
  readReceipts: Record<number, string>;
  userId?: number;
  // WhatsApp-style: own bubbles use the accent fill, so the sent/delivered
  // ticks render in translucent white and the "read" tick in a bright cyan
  // that pops against the accent background.
  onAccent?: boolean;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  if (!mine) return null;
  const sentStyle = onAccent ? styles.tickSentOnAccent : styles.tickSent;
  const deliveredStyle = onAccent
    ? styles.tickSentOnAccent
    : styles.tickDelivered;
  const readStyle = onAccent ? styles.tickReadOnAccent : styles.tickRead;
  if (msg._pending || msg.id < 0) {
    return <Text style={sentStyle}>○</Text>;
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
    return <Text style={readStyle}>✓✓</Text>;
  }
  if (delivered.length >= others || delivered.length > 0) {
    return <Text style={deliveredStyle}>✓✓</Text>;
  }
  return <Text style={sentStyle}>✓</Text>;
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    tickSent: { fontSize: 11, color: theme.textMuted },
    tickDelivered: { fontSize: 11, color: theme.textMuted },
    tickRead: { fontSize: 11, color: theme.primary, fontWeight: "700" },
    tickSentOnAccent: { fontSize: 11, color: "rgba(255,255,255,0.7)" },
    tickReadOnAccent: { fontSize: 11, color: "#7ad1ff", fontWeight: "700" },
  });
