import { useEffect, useState } from "react";
import { Image, type ImageProps, type ImageStyle, type StyleProp } from "react-native";
import { getToken } from "../auth/tokenStore";

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
 * The token is resolved once on mount (and whenever the uri changes) so the
 * <Image> can carry it as a request header. Returns null while the token is
 * still resolving or when there is no uri to show.
 */
export function AuthedImage({ uri, style, ...rest }: AuthedImageProps) {
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!uri) {
      setToken(null);
      return;
    }
    (async () => {
      const t = await getToken();
      if (active) setToken(t);
    })();
    return () => {
      active = false;
    };
  }, [uri]);

  if (!uri) return null;

  return (
    <Image
      source={{
        uri,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      }}
      style={style}
      {...rest}
    />
  );
}