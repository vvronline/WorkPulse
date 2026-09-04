import { memo, useEffect, useState } from "react";
import { Dimensions, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { RTCView } from "@livekit/react-native-webrtc";
import { RoundedSelfView } from "./RTCTextureView";
import type { CallStyle } from "../../calls/shared/callUiTypes";

const PIP_W = 110;
const PIP_H = 160;
const PIP_MARGIN = 16;
const PIP_BOTTOM_CLEARANCE = 120;
const PIP_RADIUS = 14;

const pipStyles = StyleSheet.create({
  wrap: {
    position: "absolute",
    top: 0,
    left: 0,
    width: PIP_W,
    height: PIP_H,
    backgroundColor: "transparent",
    zIndex: 5,
    elevation: 8,
    // Soft drop shadow so the tile reads as floating above the remote video,
    // matching Signal's self-view.
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  inner: {
    width: "100%",
    height: "100%",
    borderRadius: PIP_RADIUS,
    overflow: "hidden",
    backgroundColor: "#000",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
  },
  surface: {
    flex: 1,
  },
});

export const RemoteVideo = memo(function RemoteVideo(props: {
  url: string;
  style: CallStyle;
}) {
  return (
    <RTCView
      streamURL={props.url}
      style={props.style}
      objectFit="cover"
      mirror={false}
      zOrder={0}
    />
  );
});

export const FullScreenSelfView = memo(function FullScreenSelfView(props: {
  url: string;
  mirror: boolean;
  style: CallStyle;
}) {
  return (
    <RTCView
      streamURL={props.url}
      style={props.style}
      objectFit="cover"
      mirror={props.mirror}
      zOrder={0}
    />
  );
});

const PipSelfView = memo(function PipSelfView(props: {
  url: string;
  mirror: boolean;
  style: CallStyle;
}) {
  // RoundedSelfView renders through a native TextureView on Android (so the
  // parent's rounded clip actually applies to the video) and the regular
  // RTCView on iOS, where it already clips correctly.
  return (
    <RoundedSelfView
      streamURL={props.url}
      style={props.style}
      objectFit="cover"
      mirror={props.mirror}
      zOrder={1}
    />
  );
});

export const DraggablePipSelfView = memo(function DraggablePipSelfView(props: {
  url: string;
  mirror: boolean;
  topInset: number;
  bottomInset: number;
}) {
  const { width: screenW, height: screenH } = Dimensions.get("window");
  const topY = props.topInset + 50;
  const bottomY = screenH - props.bottomInset - PIP_H - PIP_BOTTOM_CLEARANCE;
  const leftX = PIP_MARGIN;
  const rightX = screenW - PIP_W - PIP_MARGIN;

  const translateX = useSharedValue(rightX);
  const translateY = useSharedValue(topY);
  const startX = useSharedValue(rightX);
  const startY = useSharedValue(topY);

  const pan = Gesture.Pan()
    .onStart(() => {
      startX.value = translateX.value;
      startY.value = translateY.value;
    })
    .onUpdate((e) => {
      translateX.value = startX.value + e.translationX;
      translateY.value = startY.value + e.translationY;
    })
    .onEnd(() => {
      const centreX = translateX.value + PIP_W / 2;
      const centreY = translateY.value + PIP_H / 2;
      const snapX = centreX < screenW / 2 ? leftX : rightX;
      const snapY = centreY < screenH / 2 ? topY : bottomY;
      translateX.value = withSpring(snapX, { damping: 18, stiffness: 220 });
      translateY.value = withSpring(snapY, { damping: 18, stiffness: 220 });
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
    ],
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[pipStyles.wrap, animatedStyle]}>
        <View style={pipStyles.inner}>
          <PipSelfView
            url={props.url}
            mirror={props.mirror}
            style={pipStyles.surface}
          />
        </View>
      </Animated.View>
    </GestureDetector>
  );
});

export const CallDuration = memo(function CallDuration(props: {
  active: boolean;
  style: CallStyle;
}) {
  const [duration, setDuration] = useState(0);
  useEffect(() => {
    if (!props.active) return;
    setDuration(0);
    const t = setInterval(() => setDuration((d) => d + 1), 1000);
    return () => clearInterval(t);
  }, [props.active]);
  const m = Math.floor(duration / 60);
  const s = duration % 60;
  return (
    <Text style={props.style}>{`${m}:${String(s).padStart(2, "0")}`}</Text>
  );
});
