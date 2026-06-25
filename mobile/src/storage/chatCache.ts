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
type ReadStatusMap = Record<number, string>;

function readJSON<T>(key: string): T | null {
  const raw = storage.getString(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export const chatCache = {
  // ── Messages ──────────────────────────────────────────────────────────
  getMessages(conversationId: number): ChatMessage[] | null {
    return readJSON<ChatMessage[]>(`${THREAD_PREFIX}${conversationId}`);
  },

  setMessages(conversationId: number, messages: ChatMessage[] | undefined): void {
    if (!messages) {
      storage.remove(`${THREAD_PREFIX}${conversationId}`);
      return;
    }
    const trimmed = messages.slice(0, MAX_CACHED_MESSAGES);
    storage.set(`${THREAD_PREFIX}${conversationId}`, JSON.stringify(trimmed));
  },

  clearMessages(conversationId: number): void {
    storage.remove(`${THREAD_PREFIX}${conversationId}`);
    storage.remove(`${READ_STATUS_PREFIX}${conversationId}`);
  },

  // ── Read receipts (userId → ISO last_read_at) ─────────────────────────
  getReadStatus(conversationId: number): ReadStatusMap | null {
    return readJSON<ReadStatusMap>(`${READ_STATUS_PREFIX}${conversationId}`);
  },

  setReadStatus(conversationId: number, map: ReadStatusMap | undefined): void {
    if (!map) {
      storage.remove(`${READ_STATUS_PREFIX}${conversationId}`);
      return;
    }
    storage.set(`${READ_STATUS_PREFIX}${conversationId}`, JSON.stringify(map));
  },

  // ── Conversation list ─────────────────────────────────────────────────
  getConversations(): Conversation[] | null {
    return readJSON<Conversation[]>(CONVERSATIONS_KEY);
  },

  setConversations(conversations: Conversation[] | undefined): void {
    if (!conversations) {
      storage.remove(CONVERSATIONS_KEY);
      return;
    }
    storage.set(CONVERSATIONS_KEY, JSON.stringify(conversations));
  },
};