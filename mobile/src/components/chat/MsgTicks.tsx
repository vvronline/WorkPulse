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
import { AlertTriangle, RefreshCw } from "../../icons";
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
  onMedia,
  onRetry,
}: {
  mine: boolean;
  msg: ChatMessage;
  participantCount: number;
  readReceipts: Record<number, string>;
  userId?: number;
  // When the ticks sit OVER media (an image/video) inside the translucent dark
  // meta pill, force white glyphs and a dark punch-out for the read check so it
  // stays visible against the photo (web parity — see MessageBubble.module.css
  // .mediaOnly tick rules).
  onMedia?: boolean;
  onRetry?: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const mutedColor = onMedia ? "#fff" : theme.textMuted;
  // Over media the read state is a WHITE filled disc with a dark check punched
  // out; on a normal bubble it's an org-accent-tinted disc with a white check.
  // The read tick tracks the tenant branding accent (web parity:
  // .tickRead → var(--primary)). `theme.primary` is kept in sync with the org
  // accent by ThemeProvider, so this stays consistent with the web client and
  // live-updates on `branding_changed`.
  const readColor = onMedia ? "#fff" : theme.primary;
  const readCheckColor = onMedia ? "rgba(0,0,0,0.6)" : "#fff";

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

  return (
    <Animated.View style={[styles.box, glyphAnim]}>
      <TickGlyph
        phase={phase}
        mutedColor={mutedColor}
        readColor={readColor}
        readCheckColor={readCheckColor}
      />
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
 * Web-parity delivery glyphs (mirrors the web DeliveryStatus.tsx SVGs):
 *   sent      → a single bare check
 *   delivered → a check inside a single circle
 *   read      → a check inside a double circle, filled with the accent color
 *               (the check is "punched out" of the filled disc)
 */
function TickGlyph({
  phase,
  mutedColor,
  readColor,
  readCheckColor,
}: {
  phase: Phase;
  mutedColor: string;
  readColor: string;
  readCheckColor: string;
}) {
  if (phase === "sent") {
    return (
      <Svg width={15} height={15} viewBox="0 0 16 16" fill="none">
        <Path
          d="M3.5 8.5l3 3 6-7"
          stroke={mutedColor}
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    );
  }
  if (phase === "delivered") {
    return (
      <Svg width={15} height={15} viewBox="0 0 16 16" fill="none">
        <Circle cx={8} cy={8} r={7} stroke={mutedColor} strokeWidth={1.3} />
        <Path
          d="M4.6 8.2l2.2 2.2L11.4 5.6"
          stroke={mutedColor}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    );
  }
  // read — double-circle filled disc with a check punched out of it.
  return (
    <Svg width={15} height={15} viewBox="0 0 16 16" fill="none">
      {/* Outer ring */}
      <Circle cx={8} cy={8} r={7} stroke={readColor} strokeWidth={1.1} />
      {/* Inner filled disc */}
      <Circle cx={8} cy={8} r={5.2} fill={readColor} />
      {/* Check punched out of the filled disc */}
      <Path
        d="M5.4 8.1l1.8 1.8L10.7 6"
        stroke={readCheckColor}
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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