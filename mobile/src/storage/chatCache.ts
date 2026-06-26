import { storage } from "./mmkv";
import type { ChatMessage, Conversation } from "../features";

/**
 * Synchronous on-device chat cache (MMKV-backed).
 *
 * MMKV reads/writes are synchronous, so the chat UI seeds its initial state
 * directly from here on mount — the thread/list paints instantly (Signal-style)
 * instead of blocking on a full-screen spinner while the network request runs.
 * The network `load()` then reconciles in the background.
 *
 * Exposed as standalone, tree-shakeable functions (no wrapper object). All
 * functions are SYNCHRONOUS so they can seed React state in `useMemo`/`useState`
 * initializers on the very first render — making them async would reintroduce a
 * spinner/flicker and defeat the instant-render behavior.
 *
 * Three caches are kept per the chat UI's needs:
 *   • messages   — the most-recent page per conversation (newest history)
 *   • conversations — the whole conversation list
 *   • readStatus — per-conversation { userId → ISO last_read_at } map, used to
 *     drive the read-receipt tick colour. Caching this is what stops the read
 *     colour from "popping in" a fraction of a second after the chat opens:
 *     without it, messages painted instantly from cache but the receipts were
 *     only known once the async getReadStatus() round-trip resolved, so the
 *     ticks flipped from delivered (muted) → read (accent) on a later frame.
 */
const THREAD_PREFIX = "chat:thread:";
const READ_STATUS_PREFIX = "chat:readstatus:";
const CONVERSATIONS_KEY = "chat:conversations";
const MAX_CACHED_MESSAGES = 50;

/** userId → ISO last_read_at */
export type ReadStatusMap = Record<number, string>;

function readJSON<T>(key: string): T | null {
  const raw = storage.getString(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ── Messages ────────────────────────────────────────────────────────────────

export function getCachedMessages(
  conversationId: number,
): ChatMessage[] | null {
  return readJSON<ChatMessage[]>(`${THREAD_PREFIX}${conversationId}`);
}

export function setCachedMessages(
  conversationId: number,
  messages: ChatMessage[] | undefined,
): void {
  if (!messages) {
    storage.remove(`${THREAD_PREFIX}${conversationId}`);
    return;
  }
  const trimmed = messages.slice(0, MAX_CACHED_MESSAGES);
  storage.set(`${THREAD_PREFIX}${conversationId}`, JSON.stringify(trimmed));
}

export function clearCachedMessages(conversationId: number): void {
  storage.remove(`${THREAD_PREFIX}${conversationId}`);
  storage.remove(`${READ_STATUS_PREFIX}${conversationId}`);
}

// ── Read receipts (userId → ISO last_read_at) ────────────────────────────────

export function getCachedReadStatus(
  conversationId: number,
): ReadStatusMap | null {
  return readJSON<ReadStatusMap>(`${READ_STATUS_PREFIX}${conversationId}`);
}

export function setCachedReadStatus(
  conversationId: number,
  map: ReadStatusMap | undefined,
): void {
  if (!map) {
    storage.remove(`${READ_STATUS_PREFIX}${conversationId}`);
    return;
  }
  storage.set(`${READ_STATUS_PREFIX}${conversationId}`, JSON.stringify(map));
}

// ── Conversation list ────────────────────────────────────────────────────────

export function getCachedConversations(): Conversation[] | null {
  return readJSON<Conversation[]>(CONVERSATIONS_KEY);
}

// ── Whole-cache wipe (sign-out / account switch) ─────────────────────────────

/**
 * Drop EVERY cached chat artifact (conversation list, per-thread messages,
 * read-receipt maps and the per-conversation "delete for me" lists).
 *
 * Critical for multi-tenant correctness: these caches are keyed only by
 * `conversationId`, which is unique only WITHIN a tenant database. If user A
 * (tenant 1) signs out and user B (tenant 2) signs in on the same device, the
 * chat UI seeds its initial state synchronously from this cache — without a
 * wipe it would paint user A's conversation list/messages, and any
 * conversation-id collision across tenants would show tenant 1's messages
 * inside tenant 2's thread. Must be called on logout (see auth/AuthContext).
 */
export function clearAllChatCache(): void {
  // All chat artifacts share the `chat:` key prefix (chat:thread:*,
  // chat:readstatus:*, chat:conversations, chat:localdeletes:*), so a single
  // prefix sweep covers every cache without touching unrelated MMKV keys
  // (e.g. zustand persisted state).
  try {
    for (const key of storage.getAllKeys()) {
      if (key.startsWith("chat:")) storage.remove(key);
    }
  } catch {
    /* best-effort — a failed wipe must not block sign-out */
  }
}

export function setCachedConversations(
  conversations: Conversation[] | undefined,
): void {
  if (!conversations) {
    storage.remove(CONVERSATIONS_KEY);
    return;
  }
  storage.set(CONVERSATIONS_KEY, JSON.stringify(conversations));
}
