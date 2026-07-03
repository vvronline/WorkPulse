/**
 * Global chat-outbox flusher (Signal-Android MessageSendJob parity).
 *
 * Sending a chat message while OFFLINE used to be silently dropped:
 * `socket.send()` returns `false` when the WebSocket is closed, the thread
 * screen ignored that return value, and the optimistic bubble lived only in
 * React state — so leaving the chat screen erased the message entirely.
 *
 * Messages are now persisted to a durable outbox (storage/chatOutbox) the
 * moment the user hits send. This component — mounted ONCE at the app root,
 * alongside ChatCacheSync — is the delivery worker:
 *
 *   • On every socket OPEN transition (initial connect AND every reconnect —
 *     i.e. the moment internet returns) it re-sends every pending outbox
 *     entry with its ORIGINAL clientMsgId. The thread screen and the server
 *     both dedupe by clientMsgId, so retries can never create duplicates.
 *   • When the server echo (`chat_message` carrying a matching clientMsgId)
 *     arrives, the entry is confirmed persisted and removed from the outbox.
 *   • A `chat_message_error` marks the entry failed (surfaced as the red
 *     "failed, tap to retry" state in the thread) instead of retrying a
 *     message the server has explicitly rejected.
 *
 * Because this lives at the root, delivery works even when the chat thread
 * screen is unmounted — exit the chat, background the app, come back online,
 * and the message still sends (mirrors Signal-Android's JobManager, which is
 * independent of any UI).
 */

import { useEffect } from "react";
import { useAuth } from "../auth/AuthContext";
import { socket } from "./socket";
import {
  getAllOutboxMessages,
  markOutboxFailed,
  recordOutboxAttempt,
  removeOutboxMessage,
  type OutboxMessage,
} from "../storage/chatOutbox";

/** Re-send one outbox entry over the socket (same clientMsgId → dedupe-safe). */
function sendOutboxEntry(entry: OutboxMessage): boolean {
  return socket.send("chat_message", {
    conversationId: entry.conversationId,
    content: entry.content,
    clientMsgId: entry.clientMsgId,
    ...(entry.replyToId ? { replyToId: entry.replyToId } : {}),
  });
}

/**
 * Flush every pending (non-failed) outbox message. Exported so the thread
 * screen can also trigger an immediate flush (e.g. right after enqueueing
 * while the socket happens to be up but the first send frame was dropped).
 */
export function flushChatOutbox(): void {
  const pending = getAllOutboxMessages();
  for (const entry of pending) {
    if (entry.failed) continue; // explicit server rejection — manual retry only
    const budgeted = recordOutboxAttempt(entry.clientMsgId);
    if (!budgeted) continue; // exceeded retry budget → marked failed
    sendOutboxEntry(budgeted);
  }
}

export default function ChatOutboxSync() {
  const { user } = useAuth();

  // Flush the outbox on every socket OPEN (initial connect + every reconnect).
  useEffect(() => {
    if (!user) return;
    const off = socket.onOpen(() => {
      // Small defer so the server has finished the connection handshake
      // (auth/subscriptions) before we push queued messages at it.
      setTimeout(() => flushChatOutbox(), 250);
    });
    return off;
  }, [user]);

  // Confirm / fail entries from the realtime stream.
  useEffect(() => {
    if (!user) return;
    const off = socket.subscribe((msg) => {
      const d = msg.data || {};
      // Server echo carrying our clientMsgId → message persisted, outbox done.
      if (msg.type === "chat_message") {
        if (typeof d.clientMsgId === "string" && d.clientMsgId) {
          removeOutboxMessage(d.clientMsgId);
        }
        return;
      }
      // Explicit server rejection → stop auto-retrying, surface as failed.
      if (msg.type === "chat_message_error") {
        if (typeof d.clientMsgId === "string" && d.clientMsgId) {
          markOutboxFailed(
            d.clientMsgId,
            typeof d.reason === "string" ? d.reason : null,
          );
        }
      }
    });
    return off;
  }, [user]);

  return null;
}