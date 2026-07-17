import { storage } from "./mmkv";
import type { ChatMessage, Conversation } from "../features";
import {
  activeChatStoragePrefix,
  scopedChatStorageKey,
} from "./chatStorageScope";

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

function readJSON<T>(key: string | null): T | null {
  if (!key) return null;
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
  return readJSON<ChatMessage[]>(
    scopedChatStorageKey(`${THREAD_PREFIX}${conversationId}`),
  );
}

export function setCachedMessages(
  conversationId: number,
  messages: ChatMessage[] | undefined,
): void {
  const key = scopedChatStorageKey(`${THREAD_PREFIX}${conversationId}`);
  if (!key) return;
  if (!messages) {
    storage.remove(key);
    return;
  }
  // Messages are stored OLDEST-FIRST (mirrors GET /messages). Keep the NEWEST
  // page when trimming — slice from the END. (The previous `slice(0, MAX)`
  // kept the oldest 50 and silently dropped the newest messages whenever the
  // array grew past the cap, so a reopened chat painted stale history.)
  const trimmed =
    messages.length > MAX_CACHED_MESSAGES
      ? messages.slice(messages.length - MAX_CACHED_MESSAGES)
      : messages;
  storage.set(key, JSON.stringify(trimmed));
}

/**
 * Append a single freshly-arrived message to a conversation's cached page.
 *
 * Called from the live `chat_message` WS handler (chat list screen) so the
 * on-disk cache stays CURRENT even while the thread screen isn't mounted —
 * previously the cache was only rewritten by the thread's own network load,
 * so opening a chat right after a message arrived painted a stale page and
 * the new message only appeared after the background refresh ("takes time to
 * show the messages"). Dedupes by id/clientMsgId; no-op when the thread has
 * never been cached (the thread's own load will seed it).
 */
export function appendCachedMessage(
  conversationId: number,
  message: ChatMessage,
): void {
  const existing = getCachedMessages(conversationId);
  if (!existing) return; // cold cache — let the thread's load() seed it
  const dupe = existing.some(
    (m) =>
      (message.id != null && m.id === message.id) ||
      (message.clientMsgId != null && m.clientMsgId === message.clientMsgId),
  );
  if (dupe) return;
  setCachedMessages(conversationId, [...existing, message]);
}

/**
 * Apply a realtime mutation to one cached message without requiring the thread
 * screen to be mounted. Returns false when the conversation/message is not
 * cached, allowing callers to remain best-effort.
 */
export function updateCachedMessage(
  conversationId: number,
  messageId: number | string,
  update: (message: ChatMessage) => ChatMessage,
): boolean {
  const existing = getCachedMessages(conversationId);
  if (!existing) return false;
  const index = existing.findIndex(
    (message) => String(message.id) === String(messageId),
  );
  if (index < 0) return false;

  const next = [...existing];
  next[index] = update(existing[index]);
  setCachedMessages(conversationId, next);
  return true;
}

export function clearCachedMessages(conversationId: number): void {
  const threadKey = scopedChatStorageKey(`${THREAD_PREFIX}${conversationId}`);
  const readStatusKey = scopedChatStorageKey(
    `${READ_STATUS_PREFIX}${conversationId}`,
  );
  if (threadKey) storage.remove(threadKey);
  if (readStatusKey) storage.remove(readStatusKey);
}

// ── Read receipts (userId → ISO last_read_at) ────────────────────────────────

export function getCachedReadStatus(
  conversationId: number,
): ReadStatusMap | null {
  return readJSON<ReadStatusMap>(
    scopedChatStorageKey(`${READ_STATUS_PREFIX}${conversationId}`),
  );
}

export function setCachedReadStatus(
  conversationId: number,
  map: ReadStatusMap | undefined,
): void {
  const key = scopedChatStorageKey(`${READ_STATUS_PREFIX}${conversationId}`);
  if (!key) return;
  if (!map) {
    storage.remove(key);
    return;
  }
  storage.set(key, JSON.stringify(map));
}

// ── Conversation list ────────────────────────────────────────────────────────

export function getCachedConversations(): Conversation[] | null {
  return readJSON<Conversation[]>(scopedChatStorageKey(CONVERSATIONS_KEY));
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
  // A scoped sweep removes only the departing identity's chat artifacts and
  // leaves another currently-active account's namespace untouched.
  const prefix = activeChatStoragePrefix();
  if (!prefix) return;
  try {
    for (const key of storage.getAllKeys()) {
      if (key.startsWith(prefix)) storage.remove(key);
    }
  } catch {
    /* best-effort — a failed wipe must not block sign-out */
  }
}

export function setCachedConversations(
  conversations: Conversation[] | undefined,
): void {
  const key = scopedChatStorageKey(CONVERSATIONS_KEY);
  if (!key) return;
  if (!conversations) {
    storage.remove(key);
    return;
  }
  storage.set(key, JSON.stringify(conversations));
}
