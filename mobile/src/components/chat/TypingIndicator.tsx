import { useEffect, useMemo, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import ChatAvatar from "../ChatAvatar";

/**
 * Animated "peer is typing" indicator — mirrors the web ChatMessages typing row
 * (avatar + a flat incoming bubble with three bouncing dots).
 *
 * React Native has no CSS keyframes, so the desktop `typingBounce` animation is
 * reproduced with three looping `Animated.Value`s whose translateY bounces on a
 * staggered schedule (0ms / 200ms / 400ms delays over a 1.2s cycle) to match
 * the web client's `.typingDots i` animation cadence.
 */

interface TypingIndicatorProps {
  name?: string | null;
  avatar?: string | null;
}

function useBounce(delay: number) {
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    // One full cycle ≈ 1.2s: rise (180ms) + fall (180ms) + rest (840ms),
    // matching the desktop keyframe timing. The per-dot `delay` staggers the
    // three dots so they bounce in sequence.
    const animation = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(value, {
          toValue: 1,
          duration: 180,
          useNativeDriver: true,
        }),
        Animated.timing(value, {
          toValue: 0,
          duration: 180,
          useNativeDriver: true,
        }),
        Animated.delay(840 - delay),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [value, delay]);
  return value;
}

export default function TypingIndicator({ name, avatar }: TypingIndicatorProps) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const dot1 = useBounce(0);
  const dot2 = useBounce(200);
  const dot3 = useBounce(400);

  const translate = (v: Animated.Value) => ({
    transform: [
      {
        translateY: v.interpolate({
          inputRange: [0, 1],
          outputRange: [0, -4],
        }),
      },
    ],
  });

  return (
    <View style={styles.row}>
      <ChatAvatar name={name} avatar={avatar} size="sm" />
      <View style={styles.bubble}>
        <Animated.View style={[styles.dot, translate(dot1)]} />
        <Animated.View style={[styles.dot, translate(dot2)]} />
        <Animated.View style={[styles.dot, translate(dot3)]} />
      </View>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    row: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 8,
      paddingHorizontal: 12,
      // Keep a clear gap above (between the last bubble and this row) and
      // below (before the composer) so the typing indicator never crowds the
      // newest message or the input bar.
      paddingTop: 6,
      paddingBottom: 8,
    },
    bubble: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      backgroundColor: theme.chatInBg,
      paddingHorizontal: 14,
      paddingVertical: 12,
      borderRadius: theme.radiusLg,
      borderBottomLeftRadius: theme.radiusSm,
    },
    dot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: theme.textMuted,
    },
  });