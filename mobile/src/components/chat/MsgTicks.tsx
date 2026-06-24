import { useEffect, useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  withSequence,
  Easing,
} from "react-native-reanimated";
import Svg, { Circle, Path } from "react-native-svg";
import { AlertTriangle, Clock, RefreshCw } from "lucide-react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import type { ChatMessage } from "../../features";

/**
 * Signal-style delivery status for the current user's own messages. Signal uses
 * a CHECK INSIDE A CIRCLE that gains a second ring once the message is read:
 *   clock              → pending (optimistic, not yet acked by the server)
 *   check ◯            → sent / delivered (check inside ONE circle)
 *   check ◎ (2 rings)  → read (check inside TWO concentric circles, highlighted)
 *
 * The tick "pops" in with a small scale animation the moment it transitions
 * from pending → sent (mirrors Signal's status-change animation). Only own
 * messages render a status (incoming messages return null).
 */
export default function MsgTicks({
  mine,
  msg,
  participantCount,
  readReceipts,
  userId,
  onAccent,
  onRetry,
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
  onRetry?: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const SIZE = 15;
  const mutedColor = onAccent ? "rgba(255,255,255,0.75)" : theme.textMuted;
  // Signal's "read" emphasis: a bright tint on the accent bubble, the accent
  // color on a plain surface.
  const readColor = onAccent ? "#bfe7ff" : theme.primary;

  // Resolve the delivery phase up-front so the animation hook (which must run
  // unconditionally) can react to it.
  const phase = resolvePhase(msg, participantCount, readReceipts, userId);

  // Pop-in animation: scale 0.6 → 1.1 → 1 whenever the phase advances past
  // pending (Signal animates the status glyph on change).
  const scale = useSharedValue(1);
  useEffect(() => {
    if (phase === "sent" || phase === "read") {
      scale.value = withSequence(
        withTiming(0.6, { duration: 0 }),
        withTiming(1.12, { duration: 140, easing: Easing.out(Easing.quad) }),
        withTiming(1, { duration: 120, easing: Easing.inOut(Easing.quad) }),
      );
    }
  }, [phase, scale]);
  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  if (!mine) return null;

  if (msg._failed) {
    return (
      <Pressable
        onPress={onRetry}
        disabled={!onRetry}
        style={styles.retryWrap}
        hitSlop={6}
      >
        <AlertTriangle size={SIZE} color={theme.danger} />
        <RefreshCw size={SIZE - 1} color={theme.danger} />
      </Pressable>
    );
  }

  // Pending / optimistic (no server id yet) → clock.
  if (phase === "pending") {
    return (
      <View style={styles.wrap}>
        <Clock size={SIZE} color={mutedColor} />
      </View>
    );
  }

  // Single-participant edge case where there are no "others" — show nothing
  // (resolvePhase returns "hidden").
  if (phase === "hidden") return null;

  const doubleRing = phase === "read";
  const color = doubleRing ? readColor : mutedColor;

  return (
    <Animated.View style={[styles.wrap, animStyle]}>
      <CircledCheck size={SIZE} color={color} doubleRing={doubleRing} />
    </Animated.View>
  );
}

type Phase = "pending" | "sent" | "read" | "hidden";

function resolvePhase(
  msg: ChatMessage,
  participantCount: number,
  readReceipts: Record<number, string>,
  userId?: number,
): Phase {
  if (msg._pending || msg.id < 0) return "pending";
  const others = (participantCount || 2) - 1;
  if (others <= 0) return "hidden";

  const delivered = msg.delivered_to || [];
  const msgTime = new Date(msg.created_at).getTime();
  const otherReaders = Object.entries(readReceipts).filter(
    ([uid, readAt]) =>
      Number(uid) !== userId && new Date(readAt).getTime() >= msgTime,
  );

  // Read → double ring (Signal's "read").
  if (
    otherReaders.length >= others ||
    (otherReaders.length > 0 && delivered.length >= others)
  ) {
    return "read";
  }
  // Sent / delivered → single ring.
  return "sent";
}

/**
 * A check mark inside a circle (Signal status glyph). When `doubleRing` is set
 * a second, larger concentric ring is drawn around it (the "read" state).
 */
function CircledCheck({
  size,
  color,
  doubleRing,
}: {
  size: number;
  color: string;
  doubleRing?: boolean;
}) {
  // viewBox is 24×24; the check path + rings are laid out within it.
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {doubleRing ? (
        <Circle
          cx={12}
          cy={12}
          r={11}
          stroke={color}
          strokeWidth={1.5}
          fill="none"
        />
      ) : null}
      <Circle
        cx={12}
        cy={12}
        r={doubleRing ? 8 : 10}
        stroke={color}
        strokeWidth={1.7}
        fill="none"
      />
      <Path
        d={
          doubleRing
            ? "M8.2 12.2l2.4 2.4 4.8-5"
            : "M7.5 12.3l2.8 2.8 5.6-6"
        }
        stroke={color}
        strokeWidth={1.9}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

const makeStyles = (_theme: Theme) =>
  StyleSheet.create({
    // Nudge the icon to sit baseline-aligned with the inline timestamp text.
    wrap: { marginBottom: -1 },
    retryWrap: { marginBottom: -1, flexDirection: "row", alignItems: "center", gap: 2 },
  });