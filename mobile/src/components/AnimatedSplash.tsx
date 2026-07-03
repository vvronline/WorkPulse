import { useEffect } from "react";
import { Image, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { FONTS } from "../fonts";
import { onAppReady } from "../utils/appReady";

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
 * READY-GATED (Signal-style): the overlay fades out as soon as the app signals
 * readiness (root route decided — see src/utils/appReady.ts), NOT after a fixed
 * timer. Previously it held for a guaranteed ~1.8s (560 fade-in + 1400 hold +
 * 420 fade-out) even when the app was ready in 300ms — the single biggest
 * contributor to the "slow cold start" feel. A small MINIMUM display time keeps
 * the brand mark from flickering on very fast launches, and a hard MAXIMUM
 * guarantees the splash can never wedge on-screen if the ready signal is lost.
 *
 * NOTE: imageWidth/backgroundColor below MUST stay in sync with the
 * expo-splash-screen plugin config in app.config.ts.
 */

// Keep in sync with expo-splash-screen `imageWidth` in app.config.ts so the
// JS logo is the exact same size as the native splash logo (no shrink).
const LOGO_SIZE = 288;

// Minimum time the overlay stays fully visible so the wordmark entrance never
// flickers on an instant launch. Small on purpose — perceived speed wins.
const MIN_DISPLAY_MS = 350;
// Hard safety cap: never hold the splash longer than this even if the ready
// signal never fires (e.g. an unexpected error before the root route mounts).
const MAX_DISPLAY_MS = 4000;
// Fade-out duration (was 420ms; shorter = snappier hand-off).
const FADE_OUT_MS = 220;

export default function AnimatedSplash({ onDone }: { onDone: () => void }) {
  // Wordmark: fade + upward slide. The logo does NOT animate (it must match the
  // native splash exactly), so only these drive the entrance.
  const wordOpacity = useSharedValue(0);
  const wordTranslate = useSharedValue(10);
  // Whole-screen fade-out.
  const screenOpacity = useSharedValue(1);

  useEffect(() => {
    const mountedAt = Date.now();
    let dismissed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // 1. Wordmark fades + slides in under the (already-visible) logo. Faster
    // than before (was 560/620ms) so it completes within the minimum window.
    wordOpacity.value = withTiming(1, {
      duration: 300,
      easing: Easing.out(Easing.cubic),
    });
    wordTranslate.value = withTiming(0, {
      duration: 340,
      easing: Easing.out(Easing.cubic),
    });

    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      screenOpacity.value = withTiming(
        0,
        { duration: FADE_OUT_MS, easing: Easing.in(Easing.cubic) },
        (finished) => {
          if (finished) runOnJS(onDone)();
        },
      );
    };

    // 2. Fade out as soon as the app is READY (root route decided), respecting
    // the minimum display window so the brand mark never flickers.
    const unsubscribe = onAppReady(() => {
      const elapsed = Date.now() - mountedAt;
      const wait = Math.max(0, MIN_DISPLAY_MS - elapsed);
      if (wait === 0) {
        dismiss();
      } else {
        timer = setTimeout(dismiss, wait);
      }
    });

    // 3. Hard cap — the splash must never outlive this even if the ready
    // signal is lost.
    const capTimer = setTimeout(dismiss, MAX_DISPLAY_MS);

    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
      clearTimeout(capTimer);
    };
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