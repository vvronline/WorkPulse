// Placeholder asset map — overwritten by scripts/generate-emoji.mjs to a real
// require() map of bundled emoji PNGs (keyed by unified codepoint). Until then
// it resolves nothing, so EmojiImage falls back to the native glyph. Do not
// hand-edit.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const EMOJI_ASSETS: Record<string, any> = {};

export function emojiAsset(unified: string): number | null {
  return EMOJI_ASSETS[unified] ?? null;
}