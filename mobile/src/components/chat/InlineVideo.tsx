import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { getToken } from "../../auth/tokenStore";

/**
 * Resolve expo-video defensively (same pattern as expo-camera /
 * expo-media-library elsewhere in the chat). A missing native module — Expo Go
 * or a build that predates the package — degrades gracefully instead of
 * crashing the JS bundle: `VIDEO_AVAILABLE` is false and the caller
 * (FilePreview) falls back to a tappable file card.
 */
let ExpoVideo: any = null;
try {
  ExpoVideo = require("expo-video");
} catch {
  ExpoVideo = null;
}

/** True when the native expo-video module is present in this build. */
export const VIDEO_AVAILABLE = !!ExpoVideo?.VideoView;

type VideoSource = { uri: string; headers?: Record<string, string> };

/**
 * Inner player. Split out so `useVideoPlayer` is only ever called with a
 * resolved source (for remote uploads the Bearer token must be attached before
 * the player is created). It is mounted exactly once the source is ready, so
 * the hook is invoked consistently across this component's lifecycle (Rules of
 * Hooks safe).
 */
function VideoPlayerView({
  source,
  style,
  onLongPress,
}: {
  source: VideoSource;
  style?: StyleProp<ViewStyle>;
  onLongPress?: () => void;
}) {
  const player = ExpoVideo.useVideoPlayer(source, (p: any) => {
    // Match a chat video bubble: do not autoplay or loop; the user taps the
    // native play control to start (Signal-style).
    p.loop = false;
    p.muted = false;
  });

  return (
    <Pressable onLongPress={onLongPress} delayLongPress={250}>
      <ExpoVideo.VideoView
        player={player}
        style={style}
        // Inline native transport controls (play/pause/scrub) + the option to
        // expand to full screen, mirroring Signal's in-bubble video player.
        nativeControls
        contentFit="cover"
        allowsFullscreen
        allowsPictureInPicture
      />
    </Pressable>
  );
}

/**
 * InlineVideo — renders a chat video attachment with an inline, tappable
 * player (Signal-style media bubble). Remote uploads live behind the server's
 * `/uploads` Bearer-auth middleware, so the auth token is resolved first and
 * attached as a request header (same requirement as AuthedImage). Local
 * (file:/content:) captures play directly.
 *
 * Returns null when the native module is unavailable — the caller renders a
 * file-card fallback in that case.
 */
export default function InlineVideo({
  uri,
  isLocal,
  style,
  onLongPress,
}: {
  uri: string;
  isLocal: boolean;
  style?: StyleProp<ViewStyle>;
  onLongPress?: () => void;
}) {
  const [source, setSource] = useState<VideoSource | null>(
    isLocal ? { uri } : null,
  );

  useEffect(() => {
    if (isLocal) {
      setSource({ uri });
      return;
    }
    let active = true;
    getToken()
      .then((t) => {
        if (!active) return;
        setSource({
          uri,
          headers: t ? { Authorization: `Bearer ${t}` } : {},
        });
      })
      .catch(() => {
        if (active) setSource({ uri });
      });
    return () => {
      active = false;
    };
  }, [uri, isLocal]);

  if (!VIDEO_AVAILABLE) return null;

  // Wait for the auth token (remote uploads) before creating the player so the
  // first request carries the Bearer header (an unauthenticated GET 401s and is
  // cached blank — same failure mode as images).
  if (!source) {
    return (
      <View style={[styles.placeholder, style]}>
        <ActivityIndicator size="small" color="#fff" />
      </View>
    );
  }

  return (
    <VideoPlayerView source={source} style={style} onLongPress={onLongPress} />
  );
}

const styles = StyleSheet.create({
  placeholder: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#000",
  },
});