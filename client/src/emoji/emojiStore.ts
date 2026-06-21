// Emoji store — the single API the picker + renderer use. Prefers the bundled
// image dataset (GENERATED_EMOJI) when available, otherwise the curated
// native-glyph fallback (CURATED_EMOJI). Also owns recents + skin-tone prefs.
//
// See docs/CHAT_DESIGN_SPEC.md §1, §3.

import type { Emoji, EmojiCategory, EmojiVariant } from "./types";
import { CATEGORY_ORDER } from "./types";
import { CURATED_EMOJI } from "./emojiData";
import { GENERATED_EMOJI, HAS_BUNDLED_ASSETS } from "./generated";

const RECENT_KEY = "wp_recent_emojis_v2";
const TONE_KEY = "wp_emoji_skin_tone";
const MAX_RECENT = 36;

// Use the bundled image dataset if the generator produced one; else fall back.
export const USING_BUNDLED = HAS_BUNDLED_ASSETS && GENERATED_EMOJI.length > 0;
export const ALL_EMOJI: Emoji[] = USING_BUNDLED ? GENERATED_EMOJI : CURATED_EMOJI;

// id → Emoji lookup for fast recents resolution.
const BY_ID = new Map<string, Emoji>();
for (const e of ALL_EMOJI) BY_ID.set(e.id, e);

// Group once by category, preserving sort order.
const BY_CATEGORY = new Map<EmojiCategory, Emoji[]>();
for (const meta of CATEGORY_ORDER) BY_CATEGORY.set(meta.key, []);
for (const e of [...ALL_EMOJI].sort((a, b) => a.sortOrder - b.sortOrder)) {
    BY_CATEGORY.get(e.category)?.push(e);
}

export function emojiByCategory(cat: EmojiCategory): Emoji[] {
    return BY_CATEGORY.get(cat) || [];
}

// ── Skin tone preference (0 = default, 1..5 = Fitzpatrick) ───────────────────
export function getSkinTone(): number {
    try {
        const v = parseInt(localStorage.getItem(TONE_KEY) || "0", 10);
        return Number.isFinite(v) && v >= 0 && v <= 5 ? v : 0;
    } catch {
        return 0;
    }
}

export function setSkinTone(tone: number): void {
    try {
        localStorage.setItem(TONE_KEY, String(tone));
    } catch {
        /* ignore */
    }
}

// Resolve the variant to render/insert for a given emoji + tone preference.
export function variantForTone(e: Emoji, tone: number): EmojiVariant {
    if (tone > 0 && e.skins && e.skins[tone - 1]) return e.skins[tone - 1];
    return e.base;
}

// The unicode string to insert into the input for a given emoji + tone.
export function nativeForTone(e: Emoji, tone: number): string {
    return variantForTone(e, tone).native;
}

// ── Recents (most-recent + frequency-weighted) ───────────────────────────────
interface RecentEntry {
    id: string;
    count: number;
    last: number;
}

function readRecents(): RecentEntry[] {
    try {
        const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
        if (Array.isArray(raw)) return raw.filter((r) => r && typeof r.id === "string");
    } catch {
        /* ignore */
    }
    return [];
}

function writeRecents(list: RecentEntry[]): void {
    try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
    } catch {
        /* ignore */
    }
}

export function recordRecent(id: string): void {
    const list = readRecents();
    const idx = list.findIndex((r) => r.id === id);
    if (idx >= 0) {
        list[idx].count += 1;
        list[idx].last = Date.now();
    } else {
        list.push({ id, count: 1, last: Date.now() });
    }
    // Sort by a blended recency + frequency score.
    list.sort((a, b) => b.count * 1e9 + b.last - (a.count * 1e9 + a.last));
    writeRecents(list);
}

export function getRecentEmoji(): Emoji[] {
    return readRecents()
        .map((r) => BY_ID.get(r.id))
        .filter((e): e is Emoji => !!e);
}

// ── Search (name + keywords + id) ────────────────────────────────────────────
export function searchEmoji(query: string): Emoji[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const terms = q.split(/\s+/);
    const scored: { e: Emoji; score: number }[] = [];
    for (const e of ALL_EMOJI) {
        const hay = `${e.id} ${e.name} ${e.keywords.join(" ")}`.toLowerCase();
        let score = 0;
        let all = true;
        for (const t of terms) {
            const i = hay.indexOf(t);
            if (i < 0) {
                all = false;
                break;
            }
            // Earlier/whole-word matches score higher.
            score += i === 0 ? 3 : hay[i - 1] === " " ? 2 : 1;
        }
        if (all) scored.push({ e, score });
    }
    scored.sort((a, b) => b.score - a.score || a.e.sortOrder - b.e.sortOrder);
    return scored.map((s) => s.e);
}