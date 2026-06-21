// EmojiImage (mobile) — renders a bundled PNG emoji when the generated asset set
// is present, otherwise falls back to the native unicode glyph as <Text>.
// Mirrors client/src/emoji/EmojiImage.tsx.

import { useState } from "react";
import { Image, Text } from "react-native";
import type { EmojiVariant } from "./types";
import { USING_BUNDLED } from "./emojiStore";
import { emojiAsset } from "./assetMap";

export default function EmojiImage({
  variant,
  size = 24,
}: {
  variant: EmojiVariant;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const asset = USING_BUNDLED ? emojiAsset(variant.unified) : null;

  if (!asset || failed) {
    // Native glyph fallback. lineHeight slightly > size keeps tall emoji from
    // being vertically clipped on Android.
    return (
      <Text style={{ fontSize: size, lineHeight: size * 1.15 }}>{variant.native}</Text>
    );
  }

  return (
    <Image
      source={asset}
      style={{ width: size, height: size }}
      onError={() => setFailed(true)}
      resizeMode="contain"
    />
  );
}