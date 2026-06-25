import { useMemo } from "react";
import { Image, StyleSheet, useWindowDimensions, type ImageResizeMode } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  runOnJS,
} from "react-native-reanimated";
import { AuthedImage } from "../AuthedImage";

/**
 * ZoomableImage — Signal-style pinch / pan / double-tap zoomable image used by
 * the full-screen viewers (FilePreview's ImageViewerModal + MediaViewerPager).
 *
 * Gestures (mirrors Signal's MediaPreview):
 *   • Pinch  — scale between 1× and MAX_SCALE around the gesture focal point.
 *   • Pan    — drag the image around ONLY while zoomed in (> 1×).
 *   • Double-tap — toggle between 1× and 2× (springs back to fit at 1×).
 *
 * `onZoomChange(zoomed)` lets a parent pager disable horizontal paging while
 * the image is zoomed so a pan doesn't flip to the next page.
 * `onTap` (single tap) is used by the viewers to dismiss when at 1×.
 *
 * Remote uploads (auth-protected /uploads) render through AuthedImage so the
 * Bearer token is attached; local file:/content:/data: uris use a plain Image.
 */
const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2;

export default function ZoomableImage({
  uri,
  isLocal,
  resizeMode = "contain",
  onZoomChange,
  onTap,
}: {
  uri: string | undefined;
  isLocal: boolean;
  resizeMode?: ImageResizeMode;
  onZoomChange?: (zoomed: boolean) => void;
  onTap?: () => void;
}) {
  const { width, height } = useWindowDimensions();
  const styles = useMemo(() => makeStyles(), []);

  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);

  const notifyZoom = (z: boolean) => onZoomChange?.(z);

  const clampTranslate = () => {
    "worklet";
    // Allowed pan range grows with scale so you can reach the image's edges
    // but not drag it off-screen.
    const maxX = ((scale.value - 1) * width) / 2;
    const maxY = ((scale.value - 1) * height) / 2;
    if (translateX.value > maxX) translateX.value = maxX;
    if (translateX.value < -maxX) translateX.value = -maxX;
    if (translateY.value > maxY) translateY.value = maxY;
    if (translateY.value < -maxY) translateY.value = -maxY;
  };

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.max(1, Math.min(MAX_SCALE, savedScale.value * e.scale));
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      if (scale.value <= 1) {
        scale.value = withTiming(1);
        translateX.value = withTiming(0);
        translateY.value = withTiming(0);
        savedScale.value = 1;
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
        runOnJS(notifyZoom)(false);
      } else {
        clampTranslate();
        savedTranslateX.value = translateX.value;
        savedTranslateY.value = translateY.value;
        runOnJS(notifyZoom)(true);
      }
    });

  const pan = Gesture.Pan()
    .minPointers(1)
    .onUpdate((e) => {
      // Pan only when zoomed in; at 1× let the parent (pager / backdrop) handle.
      if (scale.value <= 1) return;
      translateX.value = savedTranslateX.value + e.translationX;
      translateY.value = savedTranslateY.value + e.translationY;
    })
    .onEnd(() => {
      if (scale.value <= 1) return;
      clampTranslate();
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      if (scale.value > 1) {
        scale.value = withTiming(1);
        translateX.value = withTiming(0);
        translateY.value = withTiming(0);
        savedScale.value = 1;
        savedTranslateX.value = 0;
        savedTranslateY.value = 0;
        runOnJS(notifyZoom)(false);
      } else {
        scale.value = withTiming(DOUBLE_TAP_SCALE);
        savedScale.value = DOUBLE_TAP_SCALE;
        runOnJS(notifyZoom)(true);
      }
    });

  const singleTap = Gesture.Tap()
    .numberOfTaps(1)
    .onEnd(() => {
      if (onTap) runOnJS(onTap)();
    });

  // Double-tap must win over single-tap; pinch + pan run simultaneously.
  const composed = Gesture.Simultaneous(
    pinch,
    pan,
    Gesture.Exclusive(doubleTap, singleTap),
  );

  const animStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));

  return (
    <GestureDetector gesture={composed}>
      <Animated.View style={[styles.container, { width, height }]}>
        <Animated.View style={[styles.imageWrap, animStyle]}>
          {isLocal ? (
            <Image
              source={{ uri }}
              style={styles.image}
              resizeMode={resizeMode}
            />
          ) : (
            <AuthedImage
              uri={uri}
              style={styles.image}
              resizeMode={resizeMode}
            />
          )}
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    container: { alignItems: "center", justifyContent: "center" },
    imageWrap: { width: "100%", height: "100%" },
    image: { width: "100%", height: "100%" },
  });