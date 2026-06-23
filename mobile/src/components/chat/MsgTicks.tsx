import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { Check, CheckCheck, Clock } from "lucide-react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import type { ChatMessage } from "../../features";

/**
 * Signal-Android-style delivery status for the current user's own messages
 * (mirrors Signal's `DeliveryStatusView`). Signal uses ICONS, not text glyphs,
 * and read is NOT a separate blue tick — it's the SAME double-check, just
 * filled/highlighted so it stands out:
 *   clock        → pending (optimistic, not yet acked by the server)
 *   check        → sent
 *   check-check  → delivered (muted/outline)
 *   check-check  → read (highlighted — bright tint on the accent bubble, the
 *                  accent color on a plain surface)
 *
 * Only own messages render a status (incoming messages return null).
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
  // Own bubbles use the accent fill, so the sent/delivered icons render in
  // translucent white and the "read" icon in a bright tint that pops against
  // the accent background.
  onAccent?: boolean;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  if (!mine) return null;

  // Icon sizing + colors. ~13px sits inline with the 10px timestamp nicely.
  const SIZE = 13;
  const mutedColor = onAccent ? "rgba(255,255,255,0.7)" : theme.textMuted;
  // Signal's "read" emphasis: a bright tint on the accent bubble, the accent
  // color on a plain surface. NOT a separate WhatsApp-blue.
  const readColor = onAccent ? "#bfe7ff" : theme.primary;

  // Pending / optimistic (no server id yet) → clock.
  if (msg._pending || msg.id < 0) {
    return (
      <View style={styles.wrap}>
        <Clock size={SIZE} color={mutedColor} />
      </View>
    );
  }

  const others = (participantCount || 2) - 1;
  if (others <= 0) return null;

  const delivered = msg.delivered_to || [];
  const msgTime = new Date(msg.created_at).getTime();
  const otherReaders = Object.entries(readReceipts).filter(
    ([uid, readAt]) =>
      Number(uid) !== userId && new Date(readAt).getTime() >= msgTime,
  );

  // Read → highlighted double-check (Signal "filled read").
  if (
    otherReaders.length >= others ||
    (otherReaders.length > 0 && delivered.length >= others)
  ) {
    return (
      <View style={styles.wrap}>
        <CheckCheck size={SIZE} color={readColor} strokeWidth={2.5} />
      </View>
    );
  }

  // Delivered → muted/outline double-check.
  if (delivered.length >= others || delivered.length > 0) {
    return (
      <View style={styles.wrap}>
        <CheckCheck size={SIZE} color={mutedColor} />
      </View>
    );
  }

  // Sent → single check.
  return (
    <View style={styles.wrap}>
      <Check size={SIZE} color={mutedColor} />
    </View>
  );
}

const makeStyles = (_theme: Theme) =>
  StyleSheet.create({
    // Nudge the icon to sit baseline-aligned with the inline timestamp text.
    wrap: { marginBottom: -1 },
  });