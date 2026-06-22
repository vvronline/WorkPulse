// Shared helpers for the Signal-style sectioned emoji grid used by both the
// docked EmojiKeyboard (composer) and the EmojiPicker sheet (reactions/compose).
//
// Signal renders ONE continuously-scrolling grid with sticky section headers
// per category (plus Recents at the top), and a bottom category strip whose
// active icon tracks the scroll position. To express an N-column grid inside a
// SectionList we chunk each category's emoji into rows of `cols` and treat each
// row as a single SectionList item.
//
// See docs/CHAT_DESIGN_SPEC.md §3.

import { CATEGORY_ORDER } from "../../emoji/types";
import type { CategoryMeta, Emoji, EmojiCategory } from "../../emoji/types";
import { emojiByCategory, getRecentEmoji } from "../../emoji/emojiStore";

export interface EmojiRow {
  /** A single grid row (≤ cols emoji). */
  items: Emoji[];
  /** Stable key for the row. */
  key: string;
}

export interface EmojiSection {
  key: EmojiCategory;
  meta: CategoryMeta;
  data: EmojiRow[];
}

function chunk(list: Emoji[], cols: number, catKey: string): EmojiRow[] {
  const rows: EmojiRow[] = [];
  for (let i = 0; i < list.length; i += cols) {
    rows.push({
      items: list.slice(i, i + cols),
      key: `${catKey}-${i}`,
    });
  }
  return rows;
}

/**
 * Build the full ordered section list (Recents first when non-empty, then every
 * populated category) chunked into rows of `cols`.
 */
export function buildEmojiSections(cols: number, recents: Emoji[]): EmojiSection[] {
  const sections: EmojiSection[] = [];
  for (const meta of CATEGORY_ORDER) {
    const list =
      meta.key === "recent" ? recents : emojiByCategory(meta.key);
    if (list.length === 0) continue;
    sections.push({
      key: meta.key,
      meta,
      data: chunk(list, cols, meta.key),
    });
  }
  return sections;
}

/** Convenience to (re)read the recents list synchronously from the store. */
export function currentRecents(): Emoji[] {
  return getRecentEmoji();
}