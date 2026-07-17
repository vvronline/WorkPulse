import { useEffect, useState } from "react";
import {
  Image,
  type ImageProps,
  type ImageStyle,
  type StyleProp,
} from "react-native";
import { getToken } from "../auth/tokenStore";
import {
  ensureCachedMedia,
  getCachedMedia,
  getCachedMediaSync,
} from "./chat/mediaCache";

interface AuthedImageProps extends Omit<ImageProps, "source" | "style"> {
  /** Absolute URL to a protected upload (served behind Bearer auth). */
  uri: string | null | undefined;
  style?: StyleProp<ImageStyle>;
}

/**
 * AuthedImage — renders a remote image that lives behind the server's
 * `/uploads` auth middleware. The web client gets the JWT for free via an
 * HttpOnly cookie; on mobile we must attach `Authorization: Bearer <jwt>`
 * to the image request or the server returns 401 and the preview stays blank.
 *
 * OFFLINE SUPPORT (WhatsApp parity): the image is cached to a persistent local
 * file the first time it loads (see chat/mediaCache). On every mount we prefer
 * that local copy — so a previously-seen image still renders with NO network.
 * Only when nothing is cached do we stream the remote bytes (with the Bearer
 * header) and warm the cache in the background for next time.
 */
export function AuthedImage({ uri, style, ...rest }: AuthedImageProps) {
  const [token, setToken] = useState<string | null>(null);
  // Local cached file uri — when set, it is used directly (works offline) and
  // needs no auth header. Seed SYNCHRONOUSLY from the in-memory cache so an
  // image already resolved this session paints on the first frame instead of
  // flashing blank while the async disk lookup re-resolves it (see mediaCache
  // getCachedMediaSync — the chat-open smoothness fix for media threads).
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
    // session, paint it immediately and skip the disk/network round-trip.
    const sync = getCachedMediaSync(uri);
    setLocalUri(sync);
    if (sync) return;
    (async () => {
      // 1) Already on disk → use it immediately (no network, works offline).
      const cached = await getCachedMedia(uri);
      if (!active) return;
      if (cached) {
        setLocalUri(cached);
        return;
      }
      // 2) Not cached yet → resolve the token so we can stream it now, and
      //    download a persistent copy in the background for offline use later.
      const t = await getToken();
      if (active) setToken(t);
       // Warm the persistent cache for the next mount, but do not replace the
       // source of an image that has already started streaming remotely. A
       // remote→local source swap forces a second decode and visibly flashes in
       // fullscreen viewers even though both URIs contain identical bytes.
       void ensureCachedMedia(uri);
    })();
    return () => {
      active = false;
    };
  }, [uri]);

  if (!uri) return null;

  // Cached local copy is preferred — renders offline, no header needed.
  if (localUri) {
    return <Image source={{ uri: localUri }} style={style} {...rest} />;
  }

  // Wait for the auth token before issuing the request. Rendering the <Image>
  // before the token resolves fires an unauthenticated GET → the server
  // responds 401 → React Native caches that failure for the URI and keeps the
  // preview blank even after the token later resolves. Gating on the token
  // guarantees the first (and only) request carries the Bearer header.
  if (!token) return null;

  return (
    <Image
      source={{
        uri,
        headers: { Authorization: `Bearer ${token}` },
      }}
      style={style}
      {...rest}
    />
  );
}
