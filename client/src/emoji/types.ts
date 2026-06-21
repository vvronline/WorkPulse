// Shared emoji type definitions — mirrored in mobile/src/emoji/types.ts.
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
    unified: string; // "1F44D-1F3FB"
    native: string; // "👍🏻"
    sheetX: number; // sprite column (web)
    sheetY: number; // sprite row (web)
    image: string; // png filename (mobile)
}

export interface Emoji {
    id: string; // "thumbsup"
    name: string; // "Thumbs Up Sign"
    native: string; // "👍"
    keywords: string[]; // ["+1", "approve", "ok", "yes"]
    category: EmojiCategory;
    sortOrder: number;
    base: EmojiVariant;
    skins?: EmojiVariant[]; // 5 Fitzpatrick tones when supported
}

// Ordered category metadata for the picker's sticky tab bar.
export interface CategoryMeta {
    key: EmojiCategory;
    label: string; // accessible name
    icon: string; // representative emoji shown on the tab
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

// The 5 Fitzpatrick skin-tone modifiers, in dataset order.
export const SKIN_TONES = [
    { key: 0, label: "Default", swatch: "✋" },
    { key: 1, label: "Light", swatch: "✋🏻" },
    { key: 2, label: "Medium-Light", swatch: "✋🏼" },
    { key: 3, label: "Medium", swatch: "✋🏽" },
    { key: 4, label: "Medium-Dark", swatch: "✋🏾" },
    { key: 5, label: "Dark", swatch: "✋🏿" },
];