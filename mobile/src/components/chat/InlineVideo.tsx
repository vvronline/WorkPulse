import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Play, X } from "lucide-react-native";
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

/**
 * expo-video-thumbnails is used to generate a static poster frame for the chat
 * bubble (Signal-Android parity: the bubble shows the first frame + a play
 * button, NOT a live player). Resolved defensively so a build without the
 * native module still works (it falls back to a neutral poster background).
 */
let VideoThumbnails: any = null;
try {
  VideoThumbnails = require("expo-video-thumbnails");
} catch {
  VideoThumbnails = null;
}

/** True when the native expo-video module is present in this build. */
export const VIDEO_AVAILABLE = !!ExpoVideo?.VideoView;

type VideoSource = { uri: string; headers?: Record<string, string> };

/** Simple in-memory cache so a bubble doesn't re-generate its poster on every
 *  re-render (the chat list recycles rows frequently). Keyed by source uri. */
const posterCache = new Map<string, { uri: string; width: number; height: number }>();

/** mm:ss duration label from milliseconds. */
function fmtDuration(ms?: number | null): string {
  if (!ms || ms <= 0) return "";
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Fullscreen video player (Signal-style MediaPreview). The ONLY place a live
 * expo-video player is mounted — opened on tap of the bubble poster. Real
 * transport controls (play/pause/scrub) live here via `nativeControls`, and the
 * video autoplays on open.
 */
function FullscreenVideoPlayer({
  source,
  onClose,
}: {
  source: VideoSource;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const player = ExpoVideo.useVideoPlayer(source, (p: any) => {
    p.loop = false;
    p.muted = false;
    // Autoplay on open — the user already tapped to watch.
    try {
      p.play();
    } catch {
      /* ignore */
    }
  });

  return (
    <Modal visible animationType="fade" transparent onRequestClose={onClose}>
      <View style={fsStyles.backdrop}>
        <Pressable
          style={[fsStyles.closeBtn, { top: insets.top + 8 }]}
          onPress={onClose}
          hitSlop={10}
        >
          <X size={22} color="#fff" />
        </Pressable>
        <ExpoVideo.VideoView
          player={player}
          style={fsStyles.video}
          nativeControls
          contentFit="contain"
          allowsFullscreen
          allowsPictureInPicture
        />
      </View>
    </Modal>
  );
}

/**
 * InlineVideo — renders a chat video attachment as a static poster bubble
 * (first-frame thumbnail + centered play button + duration badge), mirroring
 * Signal-Android's message-bubble video. Tapping it opens a fullscreen player
 * with the real transport controls. No live player runs inside the list, which
 * keeps scrolling smooth.
 *
 * Remote uploads live behind the server's `/uploads` Bearer-auth middleware, so
 * the auth token is resolved first and attached as a request header (same
 * requirement as AuthedImage). Local (file:/content:) captures play directly.
 *
 * Returns null when the native expo-video module is unavailable — the caller
 * renders a file-card fallback in that case.
 */
export default function InlineVideo({
  uri,
  isLocal,
  style,
  durationMs,
  onLongPress,
  onPosterSize,
}: {
  uri: string;
  isLocal: boolean;
  style?: StyleProp<ViewStyle>;
  durationMs?: number | null;
  onLongPress?: () => void;
  // Bubbles toward FilePreview so the box can be sized by the real (poster)
  // aspect ratio — fixes portrait videos rendering as wide landscape boxes.
  onPosterSize?: (size: { width: number; height: number }) => void;
}) {
  const [source, setSource] = useState<VideoSource | null>(
    isLocal ? { uri } : null,
  );
  const [poster, setPoster] = useState<string | null>(
    posterCache.get(uri)?.uri ?? null,
  );
  const [open, setOpen] = useState(false);
  const reportedRef = useRef(false);

  // Resolve the source (attach Bearer token for remote uploads).
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

  // Generate the poster frame once (cached). Report its dimensions up so the
  // bubble box can adopt the real aspect ratio.
  useEffect(() => {
    const cached = posterCache.get(uri);
    if (cached) {
      setPoster(cached.uri);
      if (!reportedRef.current) {
        reportedRef.current = true;
        onPosterSize?.({ width: cached.width, height: cached.height });
      }
      return;
    }
    if (!VideoThumbnails || !source) return;
    let active = true;
    (async () => {
      try {
        const headers = source.headers;
        const res = await VideoThumbnails.getThumbnailAsync(
          source.uri,
          // 0ms → first frame (Signal shows the opening frame as the poster).
          headers ? { time: 0, headers } : { time: 0 },
        );
        if (!active || !res?.uri) return;
        const entry = {
          uri: res.uri,
          width: res.width || 0,
          height: res.height || 0,
        };
        posterCache.set(uri, entry);
        setPoster(entry.uri);
        if (entry.width && entry.height && !reportedRef.current) {
          reportedRef.current = true;
          onPosterSize?.({ width: entry.width, height: entry.height });
        }
      } catch {
        /* poster generation failed — fall back to the neutral background */
      }
    })();
    return () => {
      active = false;
    };
  }, [uri, source, onPosterSize]);

  if (!VIDEO_AVAILABLE) return null;

  if (!source) {
    return (
      <View style={[styles.placeholder, style]}>
        <ActivityIndicator size="small" color="#fff" />
      </View>
    );
  }

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        onLongPress={onLongPress}
        delayLongPress={250}
        style={[styles.wrap, style]}
      >
        {poster ? (
          <Image source={{ uri: poster }} style={styles.poster} resizeMode="cover" />
        ) : (
          <View style={styles.posterFallback}>
            <ActivityIndicator size="small" color="rgba(255,255,255,0.7)" />
          </View>
        )}
        {/* Dark scrim so the play button + duration read on any frame. */}
        <View style={styles.scrim} pointerEvents="none" />
        <View style={styles.playButton} pointerEvents="none">
          <Play size={26} color="#fff" fill="#fff" />
        </View>
        {durationMs ? (
          <View style={styles.durationBadge} pointerEvents="none">
            <Text style={styles.durationText}>{fmtDuration(durationMs)}</Text>
          </View>
        ) : null}
      </Pressable>
      {open ? (
        <FullscreenVideoPlayer source={source} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  wrap: {
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#000",
  },
  poster: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: "100%",
    height: "100%",
  },
  posterFallback: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#1a1a1a",
  },
  scrim: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.12)",
  },
  playButton: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
    // Nudge the triangle so it reads as centered.
    paddingLeft: 3,
  },
  durationBadge: {
    position: "absolute",
    bottom: 8,
    right: 8,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  durationText: { color: "#fff", fontSize: 11, fontWeight: "600" },
  placeholder: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#000",
  },
});

const fsStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "#000",
    alignItems: "center",
    justifyContent: "center",
  },
  video: { width: "100%", height: "100%" },
  closeBtn: {
    position: "absolute",
    right: 20,
    zIndex: 2,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
});