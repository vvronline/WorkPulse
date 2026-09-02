import type { AnyRecord } from "../../types";

export type ChatMessage = AnyRecord & { id: number | string };

let fallbackCounter = 0;

/**
 * Creates an idempotency key that remains unique across chat remounts.
 *
 * The server stores this value and uses it to safely de-duplicate reconnect
 * retries. Keep the `pending_` prefix because the message UI uses it to render
 * the sending state.
 */
export function createPendingMessageId(): string {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return `pending_${globalThis.crypto.randomUUID()}`;
  }

  fallbackCounter = (fallbackCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `pending_${Date.now().toString(36)}_${fallbackCounter.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Reconciles a server echo with the local optimistic bubble.
 *
 * Matching by clientMsgId must happen before de-duplicating by the persisted
 * server id. A reconnect retry can legitimately echo a row that is already in
 * loaded history; checking the server id first would leave the optimistic
 * bubble stuck in "Sending".
 */
export function reconcileOwnMessage(
  messages: ChatMessage[],
  incoming: AnyRecord,
  mapped: ChatMessage,
): ChatMessage[] {
  const clientMsgId =
    typeof incoming.clientMsgId === "string" ? incoming.clientMsgId : undefined;

  const pendingIndex = clientMsgId
    ? messages.findIndex((message) => message.id === clientMsgId)
    : messages.findIndex(
        (message) =>
          String(message.id).startsWith("pending_") &&
          message.content === incoming.content,
      );

  if (pendingIndex >= 0) {
    const canonicalIndex = messages.findIndex(
      (message, index) => index !== pendingIndex && message.id === incoming.id,
    );
    const next = [...messages];

    if (canonicalIndex >= 0) {
      // The canonical row was loaded while this retry was in flight.
      // Remove only the stale optimistic bubble.
      next.splice(pendingIndex, 1);
      return next;
    }

    next[pendingIndex] = mapped;
    return next;
  }

  if (messages.some((message) => message.id === incoming.id)) {
    return messages;
  }

  return [...messages, mapped];
}
