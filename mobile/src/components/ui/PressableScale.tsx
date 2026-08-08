/**
 * Pressable with a native-feeling press response.
 *
 * The app currently signals touch with a flat `opacity: 0.6` swap, which pops
 * between two states with no motion. iOS/Android system controls instead
 * *shrink* slightly under the finger and spring back on release. This wraps
 * that behaviour — a spring-driven scale plus a subtle dim — so cards, tiles
 * and icon buttons all respond identically.
 *
 * Runs entirely on the UI thread (Reanimated), so the press response stays
 * smooth even when the JS thread is busy handling the very action the press
 * triggered.
 */

import { useCallback } from "react";
import {
  Pressable,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { haptics } from "../../lib/haptics";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type PressableScaleProps = Omit<PressableProps, "style"> & {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /**
   * How far to shrink on press. 0.97 suits large cards; smaller controls need
   * a deeper scale (~0.92) for the movement to be perceptible at all.
   */
  activeScale?: number;
  /** Fire a light haptic tick on press. Default true. */
  hapticFeedback?: boolean;
  /** Also dim while pressed. Default true. */
  dim?: boolean;
};

export default function PressableScale({
  children,
  style,
  activeScale = 0.97,
  hapticFeedback = true,
  dim = true,
  onPressIn,
  onPressOut,
  disabled,
  ...rest
}: PressableScaleProps) {
  const pressed = useSharedValue(0);

  const handlePressIn: PressableProps["onPressIn"] = useCallback(
    (e: Parameters<NonNullable<PressableProps["onPressIn"]>>[0]) => {
      // Timing (not spring) on the way IN so the shrink tracks the finger
      // immediately; a spring here feels laggy on touch-down.
      pressed.value = withTiming(1, { duration: 90 });
      if (hapticFeedback) haptics.selection();
      onPressIn?.(e);
    },
    [hapticFeedback, onPressIn, pressed],
  );

  const handlePressOut: PressableProps["onPressOut"] = useCallback(
    (e: Parameters<NonNullable<PressableProps["onPressOut"]>>[0]) => {
      // Spring on the way OUT gives the control its "bounce back" character.
      pressed.value = withSpring(0, { damping: 15, stiffness: 320 });
      onPressOut?.(e);
    },
    [onPressOut, pressed],
  );

  const animatedStyle = useAnimatedStyle(() => {
    const t = pressed.value;
    return {
      transform: [{ scale: 1 - t * (1 - activeScale) }],
      opacity: dim ? 1 - t * 0.15 : 1,
    };
  });

  return (
    <AnimatedPressable
      {...rest}
      disabled={disabled}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      // Suppress the Android ripple: the scale animation IS the feedback, and
      // stacking a ripple on top reads as a double response.
      android_ripple={null}
      style={[style, animatedStyle, disabled && { opacity: 0.5 }]}
    >
      {children}
    </AnimatedPressable>
  );
}