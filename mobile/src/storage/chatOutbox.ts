import { storage } from "./mmkv";

/**
 * Persistent outbox for outgoing chat messages (MMKV-backed, synchronous).
 *
 * WHY (Signal-Android model): Signal writes every outgoing message to its
 * local database FIRST and a MessageSendJob retries delivery whenever
 * connectivity returns — the user can close the conversation, kill the app,
 * or be fully offline and the message is never lost.
 *
 * Previously the mobile app's `send()` only kept the optimistic bubble in
 * React state and fire-and-forgot `socket.send()` (which returns `false`
 * when the WebSocket is closed — i.e. no internet — and that return value
 * was ignored). Result: sending while offline silently dropped the message,
 * and leaving the chat screen cleared it entirely.
 *
 * This outbox fixes both:
 *   • `send()` enqueues here BEFORE attempting the socket send, keyed by the
 *     message's `clientMsgId`.
 *   • The thread screen merges pending outbox entries into its message list
 *     on mount, so an unsent message survives exiting/reopening the chat
 *     (and app restarts).
 *   • `ChatOutboxSync` (mounted once at the app root) flushes the whole
 *     outbox every time the socket (re)connects, re-sending with the SAME
 *     clientMsgId so the server/UI dedupe by clientMsgId prevents dupes.
 *   • Entries are removed when the server echo (`chat_message` carrying the
 *     matching clientMsgId) arrives — i.e. confirmed persisted.
 *
 * All functions are SYNCHRONOUS (MMKV) so the thread screen can merge the
 * outbox into its initial state without a spinner, mirroring chatCache.
 */

const OUTBOX_PREFIX = "chat:outbox:";
const MAX_ATTEMPTS = 30;

export type OutboxMessage = {
  clientMsgId: string;
  conversationId: number;
  content: string;
  replyToId?: number | null;
  // Reply preview fields so the pending bubble can render its quote.
  replyToContent?: string | null;
  replyToSenderName?: string | null;
  replyToFileUrl?: string | null;
  replyToFileType?: string | null;
  replyToFileName?: string | null;
  createdAt: string; // ISO — when the user hit send
  attempts: number;
  failed?: boolean;
  failureReason?: string | null;
};

function keyFor(clientMsgId: string): string {
  return `${OUTBOX_PREFIX}${clientMsgId}`;
}

function readEntry(key: string): OutboxMessage | null {
  const raw = storage.getString(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OutboxMessage;
  } catch {
    return null;
  }
}

/** Add (or refresh) an outgoing message in the persistent outbox. */
export function enqueueOutboxMessage(msg: OutboxMessage): void {
  try {
    storage.set(keyFor(msg.clientMsgId), JSON.stringify(msg));
  } catch {
    /* best-effort — persistence failure must not block the send */
  }
}

/** Remove a message once the server echo confirms it was persisted. */
export function removeOutboxMessage(clientMsgId: string): void {
  storage.remove(keyFor(clientMsgId));
}

export function getOutboxMessage(clientMsgId: string): OutboxMessage | null {
  return readEntry(keyFor(clientMsgId));
}

/** Every pending outbox message, oldest-first (send order). */
export function getAllOutboxMessages(): OutboxMessage[] {
  const out: OutboxMessage[] = [];
  try {
    for (const key of storage.getAllKeys()) {
      if (!key.startsWith(OUTBOX_PREFIX)) continue;
      const entry = readEntry(key);
      if (entry) out.push(entry);
    }
  } catch {
    /* ignore */
  }
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return out;
}

/** Pending outbox messages for one conversation, oldest-first. */
export function getOutboxMessagesForConversation(
  conversationId: number,
): OutboxMessage[] {
  return getAllOutboxMessages().filter(
    (m) => m.conversationId === conversationId,
  );
}

/**
 * Bump the attempt counter for a flush try. Returns the updated entry, or
 * null when the entry no longer exists / exceeded the attempts budget (in
 * which case it is marked failed rather than retried forever).
 */
export function recordOutboxAttempt(
  clientMsgId: string,
): OutboxMessage | null {
  const entry = getOutboxMessage(clientMsgId);
  if (!entry) return null;
  const attempts = (entry.attempts || 0) + 1;
  if (attempts > MAX_ATTEMPTS) {
    markOutboxFailed(clientMsgId, "Could not send message.");
    return null;
  }
  const updated = { ...entry, attempts };
  enqueueOutboxMessage(updated);
  return updated;
}

/** Flag a message as failed (server rejected it) so the UI can offer retry. */
export function markOutboxFailed(
  clientMsgId: string,
  reason?: string | null,
): void {
  const entry = getOutboxMessage(clientMsgId);
  if (!entry) return;
  enqueueOutboxMessage({
    ...entry,
    failed: true,
    failureReason: reason ?? entry.failureReason ?? null,
  });
}

/** Clear a failed flag before a manual retry. */
export function markOutboxRetrying(clientMsgId: string): void {
  const entry = getOutboxMessage(clientMsgId);
  if (!entry) return;
  enqueueOutboxMessage({ ...entry, failed: false, failureReason: null });
}

/** Drop every outbox entry (sign-out / account switch). */
export function clearAllOutboxMessages(): void {
  try {
    for (const key of storage.getAllKeys()) {
      if (key.startsWith(OUTBOX_PREFIX)) storage.remove(key);
    }
  } catch {
    /* best-effort */
  }
}