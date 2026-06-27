// Emoji store (mobile) — mirrors client/src/emoji/emojiStore.ts. Prefers the
// bundled image dataset when generated, else the curated native-glyph fallback.
// Recents + skin-tone preference persist to SecureStore via an in-memory cache
// that is hydrated once at startup (so the picker can read them synchronously).

import * as SecureStore from "expo-secure-store";
import type { Emoji, EmojiCategory, EmojiVariant } from "./types";
import { CATEGORY_ORDER } from "./types";
import { CURATED_EMOJI } from "./emojiData";
import { GENERATED_EMOJI, HAS_BUNDLED_ASSETS } from "./generated";

const RECENT_KEY = "wp_recent_emojis_v2";
const TONE_KEY = "wp_emoji_skin_tone";
const MAX_RECENT = 36;

export const USING_BUNDLED = HAS_BUNDLED_ASSETS && GENERATED_EMOJI.length > 0;
export const ALL_EMOJI: Emoji[] = USING_BUNDLED
  ? GENERATED_EMOJI
  : CURATED_EMOJI;

const BY_ID = new Map<string, Emoji>();
for (const e of ALL_EMOJI) BY_ID.set(e.id, e);

const BY_CATEGORY = new Map<EmojiCategory, Emoji[]>();
for (const meta of CATEGORY_ORDER) BY_CATEGORY.set(meta.key, []);
for (const e of [...ALL_EMOJI].sort((a, b) => a.sortOrder - b.sortOrder)) {
  BY_CATEGORY.get(e.category)?.push(e);
}

export function emojiByCategory(cat: EmojiCategory): Emoji[] {
  return BY_CATEGORY.get(cat) || [];
}

// ── In-memory cache (hydrated from SecureStore at startup) ───────────────────
interface RecentEntry {
  id: string;
  count: number;
  last: number;
}

let recentsCache: RecentEntry[] = [];
let toneCache = 0;
let hydrated = false;

/** Hydrate the in-memory caches from SecureStore. Call once at app startup. */
export async function hydrateEmojiStore(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = await SecureStore.getItemAsync(RECENT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        recentsCache = parsed.filter((r) => r && typeof r.id === "string");
      }
    }
  } catch {
    /* ignore */
  }
  try {
    const t = await SecureStore.getItemAsync(TONE_KEY);
    const v = t ? parseInt(t, 10) : 0;
    if (Number.isFinite(v) && v >= 0 && v <= 5) toneCache = v;
  } catch {
    /* ignore */
  }
}

function persistRecents(): void {
  SecureStore.setItemAsync(
    RECENT_KEY,
    JSON.stringify(recentsCache.slice(0, MAX_RECENT)),
  ).catch(() => {});
}

// ── Skin tone ────────────────────────────────────────────────────────────────
export function getSkinTone(): number {
  return toneCache;
}

export function setSkinTone(tone: number): void {
  toneCache = tone;
  SecureStore.setItemAsync(TONE_KEY, String(tone)).catch(() => {});
}

export function variantForTone(e: Emoji, tone: number): EmojiVariant {
  if (tone > 0 && e.skins && e.skins[tone - 1]) return e.skins[tone - 1];
  return e.base;
}

export function nativeForTone(e: Emoji, tone: number): string {
  return variantForTone(e, tone).native;
}

// ── Recents ──────────────────────────────────────────────────────────────────
export function recordRecent(id: string): void {
  const idx = recentsCache.findIndex((r) => r.id === id);
  if (idx >= 0) {
    recentsCache[idx].count += 1;
    recentsCache[idx].last = Date.now();
  } else {
    recentsCache.push({ id, count: 1, last: Date.now() });
  }
  recentsCache.sort(
    (a, b) => b.count * 1e9 + b.last - (a.count * 1e9 + a.last),
  );
  recentsCache = recentsCache.slice(0, MAX_RECENT);
  persistRecents();
}

export function getRecentEmoji(): Emoji[] {
  return recentsCache
    .map((r) => BY_ID.get(r.id))
    .filter((e): e is Emoji => !!e);
}

// ── Search ───────────────────────────────────────────────────────────────────
interface SearchEntry {
  e: Emoji;
  tokens: string[]; // individual searchable tokens (lowercase)
  hay: string; // full joined haystack for substring fallback
}

// Pre-built at module load (once). For each emoji, extract tokens from:
// - id split on _, -, spaces
// - each keyword
// - each word of the lowercased name
const SEARCH_INDEX: SearchEntry[] = ALL_EMOJI.map((e) => {
  const idTokens = e.id
    .toLowerCase()
    .split(/[-_\s]+/)
    .filter(Boolean);
  const nameTokens = e.name.toLowerCase().split(/\s+/).filter(Boolean);
  const kwTokens = e.keywords.map((k) => k.toLowerCase());
  const tokens = Array.from(new Set([...idTokens, ...nameTokens, ...kwTokens]));
  const hay = tokens.join(" ");
  return { e, tokens, hay };
});

export function searchEmoji(query: string): Emoji[] {
  // Strip leading/trailing colons (":thumbsup:" → "thumbsup")
  const q = query
    .trim()
    .toLowerCase()
    .replace(/^:(.+):$/, "$1");
  if (!q) return [];

  const terms = q.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const scored: { e: Emoji; score: number }[] = [];

  for (const { e, tokens, hay } of SEARCH_INDEX) {
    let totalScore = 0;
    let allMatch = true;

    for (const term of terms) {
      let termScore = 0;

      // Score against each pre-computed token:
      //   4 — exact match, 3 — prefix, 2 — substring within token
      for (const token of tokens) {
        if (token === term) {
          termScore = Math.max(termScore, 4); // exact token match
          break;
        } else if (token.startsWith(term)) {
          termScore = Math.max(termScore, 3); // prefix of a token
        } else if (token.includes(term)) {
          termScore = Math.max(termScore, 2); // substring within a token
        }
      }

      // Fallback: substring anywhere in the full haystack
      if (termScore === 0) {
        if (hay.includes(term)) {
          termScore = 1;
        } else {
          allMatch = false;
          break;
        }
      }

      totalScore += termScore;
    }

    if (allMatch && totalScore > 0) {
      scored.push({ e, score: totalScore });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.e.sortOrder - b.e.sortOrder);
  return scored.map((s) => s.e);
}
