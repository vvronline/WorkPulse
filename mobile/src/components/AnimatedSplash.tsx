import { useEffect } from "react";
import { Image, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { FONTS } from "../fonts";

/**
 * In-app animated splash overlay shown on cold start, layered ABOVE the app
 * tree while the JS bundle boots. It mirrors the native expo-splash-screen
 * (centered logo on the #0a0e1c brand navy) but ADDS the "loops" brand wordmark
 * (Pacifico) animating in underneath — something the static native splash image
 * cannot do.
 *
 * Sequence:
 *  1. Logo fades + scales in.
 *  2. "loops" wordmark fades up + draws in underneath (slight upward slide).
 *  3. After a short hold, the whole overlay fades out and unmounts via
 *     `onDone` so the underlying dashboard/login is revealed.
 */
export default function AnimatedSplash({ onDone }: { onDone: () => void }) {
  // Logo: fade + scale.
  const logoOpacity = useSharedValue(0);
  const logoScale = useSharedValue(0.82);
  // Wordmark: fade + upward slide.
  const wordOpacity = useSharedValue(0);
  const wordTranslate = useSharedValue(12);
  // Whole-screen fade-out.
  const screenOpacity = useSharedValue(1);

  useEffect(() => {
    // 1. Logo in.
    logoOpacity.value = withTiming(1, {
      duration: 520,
      easing: Easing.out(Easing.cubic),
    });
    logoScale.value = withTiming(1, {
      duration: 620,
      easing: Easing.out(Easing.back(1.4)),
    });

    // 2. Wordmark in (after the logo has begun settling).
    wordOpacity.value = withDelay(
      420,
      withTiming(1, { duration: 560, easing: Easing.out(Easing.cubic) }),
    );
    wordTranslate.value = withDelay(
      420,
      withTiming(0, { duration: 620, easing: Easing.out(Easing.cubic) }),
    );

    // 3. Hold, then fade the whole overlay out and signal completion.
    screenOpacity.value = withDelay(
      1500,
      withTiming(
        0,
        { duration: 420, easing: Easing.in(Easing.cubic) },
        (finished) => {
          if (finished) runOnJS(onDone)();
        },
      ),
    );
  }, []);

  const screenStyle = useAnimatedStyle(() => ({
    opacity: screenOpacity.value,
  }));
  const logoStyle = useAnimatedStyle(() => ({
    opacity: logoOpacity.value,
    transform: [{ scale: logoScale.value }],
  }));
  const wordStyle = useAnimatedStyle(() => ({
    opacity: wordOpacity.value,
    transform: [{ translateY: wordTranslate.value }],
  }));

  return (
    <Animated.View style={[styles.root, screenStyle]} pointerEvents="none">
      <View style={styles.center}>
        <Animated.View style={logoStyle}>
          <Image
            source={require("../../assets/splash-icon.png")}
            style={styles.logo}
            resizeMode="contain"
          />
        </Animated.View>
        <Animated.Text style={[styles.word, wordStyle]}>loops</Animated.Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    // Matches expo-splash-screen backgroundColor (#0a0e1c) in app.config.ts so
    // the native → JS splash hand-off is seamless (no background flash).
    backgroundColor: "#0a0e1c",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 9999,
  },
  center: { alignItems: "center", justifyContent: "center" },
  logo: { width: 168, height: 168 },
  word: {
    marginTop: 14,
    fontFamily: FONTS.brand,
    fontSize: 40,
    color: "#ffffff",
    letterSpacing: 0.5,
    // Pacifico's descenders need a little vertical room.
    lineHeight: 52,
  },
});