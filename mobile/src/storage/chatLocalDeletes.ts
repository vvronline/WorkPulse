import { storage } from "./mmkv";
import { scopedChatStorageKey } from "./chatStorageScope";

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

function key(conversationId: number): string | null {
  return scopedChatStorageKey(`${PREFIX}${conversationId}`);
}

export function getLocalDeletedIds(conversationId: number): number[] {
  const storageKey = key(conversationId);
  if (!storageKey) return [];
  const raw = storage.getString(storageKey);
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
  const storageKey = key(conversationId);
  if (storageKey) storage.set(storageKey, JSON.stringify(merged));
  return merged;
}

/**
 * Per-conversation "clear chat for me" cutoff (MMKV-backed, synchronous).
 *
 * Signal's "Clear chat" is a LOCAL, device-only operation — it never touches
 * the other participant's copy. We model it as a cutoff timestamp: every
 * message created at or before this instant is hidden on this device, while
 * NEW messages that arrive afterwards still appear. Storing a cutoff (rather
 * than a list of ids) means messages not yet loaded / fetched via pagination
 * also stay hidden, exactly like Signal.
 */
const CLEARED_PREFIX = "chat:cleared:";

function clearedKey(conversationId: number): string | null {
  return scopedChatStorageKey(`${CLEARED_PREFIX}${conversationId}`);
}

export function getClearedAt(conversationId: number): string | null {
  const storageKey = clearedKey(conversationId);
  return storageKey ? storage.getString(storageKey) ?? null : null;
}

export function setClearedAt(
  conversationId: number,
  iso: string = new Date().toISOString(),
): void {
  const storageKey = clearedKey(conversationId);
  if (storageKey) storage.set(storageKey, iso);
}

/**
 * True when a message (by created_at) falls at or before the conversation's
 * local "clear chat" cutoff and should therefore be hidden on this device.
 */
export function isBeforeClearedAt(
  conversationId: number,
  createdAt?: string | null,
): boolean {
  const cutoff = getClearedAt(conversationId);
  if (!cutoff || !createdAt) return false;
  const c = new Date(createdAt).getTime();
  const t = new Date(cutoff).getTime();
  if (Number.isNaN(c) || Number.isNaN(t)) return false;
  return c <= t;
}
