/**
 * Skeleton placeholders.
 *
 * Replaces the "centered ActivityIndicator, then snap to content" pattern used
 * across the app. A spinner tells the user *that* something is loading;
 * a skeleton tells them *what* is loading and reserves the layout, so the
 * transition to real content has no jump.
 *
 * Implemented with Reanimated (already a dependency) so the shimmer runs on the
 * UI thread and keeps pulsing even while the JS thread is busy parsing the
 * response that the skeleton is waiting for — which is exactly when a
 * JS-driven animation would stutter.
 */

import { useEffect, useMemo } from "react";
import { StyleSheet, View, type DimensionValue, type ViewStyle } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { useTheme } from "../../theme/ThemeProvider";

type SkeletonProps = {
  /** Width of the block. Numbers are points; strings are percentages. */
  width?: DimensionValue;
  /** Height of the block in points. */
  height?: number;
  /** Corner radius. Defaults to the theme's small radius. */
  radius?: number;
  style?: ViewStyle;
};

/** A single shimmering block. Compose these to mirror your real layout. */
export function Skeleton({ width = "100%", height = 14, radius, style }: SkeletonProps) {
  const theme = useTheme();
  // Opacity pulse between a floor and ceiling rather than 0→1: a skeleton that
  // fades fully out reads as flickering content rather than a placeholder.
  const progress = useSharedValue(0.5);

  useEffect(() => {
    progress.value = withRepeat(
      withTiming(1, { duration: 850, easing: Easing.inOut(Easing.ease) }),
      -1, // repeat forever
      true, // reverse each cycle → smooth ping-pong, no snap back to the start
    );
    // Explicitly cancel on unmount. An un-cancelled infinite animation keeps a
    // UI-thread job alive after the view is gone.
    return () => cancelAnimation(progress);
  }, [progress]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: progress.value }));

  return (
    <Animated.View
      accessibilityRole="progressbar"
      accessibilityLabel="Loading"
      style={[
        {
          width,
          height,
          borderRadius: radius ?? theme.radiusSm,
          backgroundColor: theme.surfaceHover,
        },
        style,
        animatedStyle,
      ]}
    />
  );
}

/**
 * Skeleton shaped like a standard content card (title + a few text lines).
 * Use while a card-based screen (dashboard, tasks summary) is loading.
 */
export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  const theme = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        card: {
          backgroundColor: theme.cardBg,
          borderWidth: 1,
          borderColor: theme.border,
          borderRadius: theme.radiusLg,
          padding: theme.space.lg,
          gap: theme.space.md,
        },
      }),
    [theme],
  );

  return (
    <View style={styles.card}>
      <Skeleton width="45%" height={16} />
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          height={12}
          // Taper the last line so the block reads as a paragraph of text
          // instead of a solid rectangle.
          width={i === lines - 1 ? "60%" : "100%"}
        />
      ))}
    </View>
  );
}

/**
 * Skeleton shaped like an avatar + two-line list row. Use for conversation
 * lists, member directories, and any other avatar-led list.
 */
export function SkeletonListRow() {
  const theme = useTheme();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        row: {
          flexDirection: "row",
          alignItems: "center",
          gap: theme.space.md,
          paddingVertical: theme.space.md,
          paddingHorizontal: theme.space.lg,
        },
        body: { flex: 1, gap: theme.space.sm },
      }),
    [theme],
  );

  return (
    <View style={styles.row}>
      <Skeleton width={44} height={44} radius={theme.radiusFull} />
      <View style={styles.body}>
        <Skeleton width="50%" height={14} />
        <Skeleton width="80%" height={11} />
      </View>
    </View>
  );
}

/** Convenience: `count` stacked list-row skeletons. */
export function SkeletonList({ count = 6 }: { count?: number }) {
  return (
    <View>
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonListRow key={i} />
      ))}
    </View>
  );
}

export default Skeleton;