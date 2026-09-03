/**
 * Per-conversation "clear chat for me" cutoff (localStorage-backed).
 *
 * Signal/WhatsApp "Clear chat" is a LOCAL, device-only operation — it never
 * touches the other participant's copy. We model it as a cutoff timestamp:
 * every message created at or before this instant is hidden on this device,
 * while NEW messages that arrive afterwards still appear. Storing a cutoff
 * (rather than a list of ids) means messages not yet loaded via pagination
 * also stay hidden, and the clear survives reloads.
 *
 * Mirrors the mobile implementation in
 * `mobile/src/storage/chatLocalDeletes.ts`.
 */
const CLEARED_PREFIX = "chat:cleared:";
const HIDDEN_MESSAGES_PREFIX = "chat:hidden-messages:";

function clearedKey(conversationId: number | string): string {
  return `${CLEARED_PREFIX}${conversationId}`;
}

export function getClearedAt(conversationId: number | string): string | null {
  try {
    return localStorage.getItem(clearedKey(conversationId));
  } catch {
    return null;
  }
}

export function setClearedAt(
  conversationId: number | string,
  iso: string = new Date().toISOString(),
): void {
  try {
    localStorage.setItem(clearedKey(conversationId), iso);
  } catch {
    // ignore storage failures (private mode / quota)
  }
}

/**
 * True when a message (by created_at) falls at or before the conversation's
 * local "clear chat" cutoff and should therefore be hidden on this device.
 */
function hiddenMessagesKey(conversationId: number | string): string {
  return `${HIDDEN_MESSAGES_PREFIX}${conversationId}`;
}

export function getHiddenMessageIds(
  conversationId: number | string,
): Set<string> {
  try {
    const raw = localStorage.getItem(hiddenMessagesKey(conversationId));
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return new Set();
  }
}

export function hideMessagesForMe(
  conversationId: number | string,
  messageIds: Array<number | string>,
): void {
  const hidden = getHiddenMessageIds(conversationId);
  messageIds.forEach((id) => hidden.add(String(id)));
  try {
    localStorage.setItem(
      hiddenMessagesKey(conversationId),
      JSON.stringify([...hidden]),
    );
  } catch {
    // ignore storage failures (private mode / quota)
  }
}

export function isMessageHiddenForMe(
  conversationId: number | string | null | undefined,
  messageId: number | string | null | undefined,
): boolean {
  if (conversationId == null || messageId == null) return false;
  return getHiddenMessageIds(conversationId).has(String(messageId));
}

export function isBeforeClearedAt(
  conversationId: number | string | null | undefined,
  createdAt?: string | null,
): boolean {
  if (conversationId == null || !createdAt) return false;
  const cutoff = getClearedAt(conversationId);
  if (!cutoff) return false;
  const c = new Date(createdAt).getTime();
  const t = new Date(cutoff).getTime();
  if (Number.isNaN(c) || Number.isNaN(t)) return false;
  return c <= t;
}
