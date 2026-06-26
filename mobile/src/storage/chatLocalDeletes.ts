import { storage } from "./mmkv";

/**
 * Per-conversation "delete for me" store (MMKV-backed, synchronous).
 *
 * The server only supports "delete for everyone" (and only for your OWN
 * messages). To match WhatsApp/Telegram/Signal we add a local-only
 * "delete for me" that simply HIDES a message on this device. The hidden ids
 * are persisted here so the messages stay hidden across reloads — the chat UI
 * filters them out of the rendered list while keeping the source `messages`
 * array intact for server reconciliation.
 *
 * Only real (positive) server ids are persisted; optimistic/local negative ids
 * are session-only (they never survive a reload anyway).
 */
const PREFIX = "chat:localdeletes:";

function key(conversationId: number): string {
  return `${PREFIX}${conversationId}`;
}

export function getLocalDeletedIds(conversationId: number): number[] {
  const raw = storage.getString(key(conversationId));
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((n) => typeof n === "number") : [];
  } catch {
    return [];
  }
}

export function addLocalDeletedIds(
  conversationId: number,
  ids: number[],
): number[] {
  const keep = ids.filter((n) => Number.isFinite(n) && n > 0);
  if (keep.length === 0) return getLocalDeletedIds(conversationId);
  const merged = Array.from(
    new Set([...getLocalDeletedIds(conversationId), ...keep]),
  );
  storage.set(key(conversationId), JSON.stringify(merged));
  return merged;
}
