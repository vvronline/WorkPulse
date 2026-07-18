import { useEffect, useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
  cancelAnimation,
} from "react-native-reanimated";
import Svg, { Circle, Path } from "react-native-svg";
import { AlertTriangle, Clock, RefreshCw } from "../../icons";
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
export type MessageDeliveryPhase =
  | "sending"
  | "sent"
  | "delivered"
  | "read"
  | "hidden";

export default function MsgTicks({
  mine,
  msg,
  phase,
  onMedia,
  onRetry,
}: {
  mine: boolean;
  msg: ChatMessage;
  /**
   * Precomputed once by the thread presentation model. Keeping receipt arrays
   * out of each row prevents one receipt pulse from invalidating every bubble
   * and avoids O(visible messages × participants) work during reconciliation.
   */
  phase: MessageDeliveryPhase;
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

  // Pop-in animation on each delivery-state transition (sent→delivered→read).
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);

  // PERF ROOT-CAUSE FIX (the "gradually lags very much then freezes" bug):
  // this component used to drive the "sending" state with an INFINITE
  // `withRepeat(withTiming(360), -1)` rotation. Under the New Architecture
  // (Fabric), an infinite animation keeps its Reanimated mapper posting a
  // `synchronouslyUpdateUIProps` for the animated view on EVERY frame, forever.
  // When the row is then unmounted/recycled (FlatList windowing, or the thread
  // screen unmounting) the view's Fabric surface is gone, so every one of those
  // per-frame updates throws `Unable to find SurfaceMountingManager for tag`
  // and RETRIES the next frame — indefinitely. Each pending/sending message
  // that ever mounted leaks one such never-ending failing mapper, so the log
  // (confirmed on-device: ~9.8 MILLION `synchronouslyUpdateUIProps failed`
  // lines) and the UI thread saturate progressively → the compounding freeze.
  //
  // WhatsApp/Signal/Telegram render "sending" as a STATIC clock glyph, not an
  // animation-framework loop. So the infinite spin is removed entirely; the
  // sending state is now a static Clock icon. Only FINITE pop-in animations
  // remain, and they're cancelled on unmount below so a row recycled mid-pop
  // can't leave a dangling mapper either.

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

  // Cancel any in-flight finite animation when the row unmounts so Reanimated
  // never tries to update a torn-down Fabric view tag (belt-and-suspenders
  // against the SurfaceMountingManager retry spam described above).
  useEffect(
    () => () => {
      cancelAnimation(scale);
      cancelAnimation(opacity);
    },
    [scale, opacity],
  );

  const glyphAnim = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
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
    // Static clock glyph (Signal/WhatsApp "sending" indicator). NO animation —
    // see the root-cause note above; an infinite spin here saturated Fabric with
    // failing per-frame UI updates once the row unmounted.
    return (
      <View style={styles.box}>
        <Clock size={13} color={mutedColor} />
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
  phase: MessageDeliveryPhase;
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