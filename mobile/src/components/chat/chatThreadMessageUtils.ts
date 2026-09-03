import { normalizeUploadedMessage as normalizeUploadedMessageReducer } from "./chatMessageReducers";
import {
  getOutboxMessagesForConversation,
  type OutboxMessage,
} from "../../storage/chatOutbox";
import type { ChatMessage } from "../../features";

// Keep the first synchronous thread paint bounded. A cached thread can contain
// hundreds of messages after paging; processing all of them on route mount is
// what makes tapping a busy chat freeze on the chat list for 2–3 seconds. Signal
// loads a page first and pages older history on demand, so we mirror that here.
export const INITIAL_THREAD_PAGE_SIZE = 50;

// Skip repaying a full messages/read-receipts/pins reconcile when the same
// conversation is reopened quickly. With single-active route replacement the
// hook remounts on every list→thread open, so per-instance refs cannot remember
// the previous load. This module-level TTL mirrors Signal/WhatsApp's cache-first
// open: show the warm page immediately and avoid doing the same network + state
// reconcile during repeated quick open/exit cycles.
export const THREAD_RECONCILE_TTL_MS = 10_000;
// Bounded LRU. This map is module-level and previously grew without limit —
// every conversation ever opened in the session kept an entry forever. Cap it
// so a long session browsing many chats can't leak.
const THREAD_RECONCILE_MAX_ENTRIES = 50;
const __LAST_THREAD_RECONCILE_AT = new Map<number, number>();

export function rememberThreadReconcile(convId: number, at: number): void {
  // Re-insert so the key moves to the end of the Map's insertion order,
  // making the first key the least-recently-used one.
  __LAST_THREAD_RECONCILE_AT.delete(convId);
  __LAST_THREAD_RECONCILE_AT.set(convId, at);
  while (__LAST_THREAD_RECONCILE_AT.size > THREAD_RECONCILE_MAX_ENTRIES) {
    const oldest = __LAST_THREAD_RECONCILE_AT.keys().next().value;
    if (oldest === undefined) break;
    __LAST_THREAD_RECONCILE_AT.delete(oldest);
  }
}

/** Last reconcile timestamp remembered for a conversation (0 when unknown). */
export function getThreadReconcileAt(convId: number): number {
  return __LAST_THREAD_RECONCILE_AT.get(convId) || 0;
}

/**
 * Normalize the server's file-upload response into a snake_case ChatMessage.
 *
 * ROOT CAUSE of "image stuck on Queued" + "attachment invisible until I reopen
 * the chat": the `POST /chat/conversations/:id/files` endpoint returns a
 * CAMELCASE payload (`fileUrl`, `fileType`, `fileSize`, `mediaState`,
 * `mediaJobId`, …) — but the rest of the mobile app (the ChatMessage type,
 * isImageFile(), FilePreview, and the media-job "delivered" guard) reads
 * SNAKE_CASE (`file_url`, `file_type`, `media_state`, …). Spreading the raw
 * `{ ...data }` therefore produced a message with `fileUrl` but NO `file_url`,
 * so:
 *   • FilePreview rendered nothing (no `file_url`/`file_type`) until the chat
 *     was reloaded (the GET /messages endpoint returns snake_case), and
 *   • the chat_media_job handler's `!!m.file_url` "upload done" guard stayed
 *     false forever, so pipeline `queued`/`processing` events kept dragging the
 *     bubble back to "Queued" even after it was delivered + read.
 *
 * Mapping the camelCase response → snake_case here fixes both at once.
 */
export function normalizeUploadedMessage(data: any): ChatMessage {
  return normalizeUploadedMessageReducer(data);
}

/**
 * Normalize the REST `GET /conversations/:id/messages` response into the
 * canonical snake_case `reply_to_*` shape the mobile app renders from.
 *
 * ROOT CAUSE of "the reply quote flashes the quoted message then collapses to
 * the generic word 'Message'": the mobile app (ReplyQuote, the optimistic-send
 * path and the WS `chat_message` echo) all read the quoted-message fields as
 * `reply_to_content` / `reply_to_sender_name` / `reply_to_file_*`. But the REST
 * messages endpoint returns them aliased as `reply_content` /
 * `reply_sender_name` / `reply_file_*` (kept that way for web parity). So when
 * `load()` refreshed the thread and wholesale-replaced the optimistic/WS rows
 * with the REST payload, `reply_to_content` became undefined and ReplyQuote's
 * `snippet || mediaLabel || "Message"` fallback rendered "Message" — the
 * fraction-of-a-second flicker the user saw.
 *
 * Mapping the REST aliases → the canonical `reply_to_*` here keeps the quote
 * stable across the refresh. Idempotent: already-canonical rows pass through.
 */
export function normalizeFetchedMessage(row: any): ChatMessage {
  if (!row || typeof row !== "object") return row;
  if (!row.reply_to_id) return row as ChatMessage;
  return {
    ...row,
    reply_to_content: row.reply_to_content ?? row.reply_content ?? null,
    reply_to_sender_name:
      row.reply_to_sender_name ?? row.reply_sender_name ?? null,
    reply_to_file_url: row.reply_to_file_url ?? row.reply_file_url ?? null,
    reply_to_file_type: row.reply_to_file_type ?? row.reply_file_type ?? null,
    reply_to_file_name: row.reply_to_file_name ?? row.reply_file_name ?? null,
  } as ChatMessage;
}

/**
 * Render a persisted-but-not-yet-delivered outbox entry as a pending
 * ChatMessage bubble (clock tick). The clientMsgId is carried through so the
 * eventual server echo replaces this bubble in place (no duplicate).
 */
function outboxEntryToMessage(
  entry: OutboxMessage,
  userId: number,
  userName: string,
): ChatMessage {
  return {
    id: -(Date.parse(entry.createdAt) || Date.now()),
    sender_id: userId,
    sender_name: userName,
    content: entry.content,
    created_at: entry.createdAt,
    reply_to_id: entry.replyToId ?? null,
    reply_to_content: entry.replyToContent ?? null,
    reply_to_sender_name: entry.replyToSenderName ?? null,
    reply_to_file_url: entry.replyToFileUrl ?? null,
    reply_to_file_type: entry.replyToFileType ?? null,
    reply_to_file_name: entry.replyToFileName ?? null,
    clientMsgId: entry.clientMsgId,
    _pending: !entry.failed,
    _failed: !!entry.failed,
    _failureReason: entry.failureReason ?? null,
  } as ChatMessage;
}

/**
 * Append this conversation's pending outbox messages (sent while offline,
 * not yet acknowledged by the server) to a message list, deduping by
 * clientMsgId.
 *
 * OFFLINE-SEND FIX: an optimistic message used to live ONLY in React state,
 * so exiting the chat screen (or the server refresh in `load()` wholesale-
 * replacing the list) erased any message that hadn't reached the server yet.
 * Merging the durable outbox here means an unsent message survives leaving
 * the screen, app restarts, and background reconciles — it stays visible as
 * a pending bubble until the reconnect flush (ChatOutboxSync) delivers it.
 */
export function mergeOutboxIntoMessages(
  msgs: ChatMessage[],
  convId: number,
  userId?: number | null,
  userName?: string | null,
): ChatMessage[] {
  if (!userId) return msgs;
  const pending = getOutboxMessagesForConversation(convId);
  if (pending.length === 0) return msgs;
  const have = new Set(
    msgs.map((m) => m.clientMsgId).filter(Boolean) as string[],
  );
  const extra = pending
    .filter((e) => !have.has(e.clientMsgId))
    .map((e) => outboxEntryToMessage(e, userId, userName || "You"));
  if (extra.length === 0) return msgs;
  return [...msgs, ...extra];
}

/**
 * Signal-Android-style lightweight diffing helpers.
 *
 * Signal's conversation adapter updates/invalidates specific paged rows instead
 * of replacing and rebinding the whole thread. In React Native we approximate
 * that by merging the refreshed newest page into already-loaded older history
 * and skipping setMessages entirely when the refreshed page is equivalent.
 */
function reactionsSigForDiff(m: ChatMessage): string {
  const rs = m.reactions || [];
  if (rs.length === 0) return "";
  let s = "";
  for (const r of rs) s += `${r.userId}:${r.emoji},`;
  return s;
}

function messagesEquivalentForThread(a: ChatMessage, b: ChatMessage): boolean {
  return (
    a.id === b.id &&
    a.clientMsgId === b.clientMsgId &&
    a.content === b.content &&
    a.created_at === b.created_at &&
    a.edited_at === b.edited_at &&
    a.deleted_at === b.deleted_at &&
    a.pinned_at === b.pinned_at &&
    a.file_url === b.file_url &&
    a.file_type === b.file_type &&
    a.file_name === b.file_name &&
    a.file_size === b.file_size &&
    a.sender_name === b.sender_name &&
    a.format_type === b.format_type &&
    a.reply_to_id === b.reply_to_id &&
    a.reply_to_content === b.reply_to_content &&
    a.reply_to_sender_name === b.reply_to_sender_name &&
    a.reply_to_file_url === b.reply_to_file_url &&
    a.reply_to_file_type === b.reply_to_file_type &&
    a.reply_to_file_name === b.reply_to_file_name &&
    a.metadata?.viewOnce === b.metadata?.viewOnce &&
    a.metadata?.width === b.metadata?.width &&
    a.metadata?.height === b.metadata?.height &&
    a.metadata?.type === b.metadata?.type &&
    a.metadata?.status === b.metadata?.status &&
    a.metadata?.duration === b.metadata?.duration &&
    deliveredSigForDiff(a) === deliveredSigForDiff(b) &&
    a.media_state === b.media_state &&
    a.media_stage === b.media_stage &&
    a.media_progress === b.media_progress &&
    a._pending === b._pending &&
    a._failed === b._failed &&
    a._mediaState === b._mediaState &&
    a._mediaProgress === b._mediaProgress &&
    reactionsSigForDiff(a) === reactionsSigForDiff(b)
  );
}

function deliveredSigForDiff(message: ChatMessage): string {
  const delivered = message.delivered_to;
  return delivered?.length ? delivered.join(",") : "";
}

export function messageArraysEquivalentForThread(
  a: ChatMessage[],
  b: ChatMessage[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!messagesEquivalentForThread(a[i], b[i])) return false;
  }
  return true;
}

// Shallow-equal two read-receipt maps ({ userId → ISO last_read_at }). Live
// `chat_read_receipt` pulses and each `load()` reconcile otherwise replace the
// `readReceipts` object wholesale — a new identity that (because MessageBubble
// reference-compares `readReceipts`) forces EVERY mounted bubble to re-render.
// Skipping the state update when the map is unchanged keeps that churn off the
// JS thread (Signal only rebinds rows whose receipt state actually changed).
export function readMapsEqual(
  a: Record<number, string>,
  b: Record<number, string>,
): boolean {
  if (a === b) return true;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (a[k as unknown as number] !== b[k as unknown as number]) return false;
  }
  return true;
}

export function mergeNewestPageIntoLoadedThread(
  current: ChatMessage[],
  newestPage: ChatMessage[],
): ChatMessage[] {
  if (current.length === 0) return newestPage;
  // A transient empty refresh must not erase already-loaded history. An empty
  // conversation is handled by explicit clear/delete events; the newest-page
  // reconcile is only allowed to add/update a window it actually received.
  if (newestPage.length === 0) return current;
  if (current.length <= newestPage.length) return newestPage;

  const firstNewest = newestPage[0];
  const firstIdx = current.findIndex((m) => {
    if (firstNewest.clientMsgId && m.clientMsgId === firstNewest.clientMsgId) {
      return true;
    }
    return m.id === firstNewest.id;
  });

  if (firstIdx === 0) return newestPage;
  // No overlap means this response cannot safely identify the boundary between
  // older history and the refreshed tail. Keep the continuous loaded thread;
  // realtime delivery/cache sync will add genuinely new tail rows separately.
  if (firstIdx < 0) return current;

  const olderHistory = current.slice(0, firstIdx);
  const seen = new Set<string>();
  for (const m of newestPage) {
    seen.add(m.clientMsgId ? `c:${m.clientMsgId}` : `i:${m.id}`);
  }

  const localOnlyTail = current.slice(firstIdx).filter((m) => {
    const key = m.clientMsgId ? `c:${m.clientMsgId}` : `i:${m.id}`;
    return (m.id < 0 || m._pending || m._failed) && !seen.has(key);
  });

  return [...olderHistory, ...newestPage, ...localOnlyTail];
}

function messageIdentity(message: ChatMessage): string {
  return message.clientMsgId ? `c:${message.clientMsgId}` : `i:${message.id}`;
}

/** True only when reconciliation adds a server row after the existing tail. */
export function appendsNewerServerTail(
  current: ChatMessage[],
  newestPage: ChatMessage[],
): boolean {
  if (current.length === 0 || newestPage.length === 0) return false;

  const currentKeys = new Set(current.map(messageIdentity));
  let lastOverlapIndex = -1;
  for (let index = 0; index < newestPage.length; index += 1) {
    if (currentKeys.has(messageIdentity(newestPage[index]))) {
      lastOverlapIndex = index;
    }
  }
  if (lastOverlapIndex < 0) return false;

  return newestPage
    .slice(lastOverlapIndex + 1)
    .some((message) => message.id > 0 && !currentKeys.has(messageIdentity(message)));
}
