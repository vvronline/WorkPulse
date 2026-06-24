import { useEffect, useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  cancelAnimation,
} from "react-native-reanimated";
import Svg, { Circle, Path } from "react-native-svg";
import { AlertTriangle, RefreshCw } from "lucide-react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import type { ChatMessage } from "../../features";

/**
 * Signal-Android delivery status for the current user's own messages.
 *
 * Signal uses TWO ticks (✓✓), and the "read" state rings EACH of the two ticks
 * in its own circle (two separate circled checks), tinted with the accent. The
 * progression is:
 *   sending   → a single spinning ring (message not yet confirmed)
 *   sent      → one tick (✓)
 *   delivered → two ticks (✓✓)
 *   read      → two ticks, EACH inside its own circle, accent-tinted
 *
 * Animations (matching Signal):
 *   • sending: the ring rotates continuously.
 *   • sent→delivered→read: the glyph fades + scales in (a quick pop) on each
 *     transition.
 *
 * The icon sits in a FIXED, slightly oversized box with centered alignment so
 * the rings are never cropped by the bubble's bottom edge.
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
  // Own bubbles use a neutral fill; the read state pops in a brighter tint.
  onAccent?: boolean;
  onRetry?: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const mutedColor = onAccent ? "rgba(255,255,255,0.78)" : theme.textMuted;
  const readColor = onAccent ? "#7cc4ff" : theme.primary;

  const phase = resolvePhase(msg, participantCount, readReceipts, userId);

  // Pop-in animation on each delivery-state transition (sent→delivered→read).
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);
  // Continuous rotation for the "sending" ring.
  const spin = useSharedValue(0);

  useEffect(() => {
    if (phase === "sending") {
      spin.value = 0;
      spin.value = withRepeat(
        withTiming(360, { duration: 900, easing: Easing.linear }),
        -1,
        false,
      );
      return () => cancelAnimation(spin);
    }
    cancelAnimation(spin);
    spin.value = 0;
    return undefined;
  }, [phase, spin]);

  useEffect(() => {
    if (phase === "sent" || phase === "delivered" || phase === "read") {
      opacity.value = 0;
      scale.value = 0.55;
      opacity.value = withTiming(1, { duration: 130 });
      scale.value = withSequence(
        withTiming(1.18, { duration: 140, easing: Easing.out(Easing.quad) }),
        withTiming(1, { duration: 120, easing: Easing.inOut(Easing.quad) }),
      );
    }
  }, [phase, scale, opacity]);

  const glyphAnim = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }));
  const spinAnim = useAnimatedStyle(() => ({
    transform: [{ rotate: `${spin.value}deg` }],
  }));

  if (!mine) return null;

  if (msg._failed) {
    return (
      <Pressable
        onPress={onRetry}
        disabled={!onRetry}
        style={styles.box}
        hitSlop={6}
      >
        <AlertTriangle size={14} color={theme.danger} />
        <RefreshCw size={13} color={theme.danger} style={{ marginLeft: 2 }} />
      </Pressable>
    );
  }

  if (phase === "hidden") return null;

  if (phase === "sending") {
    return (
      <View style={styles.box}>
        <Animated.View style={spinAnim}>
          <Svg width={14} height={14} viewBox="0 0 16 16" fill="none">
            <Circle
              cx={8}
              cy={8}
              r={6}
              stroke={mutedColor}
              strokeWidth={1.5}
              opacity={0.35}
            />
            <Path
              d="M8 2a6 6 0 016 6"
              stroke={mutedColor}
              strokeWidth={1.5}
              strokeLinecap="round"
            />
          </Svg>
        </Animated.View>
      </View>
    );
  }

  const color = phase === "read" ? readColor : mutedColor;
  const ringed = phase === "read";
  // sent → one tick; delivered/read → two ticks.
  const doubleTick = phase === "delivered" || phase === "read";

  return (
    <Animated.View style={[styles.box, glyphAnim]}>
      <DoubleTicks color={color} ringed={ringed} doubleTick={doubleTick} />
    </Animated.View>
  );
}

type Phase = "sending" | "sent" | "delivered" | "read" | "hidden";

function resolvePhase(
  msg: ChatMessage,
  participantCount: number,
  readReceipts: Record<number, string>,
  userId?: number,
): Phase {
  if (msg._pending || msg.id < 0) return "sending";
  const others = (participantCount || 2) - 1;
  if (others <= 0) return "hidden";

  const delivered = msg.delivered_to || [];
  const msgTime = new Date(msg.created_at).getTime();
  const otherReaders = Object.entries(readReceipts).filter(
    ([uid, readAt]) =>
      Number(uid) !== userId && new Date(readAt).getTime() >= msgTime,
  );

  // Read by everyone (or read + delivered to all) → ringed double ticks.
  if (otherReaders.length >= others) return "read";
  if (otherReaders.length > 0 && delivered.length >= others) return "read";
  // Delivered to all/some → two ticks.
  if (delivered.length > 0) return "delivered";
  // Sent only → one tick.
  return "sent";
}

/**
 * Renders Signal's tick glyph: ONE tick (sent) or TWO offset ticks
 * (delivered/read). When `ringed`, EACH tick is enclosed in its own circle
 * (the "read" state) — two separate circled checks side by side.
 */
function DoubleTicks({
  color,
  ringed,
  doubleTick,
}: {
  color: string;
  ringed: boolean;
  doubleTick: boolean;
}) {
  // Single tick — width 16; double tick — wider canvas (the two ticks overlap
  // slightly like Signal/WhatsApp).
  if (!doubleTick) {
    return (
      <Svg width={16} height={16} viewBox="0 0 16 16" fill="none">
        {ringed ? (
          <Circle cx={8} cy={8} r={7} stroke={color} strokeWidth={1.2} />
        ) : null}
        <Path
          d={ringed ? "M4.7 8.2l2.2 2.2L11.3 5.8" : "M3.5 8.5l3 3 6-7"}
          stroke={color}
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    );
  }
  // Two ticks. When ringed, draw two separate circles each containing a check.
  return (
    <Svg width={22} height={16} viewBox="0 0 22 16" fill="none">
      {ringed ? (
        <>
          {/* First circled check */}
          <Circle cx={7} cy={8} r={6.4} stroke={color} strokeWidth={1.1} />
          <Path
            d="M4.2 8.1l1.8 1.8L9.7 6.2"
            stroke={color}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* Second circled check, offset right */}
          <Circle cx={15} cy={8} r={6.4} stroke={color} strokeWidth={1.1} />
          <Path
            d="M12.2 8.1l1.8 1.8L17.7 6.2"
            stroke={color}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <>
          {/* Two bare overlapping ticks (delivered). */}
          <Path
            d="M2.5 8.5l3 3 6-7"
            stroke={color}
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <Path
            d="M9.5 8.5l3 3 6-7"
            stroke={color}
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
    </Svg>
  );
}

const makeStyles = (_theme: Theme) =>
  StyleSheet.create({
    // Fixed, centered box so the circled ticks are NEVER cropped by the
    // bubble's bottom edge (the previous negative margin clipped them).
    box: {
      height: 16,
      minWidth: 16,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
    },
  });