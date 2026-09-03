import { memo } from "react";
import { Platform, UIManager, requireNativeComponent } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import { RTCView } from "react-native-webrtc";

/**
 * A self-view renderer that produces *true* rounded corners on Android.
 *
 * The default {@link RTCView} renders through an Android `SurfaceView`, which
 * draws on a separate hardware overlay and therefore ignores the parent's
 * `borderRadius` / `overflow: "hidden"`. The result is the familiar "rounded
 * border inside a square video" artefact on the floating self-preview.
 *
 * On Android we instead use a native `TextureView`-backed view (registered by
 * the `react-native-webrtc` patch in `patches/`). A TextureView is an ordinary
 * view in the hierarchy, so the parent clip applies and the corners are genuinely
 * round. On iOS the stock RTCView already clips correctly, so we just use it.
 *
 * If the native component is unavailable for any reason (e.g. the patch hasn't
 * been applied to a fresh `node_modules`), we transparently fall back to RTCView
 * so the call never breaks — it just keeps the old square corners.
 */
const NATIVE_NAME = "RTCTextureView";

const hasNativeTextureView =
  Platform.OS === "android" &&
  typeof UIManager.getViewManagerConfig === "function" &&
  UIManager.getViewManagerConfig(NATIVE_NAME) != null;

export type RoundedSelfViewProps = {
  streamURL: string;
  mirror?: boolean;
  objectFit?: "contain" | "cover";
  zOrder?: number;
  style?: StyleProp<ViewStyle>;
};

const NativeRTCTextureView = hasNativeTextureView
  ? requireNativeComponent<RoundedSelfViewProps>(NATIVE_NAME)
  : null;

export const RoundedSelfView = memo(function RoundedSelfView({
  streamURL,
  mirror = false,
  objectFit = "cover",
  zOrder = 0,
  style,
}: RoundedSelfViewProps) {
  if (NativeRTCTextureView) {
    return (
      <NativeRTCTextureView
        streamURL={streamURL}
        mirror={mirror}
        objectFit={objectFit}
        zOrder={zOrder}
        style={style}
      />
    );
  }

  return (
    <RTCView
      streamURL={streamURL}
      style={style}
      objectFit={objectFit}
      mirror={mirror}
      zOrder={zOrder}
    />
  );
});
