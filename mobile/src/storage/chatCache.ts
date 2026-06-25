import { mmkvJson } from "./mmkv";
import type { ChatMessage, Conversation } from "../features";

/**
 * On-device chat cache (Signal-style instant render).
 *
 * The chat thread and conversation list read from this cache SYNCHRONOUSLY on
 * mount so the UI paints immediately with the last-known data, then refresh
 * from the network in the background. This eliminates the full-screen spinner
 * that previously blocked every chat open.
 *
 * Only a bounded number of recent messages are persisted per conversation to
 * keep the cache small and writes fast.
 */

const CONVERSATIONS_KEY = "chat:conversations";
const messagesKey = (convId: number) => `chat:messages:${convId}`;

// Cap how many messages we persist per conversation. The thread loads a 50-row
// page from the server anyway; persisting the most recent ~80 covers the
// initial view plus a little scrollback without bloating storage.
const MAX_CACHED_MESSAGES = 80;

export const chatCache = {
  /** Read the cached conversation list (null on cold cache). */
  getConversations(): Conversation[] | null {
    return mmkvJson.get<Conversation[]>(CONVERSATIONS_KEY);
  },

  /** Persist the conversation list. */
  setConversations(conversations: Conversation[]): void {
    mmkvJson.set(CONVERSATIONS_KEY, conversations);
  },

  /** Read the cached message page for a conversation (null on cold cache). */
  getMessages(convId: number): ChatMessage[] | null {
    if (!Number.isFinite(convId)) return null;
    return mmkvJson.get<ChatMessage[]>(messagesKey(convId));
  },

  /**
   * Persist the most recent messages for a conversation. Drops optimistic
   * (negative-id / pending) rows and trims to MAX_CACHED_MESSAGES so only
   * confirmed, server-assigned messages are cached.
   */
  setMessages(convId: number, messages: ChatMessage[]): void {
    if (!Number.isFinite(convId)) return;
    const confirmed = messages.filter(
      (m) => Number(m.id) > 0 && !m._pending && !m._failed,
    );
    const trimmed =
      confirmed.length > MAX_CACHED_MESSAGES
        ? confirmed.slice(confirmed.length - MAX_CACHED_MESSAGES)
        : confirmed;
    mmkvJson.set(messagesKey(convId), trimmed);
  },

  /** Drop a conversation's cached messages (e.g. after Clear Chat). */
  clearMessages(convId: number): void {
    if (!Number.isFinite(convId)) return;
    mmkvJson.remove(messagesKey(convId));
  },
};