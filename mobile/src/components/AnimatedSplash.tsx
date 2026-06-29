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
 * tree while the JS bundle boots.
 *
 * It is designed to be a SEAMLESS continuation of the native expo-splash-screen
 * (same #0a0e1c brand navy, SAME logo at the SAME size/position) so there is no
 * visible "logo shrinks / second smaller logo" hand-off. The logo is therefore
 * STATIC here — only the "loops" Pacifico wordmark animates in beneath it, then
 * the whole overlay fades out via `onDone`.
 *
 * NOTE: imageWidth/backgroundColor below MUST stay in sync with the
 * expo-splash-screen plugin config in app.config.ts.
 */

// Keep in sync with expo-splash-screen `imageWidth` in app.config.ts so the
// JS logo is the exact same size as the native splash logo (no shrink).
const LOGO_SIZE = 288;

export default function AnimatedSplash({ onDone }: { onDone: () => void }) {
  // Wordmark: fade + upward slide. The logo does NOT animate (it must match the
  // native splash exactly), so only these drive the entrance.
  const wordOpacity = useSharedValue(0);
  const wordTranslate = useSharedValue(10);
  // Whole-screen fade-out.
  const screenOpacity = useSharedValue(1);

  useEffect(() => {
    // 1. Wordmark fades + slides in under the (already-visible) logo.
    wordOpacity.value = withTiming(1, {
      duration: 560,
      easing: Easing.out(Easing.cubic),
    });
    wordTranslate.value = withTiming(0, {
      duration: 620,
      easing: Easing.out(Easing.cubic),
    });

    // 2. Hold, then fade the whole overlay out and signal completion.
    screenOpacity.value = withDelay(
      1400,
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
  const wordStyle = useAnimatedStyle(() => ({
    opacity: wordOpacity.value,
    transform: [{ translateY: wordTranslate.value }],
  }));

  return (
    <Animated.View style={[styles.root, screenStyle]} pointerEvents="none">
      <View style={styles.center}>
        <Image
          source={require("../../assets/splash-icon.png")}
          style={styles.logo}
          resizeMode="contain"
        />
        {/* Negative margin pulls the wordmark up under the VISIBLE logo mark —
            splash-icon.png carries ~19% transparent safe-zone padding, so the
            image's bottom edge sits well below the actual logo. */}
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
  logo: { width: LOGO_SIZE, height: LOGO_SIZE },
  word: {
    // Pull up under the visible logo mark (image has transparent padding).
    marginTop: -56,
    fontFamily: FONTS.brand,
    fontSize: 42,
    color: "#ffffff",
    letterSpacing: 0.5,
    // Pacifico's descenders need a little vertical room.
    lineHeight: 54,
  },
});