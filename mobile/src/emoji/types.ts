// Shared emoji type definitions — mirrored from client/src/emoji/types.ts.
// See docs/CHAT_DESIGN_SPEC.md §1.

export type EmojiCategory =
  | "recent"
  | "smileys"
  | "people"
  | "nature"
  | "food"
  | "activity"
  | "travel"
  | "objects"
  | "symbols"
  | "flags";

export interface EmojiVariant {
  unified: string;
  native: string;
  sheetX: number;
  sheetY: number;
  image: string; // png filename (mobile bundled asset)
}

export interface Emoji {
  id: string;
  name: string;
  native: string;
  keywords: string[];
  category: EmojiCategory;
  sortOrder: number;
  base: EmojiVariant;
  skins?: EmojiVariant[];
}

export interface CategoryMeta {
  key: EmojiCategory;
  label: string;
  icon: string;
}

export const CATEGORY_ORDER: CategoryMeta[] = [
  { key: "recent", label: "Recent", icon: "🕐" },
  { key: "smileys", label: "Smileys & Emotion", icon: "😀" },
  { key: "people", label: "People & Body", icon: "👋" },
  { key: "nature", label: "Animals & Nature", icon: "🐶" },
  { key: "food", label: "Food & Drink", icon: "🍕" },
  { key: "activity", label: "Activities", icon: "⚽" },
  { key: "travel", label: "Travel & Places", icon: "✈️" },
  { key: "objects", label: "Objects", icon: "💡" },
  { key: "symbols", label: "Symbols", icon: "❤️" },
  { key: "flags", label: "Flags", icon: "🏳️" },
];

export const SKIN_TONES = [
  { key: 0, label: "Default", swatch: "✋" },
  { key: 1, label: "Light", swatch: "✋🏻" },
  { key: 2, label: "Medium-Light", swatch: "✋🏼" },
  { key: 3, label: "Medium", swatch: "✋🏽" },
  { key: 4, label: "Medium-Dark", swatch: "✋🏾" },
  { key: 5, label: "Dark", swatch: "✋🏿" },
];