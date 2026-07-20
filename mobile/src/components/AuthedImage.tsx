import { useEffect, useMemo, useState } from "react";
import type { StyleProp, ImageStyle as RNImageStyle } from "react-native";
import { Image, type ImageContentFit } from "expo-image";
import { getToken } from "../auth/tokenStore";
import { ensureCachedMedia, getCachedMediaSync } from "./chat/mediaCache";

// Map the legacy react-native `resizeMode` prop (still passed by every existing
// caller — ZoomableImage, ReplyQuote, ReplyPreview, SharedMediaGallery, …) to
// expo-image's `contentFit`, so switching the underlying renderer needs NO
// changes at the call sites.
const RESIZE_MODE_TO_CONTENT_FIT: Record<string, ImageContentFit> = {
  cover: "cover",
  contain: "contain",
  stretch: "fill",
  center: "none",
  repeat: "cover",
  none: "none",
};

interface AuthedImageProps {
  /** Absolute URL to a protected upload (served behind Bearer auth). */
  uri: string | null | undefined;
  style?: StyleProp<RNImageStyle>;
  /** Legacy react-native prop — mapped to expo-image `contentFit`. */
  resizeMode?: "cover" | "contain" | "stretch" | "center" | "repeat" | "none";
  /** Called once the image (or its cached copy) has decoded + painted. */
  onLoad?: () => void;
  /** Called when the image fails to load. */
  onError?: () => void;
  /**
   * Stable identity for the row this image lives in (usually the message
   * file_url). expo-image uses it to recycle the underlying view + bitmap
   * cleanly as FlatList reuses cells, so a recycled row never briefly holds two
   * decoded bitmaps — important for the media-thread scroll memory budget.
   */
  recyclingKey?: string;
}

/**
 * AuthedImage — renders a remote image that lives behind the server's
 * `/uploads` auth middleware. The web client gets the JWT for free via an
 * HttpOnly cookie; on mobile we must attach `Authorization: Bearer <jwt>`
 * to the image request or the server returns 401 and the preview stays blank.
 *
 * PERFORMANCE (chat-scroll jank / freeze / OOM crash fix):
 *   The previous implementation used React Native's built-in <Image>, which
 *   decodes the source at (near) its INTRINSIC pixel size into a native bitmap
 *   regardless of the tiny on-screen box. A single 4032×3024 phone photo is a
 *   ~48 MB decoded bitmap; scrolling back through a media thread kept several of
 *   these mounted at once (FlatList windowSize), which both stalled the frame
 *   (decode cost) and pushed the app past its native memory limit (crash).
 *
 *   expo-image decodes with automatic DOWNSAMPLING to the display size and has a
 *   built-in memory+disk cache that evicts under memory pressure, so only
 *   display-sized bitmaps ever live in memory. This removes the jank AND the
 *   OOM crash without any change at the call sites.
 *
 * OFFLINE SUPPORT (WhatsApp parity): if the image was already downloaded to the
 * persistent media cache (see chat/mediaCache), we render that local file
 * directly (no network, no auth header). Otherwise we stream the remote bytes
 * with the Bearer header; expo-image's own disk cache then serves it offline on
 * subsequent mounts.
 */
export function AuthedImage({
  uri,
  style,
  resizeMode = "cover",
  onLoad,
  onError,
  recyclingKey,
}: AuthedImageProps) {
  const [token, setToken] = useState<string | null>(null);
  // Local cached file uri — when set, it is used directly (works offline) and
  // needs no auth header. Seed SYNCHRONOUSLY from the in-memory cache so an
  // image already resolved this session paints on the first frame.
  const [localUri, setLocalUri] = useState<string | null>(() =>
    getCachedMediaSync(uri),
  );

  useEffect(() => {
    let active = true;
    if (!uri) {
      setToken(null);
      setLocalUri(null);
      return;
    }
    // Re-seed synchronously on uri change: if the file is already known this
    // session, paint it immediately and skip the token round-trip.
    const sync = getCachedMediaSync(uri);
    setLocalUri(sync);
    if (sync) return;
    // Not cached locally → resolve the token so the (single) remote request
    // carries the Bearer header. expo-image's disk cache warms itself from that
    // request, so we no longer need to pre-download a second copy here.
    (async () => {
      const t = await getToken();
      if (active) setToken(t);
    })();
    // Warm the PERSISTENT media cache in the background (WhatsApp-parity offline
    // support). This is a plain byte download — NOT an image decode — so it does
    // not create a large bitmap and cannot cause the scroll jank/OOM the decode
    // path did. It keeps the fullscreen viewer + offline re-open working: those
    // read the local file back via getCachedMediaSync(). Once the file lands we
    // switch this <Image> to render the local copy too (no network, no header).
    ensureCachedMedia(uri)
      .then((local) => {
        if (active && local) setLocalUri(local);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [uri]);

  const contentFit = RESIZE_MODE_TO_CONTENT_FIT[resizeMode] ?? "cover";

  const source = useMemo(() => {
    if (!uri) return null;
    if (localUri) return { uri: localUri };
    if (!token) return null;
    return { uri, headers: { Authorization: `Bearer ${token}` } };
  }, [uri, localUri, token]);

  if (!source) return null;

  return (
    <Image
      source={source}
      style={style}
      contentFit={contentFit}
      // Cap the memory each decoded bitmap can occupy and evict under pressure.
      cachePolicy="memory-disk"
      // Let expo-image downsample large sources to the display box (default,
      // stated explicitly for intent).
      allowDownscaling
      recyclingKey={recyclingKey ?? uri ?? undefined}
      transition={0}
      onLoad={onLoad ? () => onLoad() : undefined}
      onError={onError ? () => onError() : undefined}
    />
  );
}
