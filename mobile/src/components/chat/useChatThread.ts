import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BackHandler,
  InteractionManager,
  Keyboard,
  Vibration,
  View,
  type FlatList,
  type TextInput,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Clipboard from "expo-clipboard";
import * as SecureStore from "expo-secure-store";
import {
  AudioModule,
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
} from "expo-audio";
import type { VoiceRecorderControllerHandle } from "./VoiceRecorderController";
import { getNotificationPreviewDataUri } from "../../utils/notificationSoundPreview";
import { useAuth } from "../../auth/AuthContext";
import { useDialog } from "../../hooks/useDialog";
import {
  ackDelivered,
  blockUser,
  unblockUser,
  cancelChatMediaJob,
  createMeeting,
  deleteMessage,
  editMessage,
  forwardMessage,
  getConversations,
  getChatPresence,
  getMessages,
  getPinnedMessages,
  getReadStatus,
  getSharedFiles,
  getStarredMessages,
  markConversationRead,
  pinMessage,
  retryChatMediaJob,
  searchMessages,
  starMessage,
  toggleReaction,
  uploadChatFile,
  type ChatMessage,
  type Conversation,
  type MessageSearchResult,
  type PinnedMessage,
  type SharedFile,
  type StarredMessage,
} from "../../features";
import { socket } from "../../realtime/socket";
import { notifeeService } from "../../services/notifeeService";
import { setActiveConversation } from "../../realtime/activeConversation";
import {
  emitChatUnreadChanged,
  chatUnreadManager,
} from "../../realtime/chatUnreadEvents";
import {
  subscribeChatJump,
  consumePendingChatJump,
} from "../../realtime/chatJumpEvents";
import { useKeyboardInset } from "../../hooks/useKeyboardInset";
import { hydrateEmojiStore } from "../../emoji/emojiStore";
import {
  getCachedMessages,
  setCachedMessages,
  clearCachedMessages,
  getCachedReadStatus,
  setCachedReadStatus,
  getCachedConversations,
} from "../../storage/chatCache";
import {
  getLocalDeletedIds,
  addLocalDeletedIds,
  setClearedAt,
  getClearedAt,
} from "../../storage/chatLocalDeletes";
import {
  enqueueOutboxMessage,
  getOutboxMessagesForConversation,
  markOutboxRetrying,
  removeOutboxMessage,
  type OutboxMessage,
} from "../../storage/chatOutbox";
import { STATUS_LABEL, isSameDay, type HeaderSheet } from "./chatUtils";

type PendingMediaSource = {
  uri: string;
  fileName: string;
  mimeType?: string;
  viewOnce?: boolean;
  caption?: string;
  // Intrinsic image dimensions (Signal-style aspect-ratio sizing).
  width?: number;
  height?: number;
};

type ConversationDraft = {
  text: string;
  replyTo?: {
    id: number;
    content?: string | null;
    sender_name?: string | null;
  } | null;
  editing?: { id: number; text?: string | null } | null;
  mediaDrafts: PendingMediaSource[];
};

// Keep the first synchronous thread paint bounded. A cached thread can contain
// hundreds of messages after paging; processing all of them on route mount is
// what makes tapping a busy chat freeze on the chat list for 2–3 seconds. Signal
// loads a page first and pages older history on demand, so we mirror that here.
const INITIAL_THREAD_PAGE_SIZE = 50;

// Hard upper bound on how many messages stay MOUNTED in React state for a
// single thread. A long-lived thread (left open while messages keep arriving,
// or after paging up a lot) otherwise grows this array without limit — every
// `messagesReversed` recompute, grouping pass and FlatList extraData diff then
// scales with total history, and the heap climbs for as long as the thread is
// alive. Signal keeps a bounded sliding window of rows in memory and pages the
// rest from disk. We cap the NEWEST-message (append) growth here; older history
// is still reachable via `loadOlder` (cursor pagination) / the on-disk cache,
// which re-fetches when the user scrolls back up. Chosen comfortably above a
// full screen of bubbles so trimming is never visible at the bottom.
const MAX_MOUNTED_MESSAGES = 200;

// Skip repaying a full messages/read-receipts/pins reconcile when the same
// conversation is reopened quickly. With single-active route replacement the
// hook remounts on every list→thread open, so per-instance refs cannot remember
// the previous load. This module-level TTL mirrors Signal/WhatsApp's cache-first
// open: show the warm page immediately and avoid doing the same network + state
// reconcile during repeated quick open/exit cycles.
const THREAD_RECONCILE_TTL_MS = 10_000;
const __LAST_THREAD_RECONCILE_AT = new Map<number, number>();

// Trim a message array (oldest-first) to the newest MAX_MOUNTED_MESSAGES when
// it grows past the bound. Only ever DROPS from the head (oldest), so the
// visible bottom of the (inverted) list is untouched and `loadOlder`'s
// oldest-real-id cursor still resolves. Returns the same reference when no trim
// is needed so it never forces an extra re-render.
function capNewestWindow(msgs: ChatMessage[]): ChatMessage[] {
  if (msgs.length <= MAX_MOUNTED_MESSAGES) return msgs;
  return msgs.slice(msgs.length - MAX_MOUNTED_MESSAGES);
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
function normalizeUploadedMessage(data: any): ChatMessage {
  if (!data || typeof data !== "object") return data;
  // GET /messages already returns snake_case — if it's already shaped that way
  // (has file_url and no fileUrl), pass through untouched.
  const isCamel =
    "fileUrl" in data || "mediaState" in data || "senderId" in data;
  if (!isCamel) return data as ChatMessage;
  return {
    id: data.id,
    sender_id: data.senderId ?? data.sender_id,
    sender_name: data.senderName ?? data.sender_name,
    sender_avatar: data.senderAvatar ?? data.sender_avatar ?? null,
    content: data.content ?? "",
    created_at: data.createdAt ?? data.created_at,
    file_url: data.fileUrl ?? data.file_url ?? null,
    file_name: data.fileName ?? data.file_name ?? null,
    file_type: data.fileType ?? data.file_type ?? null,
    file_size: data.fileSize ?? data.file_size ?? null,
    reply_to_id: data.replyToId ?? data.reply_to_id ?? null,
    reply_to_content: data.replyContent ?? data.reply_to_content ?? null,
    reply_to_sender_name:
      data.replySenderName ?? data.reply_to_sender_name ?? null,
    reply_to_file_url: data.replyFileUrl ?? data.reply_to_file_url ?? null,
    reply_to_file_type: data.replyFileType ?? data.reply_to_file_type ?? null,
    reply_to_file_name: data.replyFileName ?? data.reply_to_file_name ?? null,
    metadata: data.metadata ?? null,
    reactions: data.reactions ?? [],
    clientMsgId: data.clientMsgId ?? null,
    media_job_id: data.mediaJobId ?? data.media_job_id ?? null,
    media_state: data.mediaState ?? data.media_state ?? null,
    media_stage: data.mediaStage ?? data.media_stage ?? null,
    media_progress: data.mediaProgress ?? data.media_progress ?? null,
    media_pipeline_meta:
      data.mediaPipelineMeta ?? data.media_pipeline_meta ?? null,
  } as ChatMessage;
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
function normalizeFetchedMessage(row: any): ChatMessage {
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
function mergeOutboxIntoMessages(
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

function messageArraysEquivalentForThread(
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
function readMapsEqual(
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

function mergeNewestPageIntoLoadedThread(
  current: ChatMessage[],
  newestPage: ChatMessage[],
): ChatMessage[] {
  if (current.length === 0 || newestPage.length === 0) return newestPage;
  if (current.length <= newestPage.length) return newestPage;

  const firstNewest = newestPage[0];
  const firstIdx = current.findIndex((m) => {
    if (firstNewest.clientMsgId && m.clientMsgId === firstNewest.clientMsgId) {
      return true;
    }
    return m.id === firstNewest.id;
  });

  if (firstIdx <= 0) return newestPage;

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

/**
 * All state, side-effects and handlers for the chat thread screen. Extracted
 * from `app/chat/[id].tsx` so the screen is a thin presentational orchestrator
 * (mirrors the web ChatMessages container/hook split). Behavior-preserving.
 */
export function useChatThread() {
  const params = useLocalSearchParams<{
    id: string;
    name?: string;
    avatar?: string;
    peerId?: string;
    isGroup?: string;
    groupMemberAvatars?: string;
  }>();
  const { id } = params;
  const convId = Number(id);
  const parsedGroupMemberAvatars = useMemo(() => {
    if (!params.groupMemberAvatars) return [];
    try {
      const parsed = JSON.parse(params.groupMemberAvatars);
      return Array.isArray(parsed)
        ? parsed.filter((v): v is string => typeof v === "string" && v.length > 0)
        : [];
    } catch {
      return [];
    }
  }, [params.groupMemberAvatars]);
  // Header identity (name + avatar). Seeded from the route params for the
  // common case (opened from the conversation list, which passes them), but
  // held in STATE so it can be RESOLVED when missing — e.g. a notification tap
  // cold-starts the app and only the conversationId is passed (no name/avatar),
  // which previously left the header showing the generic "Chat" + "?" avatar.
  // We backfill from the cached conversation list (synchronous) and a network
  // refresh below. Mirrors Signal-Android's ConversationIntents, where the
  // thread resolves the recipient from its id when launched from a notification.
  const [name, setName] = useState<string | undefined>(params.name);
  const [headerAvatar, setHeaderAvatar] = useState<string | null>(
    params.avatar || null,
  );
  // Whether this conversation is a group thread. Group calls now stay on the
  // unified call path (no forced meeting redirect).
  const [isGroupConv, setIsGroupConv] = useState(params.isGroup === "1");
  const [groupMemberAvatars, setGroupMemberAvatars] = useState<string[]>(
    parsedGroupMemberAvatars,
  );
  // Caller's local group role + the group's description, surfaced to the
  // group-settings screen (Phase 1). Resolved from the conversation row.
  const [myGroupRole, setMyGroupRole] = useState<string>("member");
  const [groupDescription, setGroupDescription] = useState<string>("");
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const kbInset = useKeyboardInset();
  const { width: winWidth, height: winHeight } = useWindowDimensions();
  const { user } = useAuth();
  const { alert, confirm, dialog } = useDialog();
  // Seed from the on-device cache SYNCHRONOUSLY so the thread paints instantly
  // (Signal-style) instead of blocking on a full-screen spinner. The network
  // refresh in `load()` reconciles in the background. `loading` only stays true
  // on a true cold cache (first-ever open of this conversation).
  const cachedMessages = useMemo(() => getCachedMessages(convId), [convId]);
  const initialCachedMessages = useMemo(() => {
    if (!cachedMessages || cachedMessages.length <= INITIAL_THREAD_PAGE_SIZE) {
      return cachedMessages;
    }
    // Messages are oldest-first; keep the newest page for the initial paint.
    return cachedMessages.slice(-INITIAL_THREAD_PAGE_SIZE);
  }, [cachedMessages]);
  // Merge pending OUTBOX messages (sent while offline, awaiting delivery)
  // into the seed so they reappear as pending bubbles after exiting and
  // reopening the chat — see mergeOutboxIntoMessages.
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    mergeOutboxIntoMessages(
      initialCachedMessages || [],
      convId,
      user?.id,
      user?.full_name,
    ),
  );
  const [loading, setLoading] = useState(
    () => !initialCachedMessages || initialCachedMessages.length === 0,
  );
  // "Delete for me" hidden ids (local-only, persisted per conversation). The
  // source `messages` array stays intact for server reconciliation; the
  // rendered list filters these out (see `messagesReversed`).
  const [locallyDeleted, setLocallyDeleted] = useState<Set<number>>(
    () => new Set(getLocalDeletedIds(convId)),
  );
  // Cursor pagination for older history (mirrors web loadMore). A full cached
  // newest page means older history MAY exist, so keep pagination enabled until
  // an actual older-page request proves otherwise. The latest-page refresh must
  // never turn this off: it only knows about newest rows, not historical depth.
  const [hasMore, setHasMore] = useState(
    () => (initialCachedMessages?.length || 0) >= INITIAL_THREAD_PAGE_SIZE,
  );
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [text, setText] = useState("");
  const [peerTyping, setPeerTyping] = useState(false);
  const [reactTarget, setReactTarget] = useState<ChatMessage | null>(null);
  // Window-space rect of the long-pressed bubble so the reaction bar can be
  // positioned right next to it (matching the web behavior), instead of being
  // fixed in the middle of the screen.
  const [reactAnchor, setReactAnchor] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
    mine: boolean;
  } | null>(null);
  const [barSize, setBarSize] = useState<{ width: number; height: number }>({
    width: 300,
    height: 44,
  });
  const [actionTarget, setActionTarget] = useState<ChatMessage | null>(null);
  // When true, the action-sheet modal shows the "Forward to…" conversation
  // picker INSTEAD of the action rows. Forward used to live in a separate
  // <Modal> opened via setTimeout after dismissing the action sheet — on
  // Android presenting a modal while another is dismissing silently fails,
  // which is why Forward appeared broken. A single modal with switching
  // content has no such race.
  const [forwardMode, setForwardMode] = useState(false);
  const [showAllEmoji, setShowAllEmoji] = useState(false);
  // Whether the emoji grid inserts into the composer ("compose") or reacts to
  // the selected message ("react").
  const [emojiMode, setEmojiMode] = useState<"react" | "compose">("react");
  const [plusOpen, setPlusOpen] = useState(false);
  // Signal-style in-app camera (full-screen). Opened from the composer camera
  // button; supports tap-for-photo / hold-for-video + an in-camera recent-
  // gallery strip (see CameraCapture).
  const [cameraOpen, setCameraOpen] = useState(false);
  // Signal-style media editor: the picked/captured images awaiting edit + send.
  const [editorItems, setEditorItems] = useState<
    { uri: string; width?: number; height?: number }[] | null
  >(null);
  // Captured/picked VIDEO awaiting review in the Signal-style preview screen
  // (caption + view-once + send/discard). Videos used to upload the instant the
  // shutter was released, with no chance to review or cancel.
  const [videoPreview, setVideoPreview] = useState<{
    uri: string;
    fileName: string;
    mimeType: string;
  } | null>(null);
  const [tenorOpen, setTenorOpen] = useState(false);
  const [tenorKind, setTenorKind] = useState<"gif" | "sticker">("gif");
  // Docked in-app emoji keyboard (Signal-style). When open we hide the system
  // keyboard and show EmojiKeyboard at the last-measured keyboard height so the
  // message list doesn't jump.
  const [emojiKeyboardOpen, setEmojiKeyboardOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  // Peer (1:1) identity + live status for the header avatar badge.
  const [peerUserId, setPeerUserId] = useState<number | null>(
    params.peerId ? Number(params.peerId) : null,
  );
  const [peerStatus, setPeerStatus] = useState<string | null>(null);
  // Whether the peer is currently logged in from the office or working remotely
  // (from today's attendance clock-in). null = logged out / no data. Shown as a
  // badge in the header. Updated on presence fetch only (no live WS event).
  const [peerWorkMode, setPeerWorkMode] = useState<string | null>(null);
  // Delivery / read receipts (userId → ISO last_read_at) + participant count.
  // Seed from the on-device cache SYNCHRONOUSLY (same pattern as `messages`)
  // so the read-receipt tick colour is correct on the FIRST frame. Without
  // this, the cached messages painted instantly but `readReceipts` started
  // empty and was only filled by the async `getReadStatus()` round-trip in
  // `load()` — so the ticks flipped from delivered (muted) → read (accent) a
  // fraction of a second after the chat opened. The network refresh below now
  // just confirms what's already shown instead of causing a visible flip.
  const cachedReceipts = useMemo(() => getCachedReadStatus(convId), [convId]);
  const [readReceipts, setReadReceipts] = useState<Record<number, string>>(
    () => cachedReceipts || {},
  );
  const [participantCount, setParticipantCount] = useState(2);
  // Pinned messages (banner at the top of the chat).
  const [pinnedMsgs, setPinnedMsgs] = useState<PinnedMessage[]>([]);
  // Locally-tracked starred message ids (server list doesn't return per-message
  // starred state, so we reflect it optimistically after the action).
  const [starredIds, setStarredIds] = useState<Set<number>>(new Set());
  // ── Multi-select model (Signal-style) ─────────────────────────────────────
  // Long-pressing a message enters selection mode; subsequent taps toggle more
  // messages in/out. The header swaps to a selection action bar (pin / save /
  // forward / copy / delete) that operates on this set. Selection is "active"
  // whenever the set is non-empty.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const selectionMode = selectedIds.size > 0;
  // Top-anchored overflow menu (Signal-style) open state.
  const [menuOpen, setMenuOpen] = useState(false);
  // Block state for the 1:1 peer (Signal parity). When blocked, the composer
  // is replaced with an Unblock banner and sends are rejected server-side.
  const [isBlocked, setIsBlocked] = useState(false);
  // ── Signal-style IN-CONVERSATION search ──────────────────────────────────
  // Instead of pushing a separate route, search runs in-place over the
  // currently-loaded thread: the header swaps to a search bar and a bottom
  // match-navigation bar steps through hits, scrolling the (inverted) list to
  // each and flashing a highlight on the matched bubble.
  const [searchMode, setSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // Matching message ids in OLDEST-FIRST order (same order as `messages`).
  const [searchMatchIds, setSearchMatchIds] = useState<number[]>([]);
  const [searchActiveIdx, setSearchActiveIdx] = useState(0);
  // The message currently focused by search — drives the bubble highlight flash.
  const [highlightedId, setHighlightedId] = useState<number | null>(null);
  // Header 3-dot menu + its panels (search / pinned / shared files / saved).
  const [headerSheet, setHeaderSheet] = useState<HeaderSheet>(null);
  const [sheetSearchQ, setSheetSearchQ] = useState("");
  const [sheetSearchResults, setSheetSearchResults] = useState<
    MessageSearchResult[]
  >([]);
  const [sheetLoading, setSheetLoading] = useState(false);
  const [sharedFiles, setSharedFiles] = useState<SharedFile[]>([]);
  const [savedMsgs, setSavedMsgs] = useState<StarredMessage[]>([]);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Explicit recording flag: true WHILE the user is recording a voice message.
  // It also GATES the mount of <VoiceRecorderController> (which owns the native
  // recorder) — see the recording handlers below.
  const [isRecordingActive, setIsRecordingActive] = useState(false);
  // Live recording duration (ms), pushed up from VoiceRecorderController so the
  // composer's recording bar shows the counter.
  const [recordingMillis, setRecordingMillis] = useState(0);
  // Voice recording (expo-audio).
  //
  // PERF (chat-open jank root cause): `useAudioRecorder` / `useAudioRecorderState`
  // and `useAudioPlayer` each construct a NATIVE shared object on mount. Creating
  // them here meant every chat OPEN allocated a native recorder + player (and a
  // status poll) on the critical first-render path, competing with the
  // navigation slide-in. Signal only touches the audio session WHILE recording /
  // when a sound actually plays, so both are now created lazily:
  //   • the recorder lives in <VoiceRecorderController>, mounted ONLY while
  //     recording (gated by isRecordingActive);
  //   • the reaction-sound player is created on first react (see playReactionSound).
  // Imperative handle into the mounted recorder controller (stop / cancel).
  const voiceHandleRef = useRef<VoiceRecorderControllerHandle | null>(null);
  // Dedicated player for the short "reaction added" feedback tone, created
  // lazily on first use and released on unmount.
  const reactionSoundPlayerRef = useRef<AudioPlayer | null>(null);
  // Release the lazily-created reaction-sound player when the thread unmounts.
  useEffect(
    () => () => {
      try {
        reactionSoundPlayerRef.current?.release();
      } catch {
        /* ignore */
      }
      reactionSoundPlayerRef.current = null;
    },
    [],
  );

  // Ref mirror of isRecordingActive — guards against double-start re-entrancy
  // in the recording handlers without depending on the stale polled value.
  const recordingRef = useRef(false);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  // Whether the (inverted) list is currently near the visual bottom (newest
  // message). In an inverted list offset 0 IS the bottom, so "near bottom" means
  // a small contentOffset.y. We only auto-scroll to the newest message on an
  // INCOMING message when the user is already at the bottom — otherwise we keep
  // their scroll position (Signal-style) and let the floating "scroll to latest"
  // pill surface instead of yanking them down mid-read.
  const atBottomRef = useRef(true);
  // One-shot guard so we only force a jump-to-bottom on the very FIRST cold
  // paint of a conversation. The inverted list is already structurally
  // bottom-pinned, so re-scrolling on every background `load()` reconcile just
  // caused a visible "settle"/jump on open.
  const didInitialScrollRef = useRef(false);
  // Whether THIS thread screen is the one currently focused. Expo Router keeps
  // previously-visited `chat/[id]` screens mounted in the stack, so without this
  // gate every backgrounded thread's socket handler would still run the full
  // heavy per-event work (setMessages reconciles, receipt maps, pin refreshes)
  // for EVERY live event — cost that scales with how many chats you opened this
  // session and is the root cause of the "fast at first, then lags/freezes"
  // degradation. Signal keeps a single active conversation data source; we
  // mirror that by making backgrounded threads inert for non-critical events.
  const isFocusedRef = useRef(true);
  // Timestamp (ms) of the last completed network reconcile. Used to skip a
  // redundant `load()` when the same thread is re-focused within a short window
  // (quickly bouncing in/out of a chat shouldn't repay the full reconcile).
  const lastLoadedAtRef = useRef(__LAST_THREAD_RECONCILE_AT.get(convId) || 0);
  // Guards async continuations after route replacement / back navigation. A
  // replaced chat screen can unmount while messages/read-status/presence requests
  // are still in flight; without this guard their `.then()` continuations can
  // still allocate objects and call setState on a dead conversation.
  const mountedRef = useRef(true);
  // Bubble host-node refs so we can reliably measure each bubble's window rect
  // for the reaction-bar anchor (Pressable forwards its ref to the host View,
  // which exposes measureInWindow — currentTarget often does not).
  const bubbleRefs = useRef<Map<number, View>>(new Map());
  const mediaUploadControllers = useRef<Map<number, AbortController>>(
    new Map(),
  );
  const mediaUploadSources = useRef<Map<number, PendingMediaSource>>(new Map());
  // Per-upload throughput sampler: last {timestamp, bytes} so we can derive a
  // live bytes/sec speed for the Signal-style upload label.
  const uploadProgressTs = useRef<Map<number, { t: number; loaded: number }>>(
    new Map(),
  );
  const pendingDraftReply = useRef<ConversationDraft["replyTo"]>(null);
  const pendingDraftEditing = useRef<ConversationDraft["editing"]>(null);
  const pendingDraftMedia = useRef<PendingMediaSource[]>([]);
  const draftHydrated = useRef(false);
  const typingSentAt = useRef(0);
  const typingClear = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True while older messages are being prepended, so the auto
  // scroll-to-end on content-size change doesn't yank the list to the
  // bottom and defeat pagination.
  const prependingRef = useRef(false);
  // TextInput handle so we can blur/focus when switching between the system
  // keyboard and the in-app emoji keyboard.
  const inputRef = useRef<TextInput>(null);
  const emojiKeyboardOpenRef = useRef(false);
  const emojiKeyboardFocusTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // One-shot guard so the "system keyboard appeared → close emoji" safety
  // effect below ignores the STALE keyboard height reported while the OS
  // keyboard is still animating away after we deliberately switched to the
  // in-app emoji keyboard. Without it, tapping the emoji toggle WHILE typing
  // immediately re-closed the emoji panel (the dismiss is async, so kbInset
  // was still > 100 on the render that opened it). Re-armed once the system
  // keyboard is genuinely hidden (kbInset back to 0). Mirrors Signal-Android's
  // transition-based InputAwareLayout (it tracks the keyboard transition, not a
  // momentary height value).
  const ignoreKbForEmoji = useRef(false);
  // True while the emoji keyboard's search field has focus so the system
  // keyboard is intentionally visible — suppresses the safety effect that
  // auto-closes the emoji panel when kbInset rises.
  const emojiSearchFocused = useRef(false);
  // Last-measured system keyboard height — the in-app emoji keyboard is shown
  // at this height so toggling between them doesn't shift the message list.
  // Seeded from ~40 % of the screen height (a reliable cross-device estimate)
  // so the panel is correctly sized even before the system keyboard has ever
  // appeared this session.
  const lastKbHeight = useRef(Math.round(winHeight * 0.4));
  if (kbInset > 100) lastKbHeight.current = kbInset;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (typingClear.current) clearTimeout(typingClear.current);
      for (const controller of mediaUploadControllers.current.values()) {
        try {
          controller.abort();
        } catch {
          /* ignore */
        }
      }
      mediaUploadControllers.current.clear();
      mediaUploadSources.current.clear();
      uploadProgressTs.current.clear();
    };
  }, []);

  useEffect(() => {
    emojiKeyboardOpenRef.current = emojiKeyboardOpen;
  }, [emojiKeyboardOpen]);

  useEffect(
    () => () => {
      if (emojiKeyboardFocusTimer.current) {
        clearTimeout(emojiKeyboardFocusTimer.current);
      }
    },
    [],
  );

  // Hydrate emoji recents + skin-tone preference once — but DEFER it past the
  // open transition. It's only needed when the emoji panel/picker is first
  // opened, so running it eagerly on mount just added JS-thread work competing
  // with the screen's slide-in animation (part of the laggy open). Running it
  // after interactions keeps the open snappy without any user-visible delay.
  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => {
      hydrateEmojiStore();
    });
    return () => task.cancel();
  }, []);

  // If the system keyboard GENUINELY appears (user tapped the field), close the
  // in-app emoji keyboard so the two never stack. We must ignore the STALE
  // keyboard height reported while the OS keyboard is still animating away
  // right after we deliberately switched to the emoji keyboard — otherwise
  // tapping the emoji toggle WHILE typing instantly re-closed the panel that
  // had just opened (the dismiss is async, so kbInset was momentarily still
  // > 100 on the render that set emojiKeyboardOpen=true). Once the keyboard is
  // fully hidden (kbInset back to 0) we re-arm the guard so a real later
  // keyboard appearance still closes the emoji panel.
  useEffect(() => {
    if (kbInset > 100) {
      if (ignoreKbForEmoji.current) return; // stale height from the dismissing keyboard
      // Emoji search field is focused → system keyboard is intentional; keep
      // the emoji panel open so the user can see search results above the keyboard.
      if (emojiSearchFocused.current) return;
      if (emojiKeyboardOpen) setEmojiKeyboardOpen(false);
    } else {
      ignoreKbForEmoji.current = false; // keyboard fully hidden → re-arm
      emojiSearchFocused.current = false;
    }
  }, [kbInset, emojiKeyboardOpen]);

  // Scroll to the newest message. The message list is an INVERTED FlatList
  // (Signal-Android model: newest row pinned to the visual bottom), so the
  // "bottom" is offset 0. With an inverted list the newest message is already
  // structurally at the bottom — the keyboard opening/closing or sending a new
  // message can NEVER push it under the composer — so this is just a nicety for
  // explicit "jump to latest" cases (send, incoming, typing-indicator appears).
  const scrollToEnd = useCallback((animated = false) => {
    atBottomRef.current = true;
    listRef.current?.scrollToOffset({ offset: 0, animated });
  }, []);

  // Track whether the (inverted) list is near the visual bottom. The chat
  // screen forwards the FlatList's onScroll here. In an inverted list offset 0
  // is the bottom (newest), so "near bottom" is a small contentOffset.y. This
  // gates the incoming-message auto-scroll so a new message never yanks the
  // user down while they're reading history (Signal keeps the position and
  // surfaces the "scroll to latest" pill instead).
  const onListScroll = useCallback((y: number) => {
    atBottomRef.current = y <= 80;
  }, []);

  // When the peer STARTS typing, the typing-indicator row appears below the
  // list and shrinks the FlatList — which can crop/hide the newest bubble.
  // Re-anchor to the bottom so the last message stays fully visible above the
  // typing indicator (mirrors the web auto-scroll on typing).
  useEffect(() => {
    if (peerTyping) scrollToEnd(true);
  }, [peerTyping, scrollToEnd]);

  // Register/unregister a bubble's host node so the reaction bar can measure
  // it (see openReactionBar). Keeping this stable avoids re-registering on
  // every render.
  const registerBubbleRef = useCallback((msgId: number, node: View | null) => {
    if (node) bubbleRefs.current.set(msgId, node);
    else bubbleRefs.current.delete(msgId);
  }, []);

  const loadPinned = useCallback(() => {
    getPinnedMessages(convId)
      .then((r) => setPinnedMsgs(r.data || []))
      .catch(() => {});
  }, [convId]);

  const markReadAndSync = useCallback(() => {
    markConversationRead(convId)
      .then(() => {
        // T030: Update unread manager when conversation is marked read
        chatUnreadManager.markConversationRead(convId);
        emitChatUnreadChanged();
      })
      .catch(() => {});
    // SIGNAL PARITY: opening/reading a conversation in-app must also dismiss its
    // status-bar message notification AND refresh/cancel the cross-conversation
    // group summary so the umbrella count stays accurate (and disappears with
    // the last chat). Best-effort; no-ops when Notifee is unavailable.
    void notifeeService.cancelMessageNotification(convId);
  }, [convId]);

  // Track the conversation currently ON SCREEN so the push-notification handler
  // can SUPPRESS the status-bar banner for messages that belong to the chat the
  // user is already reading (WhatsApp/Signal/Teams parity — you never get a
  // banner for the conversation that's open in the foreground). The server has
  // no idea which screen the recipient is on, so it always sends a message push
  // (correct — it guarantees delivery for backgrounded/offline devices); this
  // lets the CLIENT make the "I'm already here, don't show a banner" decision in
  // backgroundPushService.handleNotificationPayload. We use useFocusEffect (not
  // a plain useEffect) so the id is cleared when this screen loses focus —
  // navigating to a sub-screen (info/search/saved) or backing out to the list —
  // and re-set when it regains focus, so banners resume the moment you leave.
  useFocusEffect(
    useCallback(() => {
      isFocusedRef.current = true;
      setActiveConversation(convId);
      // Signal single-active-conversation model: the thread body is UNMOUNTED
      // while a sub-screen (search / saved / pinned) is on top, so a jump that
      // screen emitted while we were gone never reached a live subscriber. On
      // refocus (remount) consume any recent pending jump for THIS conversation
      // and scroll to it once the list has settled.
      const pendingJumpId = consumePendingChatJump(convId);
      if (pendingJumpId != null) {
        setTimeout(() => jumpToMessage(pendingJumpId), 120);
      }
      return () => {
        isFocusedRef.current = false;
        setActiveConversation(null);
      };
      // jumpToMessage reads refs + current messages and is stable enough; convId
      // is the only real dependency.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [convId]),
  );

  const load = useCallback(async () => {
    const now = Date.now();
    if (
      initialCachedMessages &&
      initialCachedMessages.length > 0 &&
      now - lastLoadedAtRef.current < THREAD_RECONCILE_TTL_MS
    ) {
      // Warm cache + very recent reconcile: do not repay the full messages /
      // read-status / pinned refresh on quick repeated open/exit cycles. The
      // global cache sync keeps incoming messages current while the thread is
      // closed; the next open after the TTL will reconcile normally.
      setLoading(false);
      return;
    }

    try {
      const { data } = await getMessages(convId);
      if (!mountedRef.current) return;
      // Map the REST reply aliases (reply_content / reply_sender_name /
      // reply_file_*) to the canonical reply_to_* shape so the in-bubble quote
      // doesn't collapse to the generic "Message" when this refresh replaces
      // the optimistic / WS rows (see normalizeFetchedMessage).
      const normalized = (data || []).map(normalizeFetchedMessage);
      // Re-append any still-pending outbox messages — the server obviously
      // doesn't have them yet, and wholesale-replacing the list without them
      // would make an unsent (offline) message vanish mid-session.
      const refreshed = mergeOutboxIntoMessages(
        normalized,
        convId,
        user?.id,
        user?.full_name,
      );
      setMessages((prev) => {
        const merged = mergeNewestPageIntoLoadedThread(prev, refreshed);
        return messageArraysEquivalentForThread(prev, merged) ? prev : merged;
      });
      // Persist the freshest page so the next open paints instantly from disk.
      setCachedMessages(convId, normalized);
      // Do NOT set hasMore=false from this newest-page refresh. Only loadOlder()
      // can know when older history is exhausted; otherwise waiting for this
      // reconcile could disable pagination before the user scrolls up.
      if (normalized.length >= INITIAL_THREAD_PAGE_SIZE) setHasMore(true);
      markReadAndSync();
      // Seed read receipts so own messages show the correct tick immediately.
      // Also persist them to the on-device cache so the NEXT open paints the
      // read colour on the first frame (no delivered→read flip).
      getReadStatus(convId)
        .then((r) => {
          if (!mountedRef.current) return;
          const map: Record<number, string> = {};
          for (const row of r.data || []) {
            if (row.user_id != null && row.last_read_at) {
              map[row.user_id] = row.last_read_at;
            }
          }
          // Skip the state update when the map is unchanged. Every `load()`
          // otherwise replaced `readReceipts` with a NEW object identity even
          // when the receipts were identical — and since MessageBubble
          // reference-compares `readReceipts`, that rebound EVERY mounted row on
          // each refocus/reconcile. Only commit a genuine change.
          setReadReceipts((prev) => (readMapsEqual(prev, map) ? prev : map));
          setCachedReadStatus(convId, map);
        })
        .catch(() => {});
      // Record the reconcile time so a quick re-focus of the same thread can
      // skip repaying this whole `load()` (see the focus-gated effect below).
      const loadedAt = Date.now();
      lastLoadedAtRef.current = loadedAt;
      __LAST_THREAD_RECONCILE_AT.set(convId, loadedAt);
      // Inverted FlatList is structurally bottom-pinned: index 0 is already the
      // visual bottom/newest message. Do not force scrollToEnd() on open/reconcile
      // because even non-animated native offset writes make the scrollbar flash
      // and look like the chat is auto-scrolling while it opens.
      didInitialScrollRef.current = true;
    } catch {
      /* ignore */
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [
    convId,
    initialCachedMessages,
    markReadAndSync,
    scrollToEnd,
    user?.id,
    user?.full_name,
  ]);

  // Defer the network refresh + its (large) setMessages re-render until AFTER
  // the screen's open transition has settled. The cached page is already on
  // screen (see cachedMessages), so this is a pure background reconcile — running
  // it synchronously on mount used to fire a heavy re-render DURING the
  // slide-in animation, which dropped frames and made the open feel laggy.
  // InteractionManager runs it on the first idle frame after the transition,
  // keeping the animation smooth (Signal-Android feel).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const task = InteractionManager.runAfterInteractions(() => {
      // Give the native push animation a short quiet window after interactions
      // settle before doing the first network reconcile. This avoids a large
      // setMessages/read-receipts/pinned commit landing in the same frame range
      // as the screen slide-in, which was the remaining "fast but not smooth"
      // open stutter on long conversations.
      timer = setTimeout(() => {
        load();
        loadPinned();
      }, 250);
    });
    return () => {
      task.cancel();
      if (timer) clearTimeout(timer);
    };
  }, [load, loadPinned]);

  // Cross-screen "jump to message": the in-conversation search / saved / pinned
  // screens live on separate routes. When the user taps a result there, they
  // pop back to this (already-mounted) thread and emit a jump event — subscribe
  // here and scroll to the target once it lands.
  useEffect(() => {
    const off = subscribeChatJump((cid, messageId) => {
      if (cid !== convId) return;
      // Defer a touch so the back-navigation transition has fully settled.
      setTimeout(() => jumpToMessage(messageId), 80);
    });
    return off;
    // jumpToMessage is stable enough (reads refs + current messages); convId is
    // the only real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId]);

  // Load an older page of messages using the oldest real message id as a
  // cursor (mirrors the web loadMore). Triggered by the "load earlier"
  // header button / top-reach.
  const loadOlder = useCallback(async () => {
    if (loadingOlder || !hasMore) return;
    // Oldest REAL (server-assigned) id — skip optimistic negative ids.
    const oldest = messages.find((m) => m.id > 0);
    if (!oldest) return;
    setLoadingOlder(true);
    prependingRef.current = true;
    try {
      const { data } = await getMessages(convId, oldest.id);
      // Same reply-alias normalization as load() so prepended history keeps its
      // quoted-message text instead of collapsing to "Message".
      const older = (data || []).map(normalizeFetchedMessage);
      setHasMore(older.length >= 50);
      if (older.length > 0) {
        setMessages((prev) => {
          const have = new Set(prev.map((m) => m.id));
          return [...older.filter((m) => !have.has(m.id)), ...prev];
        });
      }
    } catch {
      /* ignore */
    } finally {
      setLoadingOlder(false);
      // Give the list a beat to settle before re-enabling stick-to-end.
      setTimeout(() => {
        prependingRef.current = false;
      }, 350);
    }
  }, [convId, hasMore, loadingOlder, messages]);

  // Resolve the 1:1 peer's status for the header badge.
  //
  // PERF: this used to fetch the ENTIRE conversation list (`getConversations`)
  // on every chat open just to find this one conversation's peer id / group
  // flag — a wasteful full round-trip on the critical open path. The peer id,
  // name, avatar and group flag are ALREADY passed as route params from the
  // conversation list (see `openConv` in app/(tabs)/chat.tsx), so we use those
  // and only make the cheap presence call for the live status badge. If a peer
  // id wasn't supplied (e.g. deep-link), we fall back to the cached
  // conversation list instead of hitting the network.
  useEffect(() => {
    let active = true;
    const peerFromParam = params.peerId ? Number(params.peerId) : null;
    // Whether the route already supplied the header identity (opened from the
    // conversation list). When it did NOT (e.g. a notification tap cold-start),
    // we must RESOLVE name/avatar from the conversation so the header doesn't
    // show the generic "Chat" + "?" avatar.
    const haveIdentity = !!params.name;

    // Apply a resolved conversation's identity (name / avatar / group flag /
    // peer) to the header state. Used both from the synchronous cache lookup
    // and the network fallback below. Only fills fields the route didn't give.
    const applyConv = (conv: Conversation) => {
      if (!active) return;
      if (conv.member_count) setParticipantCount(conv.member_count);
      setIsGroupConv(!!conv.is_group);
      if (conv.is_group) {
        setGroupMemberAvatars(
          Array.isArray(conv.group_member_avatars)
            ? conv.group_member_avatars.filter(
                (v): v is string => typeof v === "string" && v.length > 0,
              )
            : [],
        );
      }
      if (conv.my_role) setMyGroupRole(conv.my_role);
      if (conv.group_description != null)
        setGroupDescription(conv.group_description);
      const resolvedName = conv.is_group
        ? conv.group_name || "Group"
        : conv.other_full_name || conv.other_username || "Chat";
      const resolvedAvatar = conv.is_group
        ? conv.group_avatar || null
        : conv.other_avatar || null;
      if (!params.name && resolvedName) setName(resolvedName);
      if (!params.avatar && resolvedAvatar) setHeaderAvatar(resolvedAvatar);
      if (typeof conv.is_blocked === "boolean") setIsBlocked(conv.is_blocked);
      if (!conv.is_group && conv.other_user_id) {
        const uid = conv.other_user_id;
        setPeerUserId(uid);
        getChatPresence([uid])
          .then((r) => {
            if (active) {
              setPeerStatus(r.data?.[uid]?.userStatus ?? null);
              setPeerWorkMode(r.data?.[uid]?.workMode ?? null);
            }
          })
          .catch(() => {});
      }
    };

    // Resolve the peer identity/status + block state. The header NAME/AVATAR
    // already paint instantly from the route params (seeded into state above),
    // so none of this is needed for the first frame — it only fills the live
    // status badge, block banner and (on a cold deep-link) the resolved name.
    // Running the presence network call + the cached-conversations scan eagerly
    // on mount added JS-thread work that competed with the open animation, so
    // we DEFER the whole resolution past the slide-in (Signal-Android feel).
    // The badge/block/name simply light up a beat after the chat has opened,
    // with no visible downgrade.
    const task = InteractionManager.runAfterInteractions(() => {
      if (!active) return;

      // Seed the block state from the cached conversation row even when the
      // route already supplied the header identity (list-open path early-returns
      // below and would otherwise skip applyConv → isBlocked stays false).
      const cachedBlockConv = (getCachedConversations() || []).find(
        (c) => c.id === convId,
      );
      if (typeof cachedBlockConv?.is_blocked === "boolean") {
        setIsBlocked(cachedBlockConv.is_blocked);
      }

      if (peerFromParam) {
        setPeerUserId(peerFromParam);
        getChatPresence([peerFromParam])
          .then((r) => {
            if (active) {
              setPeerStatus(r.data?.[peerFromParam]?.userStatus ?? null);
              setPeerWorkMode(r.data?.[peerFromParam]?.workMode ?? null);
            }
          })
          .catch(() => {});
        // The header name/avatar were supplied alongside the peer id — nothing
        // to resolve. (This is the conversation-list open path.)
        if (haveIdentity) return;
      }

      // Resolve identity from the cached conversation list FIRST (synchronous,
      // no network) so deep-links / notification taps light up the header
      // when the cache is warm.
      const cachedConvs = getCachedConversations();
      const conv = (cachedConvs || []).find((c) => c.id === convId);
      if (conv) {
        applyConv(conv);
      }

      // If identity is STILL unresolved (cold cache after a notification cold-
      // start — the #1 case for "tapping a message shows 'Chat' + '?'"), fetch
      // the conversation list from the network and backfill. Mirrors Signal-
      // Android resolving the recipient from its id on a notification launch.
      if (!haveIdentity && !conv) {
        getConversations()
          .then((r) => {
            if (!active) return;
            const fresh = (r.data || []).find((c) => c.id === convId);
            if (fresh) applyConv(fresh);
          })
          .catch(() => {});
      }
    });

    return () => {
      active = false;
      task.cancel();
    };
  }, [
    convId,
    params.peerId,
    params.name,
    params.avatar,
    params.groupMemberAvatars,
  ]);

  // Keep the peer's header status live via the unified `user_status` event.
  useEffect(() => {
    const off = socket.subscribe((msg) => {
      if (msg.type !== "user_status") return;
      if (!peerUserId || msg.data?.userId !== peerUserId) return;
      setPeerStatus(msg.data.effective);
    });
    return off;
  }, [peerUserId]);

  // Live incoming messages / typing / read receipts / pins for this conversation.
  useEffect(() => {
    const off = socket.subscribe((msg) => {
      const d = msg.data || {};
      // Signal-Android single-active-thread model: backgrounded thread screens
      // (kept mounted in the Expo Router stack) do NOT reprocess the high-
      // frequency live stream. Typing pulses and read-receipt fan-out for a
      // thread the user isn't looking at would otherwise run setState on EVERY
      // mounted thread per event — cost that compounds with how many chats were
      // opened this session (the "fast at first, then lags/freezes" symptom).
      // Terminal lifecycle events (message/clear/delete/removed) still process
      // so the cache + unread stay correct; only the cosmetic, high-rate
      // typing/receipt updates are skipped while unfocused.
      const nonCritical =
        msg.type === "chat_typing" || msg.type === "chat_read_receipt";
      if (nonCritical && !isFocusedRef.current) return;
      if (msg.type === "chat_typing") {
        if (Number(d.conversationId) !== convId) return;
        if (d.userId === user?.id) return;
        setPeerTyping(true);
        if (typingClear.current) clearTimeout(typingClear.current);
        typingClear.current = setTimeout(() => setPeerTyping(false), 3500);
        return;
      }
      if (msg.type === "chat_read_receipt") {
        if (Number(d.conversationId) !== convId) return;
        if (d.userId && d.readAt) {
          setReadReceipts((prev) => {
            const next = { ...prev, [d.userId]: d.readAt };
            // Keep the on-device cache in sync so the read colour is correct on
            // the FIRST frame of the next open (no delivered→read flip).
            setCachedReadStatus(convId, next);
            return next;
          });
        }
        return;
      }
      if (msg.type === "chat_message_error") {
        const clientMsgId =
          typeof d.clientMsgId === "string" ? d.clientMsgId : null;
        if (!clientMsgId) return;
        setMessages((prev) =>
          prev.map((m) =>
            m.clientMsgId === clientMsgId
              ? {
                  ...m,
                  _failed: true,
                  _pending: false,
                  _failureReason:
                    typeof d.reason === "string" && d.reason
                      ? d.reason
                      : "Could not send message.",
                }
              : m,
          ),
        );
        return;
      }
      if (msg.type === "chat_media_job") {
        if (Number(d.conversationId) !== convId) return;
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== d.messageId) return m;
            // Once the HTTP upload has RESOLVED (the optimistic bubble was
            // replaced by the server row → positive id + a persisted file_url
            // that is NOT a local file: uri), the message is effectively
            // "sent". The server-side media PIPELINE (queued→processing→
            // completed) is a SEPARATE post-processing step; its non-terminal
            // events must NOT drag a delivered message back to a "Queued"/
            // "Uploading" spinner (the bug where a delivered+seen image stuck
            // on "Queued" forever when the final `completed` event was missed
            // on reconnect). For a sent message we therefore ONLY react to a
            // terminal FAILURE; success/queued/processing are ignored.
            const httpUploadDone =
              Number(m.id) > 0 &&
              !!m.file_url &&
              !/^(file|content|data):/i.test(String(m.file_url));
            if (httpUploadDone) {
              if (d.status === "failed") {
                return {
                  ...m,
                  media_state: "failed",
                  media_failure_reason: d.failureReason ?? null,
                  _mediaState: "failed",
                  _failed: true,
                  _failureReason: d.failureReason ?? m._failureReason ?? null,
                };
              }
              // completed / queued / processing / cancelled → keep delivered.
              return {
                ...m,
                media_job_id: d.mediaJobId ?? m.media_job_id ?? null,
                media_state: "completed",
                _mediaState: undefined,
                _mediaProgress: 100,
                _failed: false,
              };
            }
            // Optimistic (not-yet-uploaded) message: reflect live pipeline.
            return {
              ...m,
              media_job_id: d.mediaJobId ?? m.media_job_id ?? null,
              media_state: d.status ?? m.media_state ?? null,
              media_progress:
                typeof d.progress === "number"
                  ? d.progress
                  : (m.media_progress ?? null),
              media_failure_reason: d.failureReason ?? null,
              _mediaState:
                d.status === "processing"
                  ? "uploading"
                  : (d.status ?? m._mediaState),
              _mediaProgress:
                typeof d.progress === "number"
                  ? d.progress
                  : (m._mediaProgress ?? 0),
              _failed: d.status === "failed" || d.status === "cancelled",
              _failureReason:
                d.failureReason ??
                (d.status === "cancelled"
                  ? "Upload cancelled"
                  : m._failureReason),
            };
          }),
        );
        return;
      }
      if (msg.type === "chat_pin") {
        if (Number(d.conversationId) !== convId) return;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === d.messageId
              ? {
                  ...m,
                  pinned_at: d.pinned ? new Date().toISOString() : null,
                  pinned_by: d.pinned ? d.pinnedBy : null,
                }
              : m,
          ),
        );
        loadPinned();
        return;
      }
      // Peer reactions — add/remove live (mirrors web chat_reaction handler).
      if (msg.type === "chat_reaction") {
        if (Number(d.conversationId) !== convId) return;
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== d.messageId) return m;
            if (m.deleted_at) return { ...m, reactions: [] };
            let reactions = [...(m.reactions || [])];
            if (d.action === "added") {
              // Idempotent: don't duplicate an optimistically-added reaction.
              if (
                !reactions.some(
                  (r) => r.userId === d.userId && r.emoji === d.emoji,
                )
              ) {
                reactions.push({
                  userId: d.userId,
                  fullName: d.fullName,
                  emoji: d.emoji,
                });
              }
            } else {
              reactions = reactions.filter(
                (r) => !(r.userId === d.userId && r.emoji === d.emoji),
              );
            }
            return { ...m, reactions };
          }),
        );
        return;
      }
      // Peer edits — update content live (mirrors web chat_edit handler).
      if (msg.type === "chat_edit") {
        if (Number(d.conversationId) !== convId) return;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === d.messageId
              ? { ...m, content: d.content, edited_at: d.editedAt }
              : m,
          ),
        );
        return;
      }
      // Peer deletions — mark deleted live (mirrors web chat_delete handler).
      if (msg.type === "chat_delete") {
        if (Number(d.conversationId) !== convId) return;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === d.messageId
              ? {
                  ...m,
                  deleted_at: new Date().toISOString(),
                  content: "",
                  file_url: null,
                  file_name: null,
                  file_type: null,
                  file_size: null,
                  reactions: [],
                }
              : m,
          ),
        );
        return;
      }
      // Conversation cleared by a peer — empty the list (mirrors web).
      if (msg.type === "chat_cleared") {
        if (Number(d.conversationId) !== convId) return;
        setMessages([]);
        setPinnedMsgs([]);
        setHasMore(false);
        // Drop the on-disk cache too so reopening doesn't resurrect the cleared
        // messages from the instant-render seed.
        clearCachedMessages(convId);
        return;
      }
      // Conversation deleted, or current user removed from the group —
      // leave the screen (the web equivalent clears activeConv).
      if (msg.type === "chat_conv_deleted") {
        if (Number(d.conversationId) !== convId) return;
        router.back();
        return;
      }
      if (msg.type === "chat_group_removed") {
        if (Number(d.conversationId) !== convId) return;
        if (d.userId === user?.id) router.back();
        return;
      }
      if (msg.type !== "chat_message") return;
      if (Number(d.conversationId) !== convId) return;
      // Unfocused thread: skip the heavy live-append work. The global
      // ChatCacheSync (mounted in app/_layout) already appends every incoming
      // message to the on-device cache regardless of which screen is mounted,
      // and this thread re-seeds from that cache + runs a fresh load() reconcile
      // when it regains focus — so the message is never lost. Running the full
      // setMessages/markRead/ack/scroll reconcile on EVERY backgrounded thread
      // per incoming message is exactly the work that compounds per open (the
      // "fine for 5–6 opens, then lags/freezes" symptom). The focused thread
      // still does the full live append + read/ack/scroll below.
      if (!isFocusedRef.current) return;
      setMessages((prev) => {
        if (d.clientMsgId) {
          const idx = prev.findIndex((m) => m.clientMsgId === d.clientMsgId);
          if (idx >= 0) {
            const copy = [...prev];
            copy[idx] = {
              id: d.id,
              sender_id: d.senderId,
              sender_name: d.senderName,
              content: d.content,
              created_at: d.createdAt,
              file_url: d.fileUrl,
              file_name: d.fileName,
              file_type: d.fileType,
              file_size: d.fileSize,
              reply_to_id: d.replyToId ?? null,
              reply_to_content: d.replyContent ?? null,
              reply_to_sender_name: d.replySenderName ?? null,
              reply_to_file_url: d.replyFileUrl ?? null,
              reply_to_file_type: d.replyFileType ?? null,
              reply_to_file_name:
                d.replyFileName ?? d.reply_to_file_name ?? null,
              format_type: d.formatType ?? d.format_type ?? null,
              metadata: d.metadata ?? null,
              clientMsgId: d.clientMsgId,
              _mediaState: d.mediaState ?? null,
              _mediaProgress:
                typeof d.mediaProgress === "number" ? d.mediaProgress : 0,
              _failureReason: d.failureReason ?? null,
              media_job_id: d.mediaJobId ?? null,
            };
            return copy;
          }
        }
        if (prev.some((m) => m.id === d.id)) return prev;
        // Append the new message, then TRIM the oldest so a long-lived focused
        // thread's in-memory array can't grow without bound (see
        // capNewestWindow / MAX_MOUNTED_MESSAGES). Dropping only from the head
        // keeps the newest bottom of the inverted list intact; older history
        // remains reachable via loadOlder / the on-disk cache.
        return capNewestWindow([
          ...prev,
          {
            id: d.id,
            sender_id: d.senderId,
            sender_name: d.senderName,
            content: d.content,
            created_at: d.createdAt,
            file_url: d.fileUrl,
            file_name: d.fileName,
            file_type: d.fileType,
            file_size: d.fileSize,
            reply_to_id: d.replyToId ?? null,
            reply_to_content: d.replyContent ?? null,
            reply_to_sender_name: d.replySenderName ?? null,
            reply_to_file_url: d.replyFileUrl ?? null,
            reply_to_file_type: d.replyFileType ?? null,
            reply_to_file_name: d.replyFileName ?? d.reply_to_file_name ?? null,
            format_type: d.formatType ?? d.format_type ?? null,
            metadata: d.metadata ?? null,
            _mediaState: d.mediaState ?? null,
            _mediaProgress:
              typeof d.mediaProgress === "number" ? d.mediaProgress : 0,
            _failureReason: d.failureReason ?? null,
            media_job_id: d.mediaJobId ?? null,
          },
        ]);
      });
      markReadAndSync();
      // Acknowledge delivery so the sender sees "✓✓ delivered" (mirrors the
      // web ackDelivered call in the chat_message WS handler).
      if (d.senderId !== user?.id && d.id) {
        ackDelivered(d.id).catch(() => {});
      }
      // Only auto-scroll to the newest message when the user is ALREADY at the
      // bottom, OR when the new message is the user's OWN (sent from another of
      // their devices). If they've scrolled up to read history, keep their
      // position — the floating "scroll to latest" pill (driven by the list's
      // own scroll tracking) lets them jump down deliberately, exactly like
      // Signal-Android. This removes the "a new message yanks me to the bottom
      // mid-read" jump.
      const isOwn = d.senderId === user?.id;
      if (isOwn || atBottomRef.current) scrollToEnd(true);
    });
    return off;
  }, [convId, user?.id, loadPinned, markReadAndSync, scrollToEnd, router]);

  const send = useCallback(() => {
    const content = text.trim();
    if (!content || !user) return;
    const clientMsgId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const replyToId = replyTo?.id;
    const createdAt = new Date().toISOString();
    // Persist to the durable OUTBOX first (Signal-Android model: write the
    // message locally before attempting delivery). If the socket is down
    // (offline) the message is NOT lost — it survives leaving the screen and
    // app restarts, and ChatOutboxSync auto-delivers it (same clientMsgId, so
    // no duplicates) the moment the socket reconnects.
    enqueueOutboxMessage({
      clientMsgId,
      conversationId: convId,
      content,
      replyToId: replyToId ?? null,
      replyToContent: replyTo?.content ?? null,
      replyToSenderName: replyTo?.sender_name ?? null,
      replyToFileUrl: replyTo?.file_url ?? null,
      replyToFileType: replyTo?.file_type ?? null,
      replyToFileName: replyTo?.file_name ?? null,
      createdAt,
      attempts: 0,
    });
    // Optimistic append.
    setMessages((prev) => [
      ...prev,
      {
        id: -Date.now(),
        sender_id: user.id,
        sender_name: user.full_name,
        content,
        created_at: createdAt,
        reply_to_id: replyToId ?? null,
        reply_to_content: replyTo?.content ?? null,
        reply_to_sender_name: replyTo?.sender_name ?? null,
        reply_to_file_url: replyTo?.file_url ?? null,
        reply_to_file_type: replyTo?.file_type ?? null,
        reply_to_file_name: replyTo?.file_name ?? null,
        _pending: true,
        clientMsgId,
      },
    ]);
    const sentNow = socket.send("chat_message", {
      conversationId: convId,
      content,
      clientMsgId,
      ...(replyToId ? { replyToId } : {}),
    });
    if (!sentNow) {
      // Socket is down (offline / reconnecting). Kick a reconnect attempt —
      // the outbox flush on the next OPEN transition will deliver the message.
      // The bubble stays in the "pending" (clock) state meanwhile.
      void socket.connect();
    }
    setText("");
    setReplyTo(null);
    scrollToEnd(true);
  }, [text, user, convId, replyTo, scrollToEnd]);

  const retryFailedMessage = useCallback(
    (message: ChatMessage) => {
      if (Number(message.id) < 0 && message.file_url) {
        const id = Number(message.id);
        const source = mediaUploadSources.current.get(id);
        if (!source) return;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === id
              ? {
                  ...m,
                  _pending: true,
                  _failed: false,
                  _mediaState: "queued",
                  _mediaProgress: 0,
                  _failureReason: null,
                }
              : m,
          ),
        );
        const controller = new AbortController();
        mediaUploadControllers.current.set(id, controller);
        setUploading(true);
        uploadChatFile(convId, source.uri, source.fileName, source.mimeType, {
          signal: controller.signal,
          onUploadProgress: (evt) => {
            const total = evt.total || 0;
            const progress =
              total > 0
                ? Math.max(
                    0,
                    Math.min(100, Math.round((evt.loaded / total) * 100)),
                  )
                : 0;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === id
                  ? { ...m, _mediaState: "uploading", _mediaProgress: progress }
                  : m,
              ),
            );
          },
        })
          .then(({ data }) => {
            const normalized = normalizeUploadedMessage(data);
            setMessages((prev) => {
              const replaced = prev.map((m) =>
                m.id === id
                  ? {
                      ...normalized,
                      // Preserve intrinsic dimensions captured optimistically so
                      // the bubble keeps its aspect-ratio size (server metadata
                      // may omit them).
                      metadata: {
                        ...(m.metadata || {}),
                        ...(normalized.metadata || {}),
                      },
                      _pending: false,
                      _failed: false,
                    }
                  : m,
              );
              const seen = new Set<number>();
              return replaced.filter((m) => {
                const key = Number(m.id);
                if (!Number.isFinite(key)) return true;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
              });
            });
            mediaUploadControllers.current.delete(id);
            mediaUploadSources.current.delete(id);
            if (mediaUploadControllers.current.size === 0) setUploading(false);
            scrollToEnd(true);
          })
          .catch((e: any) => {
            mediaUploadControllers.current.delete(id);
            if (mediaUploadControllers.current.size === 0) setUploading(false);
            const cancelled =
              e?.name === "CanceledError" ||
              e?.code === "ERR_CANCELED" ||
              e?.message === "canceled";
            setMessages((prev) =>
              prev.map((m) =>
                m.id === id
                  ? {
                      ...m,
                      _pending: false,
                      _failed: true,
                      _mediaState: "failed",
                      _failureReason: cancelled
                        ? "Upload cancelled"
                        : e?.response?.data?.error ||
                          "Could not send this media.",
                    }
                  : m,
              ),
            );
          });
        return;
      }
      if (!user) return;
      const content = (message.content || "").trim();
      const clientMsgId = message.clientMsgId || null;
      if (!content || !clientMsgId) return;
      const replyToId = message.reply_to_id || null;

      // Refresh / re-arm the durable outbox entry so the retry also benefits
      // from the reconnect auto-flush (and survives leaving the screen).
      markOutboxRetrying(clientMsgId);
      enqueueOutboxMessage({
        clientMsgId,
        conversationId: convId,
        content,
        replyToId,
        replyToContent: message.reply_to_content ?? null,
        replyToSenderName: message.reply_to_sender_name ?? null,
        replyToFileUrl: message.reply_to_file_url ?? null,
        replyToFileType: message.reply_to_file_type ?? null,
        replyToFileName: message.reply_to_file_name ?? null,
        createdAt: new Date().toISOString(),
        attempts: 0,
      });

      setMessages((prev) =>
        prev.map((m) =>
          m.clientMsgId === clientMsgId
            ? {
                ...m,
                _failed: false,
                _pending: true,
                _failureReason: null,
                created_at: new Date().toISOString(),
              }
            : m,
        ),
      );

      const sentNow = socket.send("chat_message", {
        conversationId: convId,
        content,
        clientMsgId,
        ...(replyToId ? { replyToId } : {}),
      });
      if (!sentNow) {
        void socket.connect();
      }
    },
    [convId, scrollToEnd, user],
  );

  const onChangeText = useCallback(
    (v: string) => {
      setText(v);
      // Throttle typing pings to one per ~2s.
      const now = Date.now();
      if (now - typingSentAt.current > 2000) {
        typingSentAt.current = now;
        socket.send("chat_typing", { conversationId: convId });
      }
    },
    [convId],
  );

  async function startRecording() {
    // Guard against a double-tap while a recording is already underway.
    if (recordingRef.current) return;
    let granted = false;
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      granted = perm.granted;
    } catch {
      granted = false;
    }
    if (!granted) {
      alert(
        "Microphone needed",
        "Allow microphone access to record a voice message.",
      );
      return;
    }
    // Flip the recording UI ON synchronously and MOUNT the recorder controller
    // (gated by isRecordingActive). The controller owns the native recorder and
    // auto-prepares + starts recording on mount — keeping all audio init OFF the
    // chat-open path (see VoiceRecorderController).
    recordingRef.current = true;
    setRecordingMillis(0);
    setIsRecordingActive(true);
  }

  // Push the live recording duration up from the mounted controller.
  const onRecorderDuration = useCallback((millis: number) => {
    setRecordingMillis(millis);
  }, []);

  // Surface a recorder error via the shared dialog.
  const onRecorderError = useCallback(
    (title: string, message: string) => {
      alert(title, message);
    },
    [alert],
  );

  // The controller failed to START (permission/prepare) — collapse the UI and
  // unmount it so the mic can be tapped again cleanly.
  const onRecorderStartFailed = useCallback(() => {
    recordingRef.current = false;
    setIsRecordingActive(false);
    setRecordingMillis(0);
  }, []);

  async function stopRecordingAndSend() {
    if (!recordingRef.current) return;
    recordingRef.current = false;
    const handle = voiceHandleRef.current;

    let result: { uri: string; durationMillis: number } | null = null;
    try {
      result = handle ? await handle.stopAndSend() : null;
    } finally {
      // Unmount the recorder controller (releases the native recorder) and
      // collapse the recording bar.
      setIsRecordingActive(false);
      setRecordingMillis(0);
    }

    if (!result) return; // controller already surfaced any error
    const { uri, durationMillis } = result;

    if (durationMillis < 350) {
      alert(
        "Recording too short",
        "Hold the mic a little longer before sending.",
      );
      return;
    }
    try {
      const info = await FileSystem.getInfoAsync(uri);
      if (!info.exists || (info.size ?? 0) <= 0) {
        alert("Recording failed", "The recorded file is empty.");
        return;
      }
    } catch {
      alert("Recording failed", "The recorded file could not be read.");
      return;
    }

    enqueueMediaUpload({
      uri,
      fileName: `voice-${Date.now()}.m4a`,
      mimeType: "audio/mp4",
    });
  }

  async function cancelRecording() {
    if (!recordingRef.current) return;
    recordingRef.current = false;
    const handle = voiceHandleRef.current;
    try {
      await handle?.cancel();
    } finally {
      // Unmount the recorder controller + collapse the recording bar.
      setIsRecordingActive(false);
      setRecordingMillis(0);
    }
  }

  const uploadSingleMedia = useCallback(
    async (tempId: number, source: PendingMediaSource) => {
      const controller = new AbortController();
      mediaUploadControllers.current.set(tempId, controller);
      setUploading(true);
      try {
        const { data } = await uploadChatFile(
          convId,
          source.uri,
          source.fileName,
          source.mimeType,
          {
            viewOnce: source.viewOnce,
            caption: source.caption,
            signal: controller.signal,
            onUploadProgress: (evt) => {
              const total = evt.total || 0;
              const progress =
                total > 0
                  ? Math.max(
                      0,
                      Math.min(100, Math.round((evt.loaded / total) * 100)),
                    )
                  : 0;
              // Live throughput (bytes/sec) for the Signal-style speed label.
              const now = Date.now();
              const prevTs = uploadProgressTs.current.get(tempId);
              let speed = 0;
              if (prevTs && now > prevTs.t) {
                const dBytes = evt.loaded - prevTs.loaded;
                const dt = (now - prevTs.t) / 1000;
                if (dt > 0 && dBytes > 0) speed = dBytes / dt;
              }
              uploadProgressTs.current.set(tempId, {
                t: now,
                loaded: evt.loaded,
              });
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === tempId
                    ? {
                        ...m,
                        _mediaState: "uploading",
                        _mediaProgress: progress,
                        _uploadSpeed: speed || m._uploadSpeed,
                      }
                    : m,
                ),
              );
            },
          },
        );
        uploadProgressTs.current.delete(tempId);
        const normalized = normalizeUploadedMessage(data);
        setMessages((prev) => {
          const replaced = prev.map((m) =>
            m.id === tempId
              ? {
                  ...normalized,
                  // Keep intrinsic dimensions from the optimistic message so the
                  // image doesn't reflow when the server row arrives.
                  metadata: {
                    ...(m.metadata || {}),
                    ...(normalized.metadata || {}),
                  },
                  _pending: false,
                  _failed: false,
                }
              : m,
          );
          const seen = new Set<number>();
          return replaced.filter((m) => {
            const key = Number(m.id);
            if (!Number.isFinite(key)) return true;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        });
        mediaUploadControllers.current.delete(tempId);
        mediaUploadSources.current.delete(tempId);
        if (mediaUploadControllers.current.size === 0) setUploading(false);
        scrollToEnd(true);
      } catch (e: any) {
        mediaUploadControllers.current.delete(tempId);
        if (mediaUploadControllers.current.size === 0) setUploading(false);
        const cancelled =
          e?.name === "CanceledError" ||
          e?.code === "ERR_CANCELED" ||
          e?.message === "canceled";
        setMessages((prev) =>
          prev.map((m) =>
            m.id === tempId
              ? {
                  ...m,
                  _pending: false,
                  _failed: true,
                  _mediaState: "failed",
                  _failureReason: cancelled
                    ? "Upload cancelled"
                    : e?.response?.data?.error || "Could not send this media.",
                }
              : m,
          ),
        );
      }
    },
    [convId, scrollToEnd],
  );

  const enqueueMediaUpload = useCallback(
    (source: PendingMediaSource) => {
      const tempId = -(Date.now() + Math.floor(Math.random() * 1000));
      mediaUploadSources.current.set(tempId, source);
      // Carry intrinsic dimensions in metadata so the optimistic bubble sizes
      // itself by aspect ratio immediately (Signal-style) — no reflow once the
      // server row arrives.
      const dimMeta =
        source.width && source.height
          ? { width: source.width, height: source.height }
          : {};
      setMessages((prev) => [
        ...prev,
        {
          id: tempId,
          sender_id: user?.id || 0,
          sender_name: user?.full_name || "You",
          content: source.caption || "",
          created_at: new Date().toISOString(),
          file_url: source.uri,
          file_name: source.fileName,
          file_type: source.mimeType || null,
          file_size: null,
          metadata: source.viewOnce
            ? { viewOnce: true, viewedBy: [], ...dimMeta }
            : Object.keys(dimMeta).length
              ? dimMeta
              : null,
          reactions: [],
          _pending: true,
          _failed: false,
          _mediaState: "queued",
          _mediaProgress: 0,
          _failureReason: null,
        },
      ]);
      uploadSingleMedia(tempId, source);
      scrollToEnd(true);
    },
    [scrollToEnd, uploadSingleMedia, user?.full_name, user?.id],
  );

  const draftStorageKey = useMemo(() => `chat:draft:${convId}`, [convId]);

  // Restore per-conversation compose draft (text/reply/edit + pending media
  // descriptors) so app restarts/backgrounding don't lose composer context.
  useEffect(() => {
    let cancelled = false;
    draftHydrated.current = false;
    pendingDraftReply.current = null;
    pendingDraftEditing.current = null;
    pendingDraftMedia.current = [];
    SecureStore.getItemAsync(draftStorageKey)
      .then((raw: string | null) => {
        if (cancelled || !raw) {
          draftHydrated.current = true;
          return;
        }
        let parsed: ConversationDraft | null = null;
        try {
          parsed = JSON.parse(raw) as ConversationDraft;
        } catch {
          parsed = null;
        }
        if (!parsed) {
          draftHydrated.current = true;
          return;
        }
        if (typeof parsed.text === "string") setText(parsed.text);
        pendingDraftReply.current = parsed.replyTo || null;
        pendingDraftEditing.current = parsed.editing || null;
        pendingDraftMedia.current = Array.isArray(parsed.mediaDrafts)
          ? parsed.mediaDrafts
          : [];
        draftHydrated.current = true;
      })
      .catch(() => {
        draftHydrated.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [draftStorageKey]);

  useEffect(() => {
    if (!draftHydrated.current) return;
    if (pendingDraftMedia.current.length === 0) return;
    const drafts = [...pendingDraftMedia.current];
    pendingDraftMedia.current = [];
    for (const d of drafts) {
      enqueueMediaUpload(d);
    }
  }, [enqueueMediaUpload, convId]);

  useEffect(() => {
    if (!draftHydrated.current) return;
    if (pendingDraftReply.current?.id) {
      const target = messages.find(
        (m) => m.id === pendingDraftReply.current!.id,
      );
      if (target) {
        setReplyTo(target);
        pendingDraftReply.current = null;
      }
    }
    if (pendingDraftEditing.current?.id) {
      const target = messages.find(
        (m) => m.id === pendingDraftEditing.current!.id,
      );
      if (target) {
        setEditingId(Number(target.id));
        setText(
          typeof pendingDraftEditing.current.text === "string"
            ? pendingDraftEditing.current.text
            : target.content || "",
        );
        pendingDraftEditing.current = null;
      }
    }
  }, [messages]);

  useEffect(() => {
    if (!draftHydrated.current) return;
    const mediaDrafts: PendingMediaSource[] = messages
      .filter((m) => Number(m.id) < 0 && !!m.file_url)
      .map((m) => ({
        uri: String(m.file_url),
        fileName: String(m.file_name || `draft-${Math.abs(Number(m.id))}`),
        mimeType: m.file_type || undefined,
      }));
    const payload: ConversationDraft = {
      text,
      replyTo: replyTo
        ? {
            id: Number(replyTo.id),
            content: replyTo.content || null,
            sender_name: replyTo.sender_name || null,
          }
        : null,
      editing: editingId
        ? {
            id: editingId,
            text,
          }
        : null,
      mediaDrafts,
    };
    if (
      !payload.text.trim() &&
      !payload.replyTo &&
      !payload.editing &&
      payload.mediaDrafts.length === 0
    ) {
      SecureStore.deleteItemAsync(draftStorageKey).catch(() => {});
      return;
    }
    SecureStore.setItemAsync(draftStorageKey, JSON.stringify(payload)).catch(
      () => {},
    );
  }, [draftStorageKey, text, replyTo, editingId, messages]);

  async function uploadPickedMedia(
    uri: string,
    fallbackName: string,
    mimeType?: string,
  ) {
    enqueueMediaUpload({ uri, fileName: fallbackName, mimeType });
  }

  async function attachFile() {
    setPlusOpen(false);
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      alert("Permission needed", "Allow Photos access to share media.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 1,
      allowsMultipleSelection: true,
    });
    if (result.canceled || !result.assets?.length) return;
    // Route picked images through the Signal-style media editor.
    setEditorItems(
      result.assets.map((a) => ({
        uri: a.uri,
        width: a.width,
        height: a.height,
      })),
    );
  }

  // Open the Signal-style in-app camera (full-screen). Replaces the old OS-only
  // image picker so the user can TAP for a photo, HOLD for video, flip/flash and
  // pick from a recent-gallery strip — none of which the OS launchCameraAsync
  // (image-only) supported. The camera UI lives in CameraCapture, rendered as a
  // full-screen Modal by the chat screen; its callbacks below route captures.
  function attachCamera() {
    setPlusOpen(false);
    setCameraOpen(true);
  }

  // A still PHOTO captured in the in-app camera → close the camera and route it
  // through the Signal-style media editor (pen/crop/quality/view-once + caption).
  const handleCameraPhoto = useCallback(
    (item: { uri: string; width?: number; height?: number }) => {
      setCameraOpen(false);
      setEditorItems([
        { uri: item.uri, width: item.width, height: item.height },
      ]);
    },
    [],
  );

  // A recorded VIDEO from the in-app camera → close the camera and open the
  // Signal-style preview (review + caption + view-once + send/discard) instead
  // of uploading immediately on shutter release.
  const handleCameraVideo = useCallback(
    (item: { uri: string; fileName: string; mimeType: string }) => {
      setCameraOpen(false);
      setVideoPreview({
        uri: item.uri,
        fileName: item.fileName,
        mimeType: item.mimeType,
      });
    },
    [],
  );

  // Send the previewed video (from the VideoPreview screen) with its caption and
  // view-once flag.
  const sendVideoPreview = useCallback(
    (opts: { caption?: string; viewOnce: boolean }) => {
      const v = videoPreview;
      setVideoPreview(null);
      if (!v) return;
      enqueueMediaUpload({
        uri: v.uri,
        fileName: v.fileName,
        mimeType: v.mimeType,
        viewOnce: opts.viewOnce,
        caption: opts.caption,
      });
    },
    [videoPreview, enqueueMediaUpload],
  );

  // A recent-gallery thumbnail tapped inside the in-app camera (or the "+"
  // attach sheet). Images go through the editor; videos upload directly.
  const handlePickRecentMedia = useCallback(
    (item: {
      uri: string;
      width?: number;
      height?: number;
      kind: "image" | "video";
      fileName?: string;
      mimeType?: string;
    }) => {
      setCameraOpen(false);
      setPlusOpen(false);
      if (item.kind === "video") {
        // Route videos through the review/caption preview (same as a recorded
        // clip) rather than uploading on tap.
        setVideoPreview({
          uri: item.uri,
          fileName: item.fileName || `video-${Date.now()}.mp4`,
          mimeType: item.mimeType || "video/mp4",
        });
      } else {
        setEditorItems([
          { uri: item.uri, width: item.width, height: item.height },
        ]);
      }
    },
    [],
  );

  // Called by the MediaEditor when the user taps Send. Each processed item is
  // enqueued for upload carrying its view-once flag + caption.
  const handleMediaEditorSend = useCallback(
    (
      results: {
        uri: string;
        fileName: string;
        mimeType: string;
        viewOnce: boolean;
        caption?: string;
      }[],
    ) => {
      results.forEach((r, i) => {
        enqueueMediaUpload({
          uri: r.uri,
          fileName: r.fileName,
          mimeType: r.mimeType,
          viewOnce: r.viewOnce,
          // Attach the caption to the first item only (matches Signal/web).
          caption: i === 0 ? r.caption : undefined,
        });
      });
      setEditorItems(null);
    },
    [enqueueMediaUpload],
  );

  async function attachGifFromEmoji() {
    setTenorKind("gif");
    setTenorOpen(true);
  }

  async function attachStickerFromEmoji() {
    setTenorKind("sticker");
    setTenorOpen(true);
  }

  async function pickTenorMedia(
    item: { mediaUrl: string },
    kind: "gif" | "sticker",
  ) {
    try {
      setTenorOpen(false);
      const ext = kind === "sticker" ? "webp" : "gif";
      const target = `${FileSystem.cacheDirectory}${kind}-${Date.now()}.${ext}`;
      const dl = await FileSystem.downloadAsync(item.mediaUrl, target);
      if (dl.status !== 200) {
        alert("Upload failed", "Could not download selected media.");
        return;
      }
      await uploadPickedMedia(
        dl.uri,
        `${kind}-${Date.now()}.${ext}`,
        kind === "sticker" ? "image/webp" : "image/gif",
      );
    } catch (e: any) {
      alert("Upload failed", e?.message || "Could not attach selected media.");
    }
  }

  // Document attachment — the old single "Photo / File" option only opened
  // the IMAGE library despite its label, so PDFs/docs could never be sent
  // from mobile (the web supports them). Uses expo-document-picker.
  async function attachDocument() {
    setPlusOpen(false);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled || !result.assets?.[0]?.uri) return;
      const asset = result.assets[0];
      await uploadPickedMedia(
        asset.uri,
        asset.name || `file-${Date.now()}`,
        asset.mimeType || undefined,
      );
    } catch (e: any) {
      alert(
        "Upload failed",
        e?.response?.data?.error || "Could not send this file.",
      );
    }
  }

  const cancelMediaUpload = useCallback((message: ChatMessage) => {
    const id = Number(message.id);
    const mediaJobId = Number(message.media_job_id || 0);
    if (mediaJobId > 0) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === message.id
            ? {
                ...m,
                _pending: false,
                _failed: true,
                _mediaState: "failed",
                _failureReason: "Upload cancelled",
              }
            : m,
        ),
      );
      cancelChatMediaJob(mediaJobId).catch(() => {});
      return;
    }
    if (!Number.isFinite(id) || id >= 0) return;
    const controller = mediaUploadControllers.current.get(id);
    controller?.abort();
  }, []);

  const retryMediaUpload = useCallback(
    (message: ChatMessage) => {
      const id = Number(message.id);
      const mediaJobId = Number(message.media_job_id || 0);
      if (mediaJobId > 0) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === message.id
              ? {
                  ...m,
                  _pending: true,
                  _failed: false,
                  _mediaState: "queued",
                  _mediaProgress: 0,
                  _failureReason: null,
                }
              : m,
          ),
        );
        retryChatMediaJob(mediaJobId).catch((e: any) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === message.id
                ? {
                    ...m,
                    _pending: false,
                    _failed: true,
                    _mediaState: "failed",
                    _failureReason: e?.response?.data?.error || "Retry failed",
                  }
                : m,
            ),
          );
        });
        return;
      }
      if (!Number.isFinite(id) || id >= 0) return;
      const source = mediaUploadSources.current.get(id);
      if (!source) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === id
            ? {
                ...m,
                _pending: true,
                _failed: false,
                _mediaState: "queued",
                _mediaProgress: 0,
                _failureReason: null,
              }
            : m,
        ),
      );
      uploadSingleMedia(id, source);
    },
    [uploadSingleMedia],
  );

  // Cancel an in-progress edit (Signal-style "X" on the editing strip). Clears
  // the editing target and the prefilled draft text.
  function cancelEdit() {
    setEditingId(null);
    setText("");
  }

  function startEdit(message: ChatMessage) {
    // Tear down BOTH long-press surfaces. Editing can be triggered from the
    // long-press reaction overlay (driven by reactTarget/reactAnchor) OR the
    // action sheet (actionTarget). Previously startEdit only cleared
    // actionTarget, so when reached via the long-press overlay the dimmed
    // ReactionOverlay modal stayed ON TOP of the screen and the edit never
    // appeared to take. Clear all three, load the draft, then focus the
    // composer so the system keyboard opens ready to edit.
    setReactTarget(null);
    setReactAnchor(null);
    setActionTarget(null);
    setEditingId(message.id);
    setText(message.content);
    // Focus after the overlay/sheet modals have dismissed so the keyboard
    // reliably opens (focusing while a modal is still up is dropped on Android).
    setTimeout(() => inputRef.current?.focus(), 150);
  }

  async function saveEdit() {
    if (editingId == null) return;
    const content = text.trim();
    if (!content) return;
    try {
      // The server's PUT /chat/messages/:id returns only { ok: true } — it does
      // NOT echo the edited content. Relying on `data.content` therefore blanked
      // the message body (leaving just the "edited" label) until the chat was
      // reopened. Apply the edit OPTIMISTICALLY from the text we just sent and
      // stamp `edited_at` so the "edited" label + new content show immediately
      // (Signal applies edits locally, never waiting for a content echo).
      await editMessage(editingId, content);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === editingId
            ? { ...m, content, edited_at: new Date().toISOString() }
            : m,
        ),
      );
    } catch {
      /* ignore */
    } finally {
      setEditingId(null);
      setText("");
    }
  }

  function doDelete(message: ChatMessage) {
    // Open the delete chooser for this single message (WhatsApp/Telegram/Signal
    // model). The chooser offers "Delete for everyone" (own messages only) and
    // "Delete for me" (local hide). Replaces the old immediate delete-for-
    // everyone confirm.
    requestDelete([message]);
  }

  function doPin(message: ChatMessage) {
    setActionTarget(null);
    pinMessage(message.id)
      .then(({ data }) => {
        const pinned = !!(data as { pinned?: boolean })?.pinned;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === message.id
              ? { ...m, pinned_at: pinned ? new Date().toISOString() : null }
              : m,
          ),
        );
        loadPinned();
        alert(
          pinned ? "Pinned" : "Unpinned",
          pinned ? "Message pinned to this chat." : "Message unpinned.",
        );
      })
      .catch(() => alert("Error", "Could not pin message."));
  }

  function doStar(message: ChatMessage) {
    setActionTarget(null);
    starMessage(message.id)
      .then(({ data }) => {
        const starred = !!(data as { starred?: boolean })?.starred;
        setStarredIds((prev) => {
          const next = new Set(prev);
          if (starred) next.add(message.id);
          else next.delete(message.id);
          return next;
        });
        alert(
          starred ? "Saved" : "Removed",
          starred ? "Message added to saved." : "Removed from saved.",
        );
      })
      .catch(() => alert("Error", "Could not save message."));
  }

  function unpinFromBanner(messageId: number) {
    pinMessage(messageId)
      .then(() => {
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, pinned_at: null } : m)),
        );
        loadPinned();
      })
      .catch(() => {});
  }

  function jumpToMessage(messageId: number) {
    // The list is INVERTED, so it is fed the reversed messages array — convert
    // the natural index to the reversed index before scrolling.
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return;
    const invertedIdx = messages.length - 1 - idx;
    try {
      listRef.current?.scrollToIndex({
        index: invertedIdx,
        animated: true,
        viewPosition: 0.3,
      });
    } catch {
      /* ignore */
    }
  }

  // Signal-style "tap a quoted reply → jump to the original": scroll the list
  // to the replied-to message and briefly flash its highlight (reuses the
  // search-match highlight). The original lives at `reply_to_id`; if it isn't
  // in the currently-loaded window we no-op gracefully (a best-effort jump,
  // same as the search/pinned cross-screen jumps).
  function jumpToReply(message: ChatMessage) {
    const targetId = message.reply_to_id;
    if (!targetId) return;
    const exists = messages.some((m) => m.id === targetId);
    if (!exists) return;
    jumpToMessage(targetId);
    // Flash the highlight: clear first so a transition null → id re-fires the
    // bubble's highlight effect even if it was the same id last time.
    setHighlightedId(null);
    setTimeout(() => setHighlightedId(targetId), 60);
    // Auto-clear the highlight after the flash so it doesn't stay tinted.
    setTimeout(() => setHighlightedId(null), 1400);
  }

  // ── Signal-style in-conversation search ───────────────────────────────────
  // Open the in-place search bar (called from the overflow menu). Dismisses the
  // keyboard-stealing emoji panel and clears any previous query/results.
  function openSearch() {
    setMenuOpen(false);
    setSearchQuery("");
    setSearchMatchIds([]);
    setSearchActiveIdx(0);
    setHighlightedId(null);
    setSearchMode(true);
  }

  // Close search and clear all of its transient state.
  function closeSearch() {
    setSearchMode(false);
    setSearchQuery("");
    setSearchMatchIds([]);
    setSearchActiveIdx(0);
    setHighlightedId(null);
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
  }

  const goBackToChatList = useCallback(() => {
    // Prefer a real stack pop so the already-painted chat list remains behind
    // the thread during Android/iOS back gestures. If this thread was launched
    // as a root route (cold notification/deep link), fall back to the chat tab.
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace("/(tabs)/chat" as never);
  }, [router]);

  const handleThreadBack = useCallback(() => {
    if (selectionMode) {
      clearSelection();
      return true;
    }
    if (searchMode) {
      closeSearch();
      return true;
    }
    goBackToChatList();
    return true;
  }, [goBackToChatList, searchMode, selectionMode]);

  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener(
        "hardwareBackPress",
        handleThreadBack,
      );
      return () => sub.remove();
    }, [handleThreadBack]),
  );

  // Scroll the (inverted) list to a matched message and flash its highlight.
  // Re-applies highlightedId even for the same id by briefly clearing it so the
  // bubble's highlight effect re-fires when stepping onto the same match twice.
  function focusMatch(messageId: number) {
    jumpToMessage(messageId);
    setHighlightedId(null);
    // Next tick so the bubble sees a transition from null → id and re-flashes.
    setTimeout(() => setHighlightedId(messageId), 30);
  }

  // Debounced query → server search scoped to this conversation. Results are
  // mapped to the message ids that are present in the loaded thread (so we can
  // scroll to them) and ordered oldest-first to match `messages`.
  function onSearchQueryChange(v: string) {
    setSearchQuery(v);
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    const q = v.trim();
    if (q.length < 2) {
      setSearchMatchIds([]);
      setSearchActiveIdx(0);
      setHighlightedId(null);
      return;
    }
    searchDebounce.current = setTimeout(() => {
      searchMessages(q, convId)
        .then((r) => {
          const ids = (r.data || []).map((m) => m.id);
          // Keep only ids currently loaded in the thread and order them to
          // match the message list (oldest → newest).
          const present = messages
            .filter((m) => ids.includes(m.id))
            .map((m) => m.id);
          setSearchMatchIds(present);
          if (present.length > 0) {
            // Signal lands on the NEWEST match first.
            const startIdx = present.length - 1;
            setSearchActiveIdx(startIdx);
            focusMatch(present[startIdx]);
          } else {
            setSearchActiveIdx(0);
            setHighlightedId(null);
          }
        })
        .catch(() => {
          setSearchMatchIds([]);
          setSearchActiveIdx(0);
          setHighlightedId(null);
        });
    }, 300);
  }

  // Step to the PREVIOUS (older) match — up arrow in Signal's search nav bar.
  function searchPrev() {
    if (searchMatchIds.length === 0) return;
    const next = Math.max(0, searchActiveIdx - 1);
    setSearchActiveIdx(next);
    focusMatch(searchMatchIds[next]);
  }

  // Step to the NEXT (newer) match — down arrow.
  function searchNext() {
    if (searchMatchIds.length === 0) return;
    const next = Math.min(searchMatchIds.length - 1, searchActiveIdx + 1);
    setSearchActiveIdx(next);
    focusMatch(searchMatchIds[next]);
  }

  // ── Header 3-dot menu (mirrors the web ChatHeader overflow menu) ──

  function openHeaderPanel(panel: HeaderSheet) {
    if (panel === "search") {
      setSheetSearchQ("");
      setSheetSearchResults([]);
    } else if (panel === "pinned") {
      loadPinned();
    } else if (panel === "files") {
      setSheetLoading(true);
      getSharedFiles(convId)
        .then((r) => setSharedFiles(r.data || []))
        .catch(() => setSharedFiles([]))
        .finally(() => setSheetLoading(false));
    } else if (panel === "saved") {
      setSheetLoading(true);
      getStarredMessages()
        .then((r) => setSavedMsgs(r.data || []))
        .catch(() => setSavedMsgs([]))
        .finally(() => setSheetLoading(false));
    }
    setHeaderSheet(panel);
  }

  // ── Signal-style navigation: header → profile, overflow → sub-screens ──
  const baseParams = {
    id: String(convId),
    name: name || "",
    avatar: headerAvatar || "",
    peerId: peerUserId ? String(peerUserId) : "",
    isGroup: isGroupConv ? "1" : "0",
    groupMemberAvatars: JSON.stringify(groupMemberAvatars),
    peerStatus: peerStatus || "",
    peerWorkMode: peerWorkMode || "",
    memberCount: String(participantCount),
    myRole: myGroupRole,
    description: groupDescription,
  };

  function openInfo() {
    router.push({ pathname: "/chat/info", params: baseParams });
  }

  function openSearchScreen() {
    router.push({
      pathname: "/chat/search",
      params: { id: String(convId), name: name || "" },
    });
  }

  function openSharedMedia(
    tab: "images" | "videos" | "media" | "files" | "links" = "images",
  ) {
    router.push({
      pathname: "/chat/shared",
      params: { id: String(convId), name: name || "", tab },
    });
  }

  function openPinnedScreen() {
    router.push({
      pathname: "/chat/saved",
      params: { id: String(convId), name: name || "", mode: "pinned" },
    });
  }

  function openSavedScreen() {
    router.push({
      pathname: "/chat/saved",
      params: { id: String(convId), name: name || "", mode: "saved" },
    });
  }

  function onSheetSearchChange(v: string) {
    setSheetSearchQ(v);
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    const q = v.trim();
    if (q.length < 2) {
      setSheetSearchResults([]);
      return;
    }
    searchDebounce.current = setTimeout(() => {
      setSheetLoading(true);
      searchMessages(q, convId)
        .then((r) => setSheetSearchResults(r.data || []))
        .catch(() => setSheetSearchResults([]))
        .finally(() => setSheetLoading(false));
    }, 300);
  }

  // Close the sheet first, then jump — scrollToIndex while a modal is
  // dismissing gets swallowed on Android.
  function jumpFromSheet(messageId: number) {
    setHeaderSheet(null);
    setTimeout(() => jumpToMessage(messageId), 350);
  }

  // Clear chat — Signal-style, LOCAL/device-only. This never touches the other
  // participant's copy (the old behaviour wrongly called the server, which
  // wiped the conversation for everyone). We record a per-conversation "cleared
  // at" cutoff so every message up to now is hidden on THIS device — including
  // messages not yet loaded via pagination — while NEW messages that arrive
  // afterwards still appear. The cutoff is persisted so the clear survives
  // reloads/app restarts.
  // Block / unblock the 1:1 peer (Signal parity — the peer is never notified).
  function doToggleBlock() {
    if (!peerUserId) return;
    if (isBlocked) {
      unblockUser(peerUserId)
        .then(() => setIsBlocked(false))
        .catch(() => {});
      return;
    }
    confirm({
      title: `Block ${name || "this user"}?`,
      message:
        "Blocked people can't send you messages or call you. They won't be notified.",
      confirmText: "Block",
      isDanger: true,
      onConfirm: () => {
        blockUser(peerUserId)
          .then(() => setIsBlocked(true))
          .catch(() => {});
      },
    });
  }

  function doClearChat() {
    setHeaderSheet(null);
    // Defer so the confirm dialog never collides with the dismissing modal.
    setTimeout(() => {
      confirm({
        title: "Clear chat",
        message:
          "Clear this chat on your device? The other person will still have their copy.",
        confirmText: "Clear",
        isDanger: true,
        onConfirm: () => {
          setClearedAt(convId);
          setMessages([]);
          setPinnedMsgs([]);
          setHasMore(false);
          clearCachedMessages(convId);
        },
      });
    }, 300);
  }

  function unstarFromSheet(messageId: number) {
    starMessage(messageId)
      .then(() => {
        setSavedMsgs((prev) => prev.filter((m) => m.id !== messageId));
        setStarredIds((prev) => {
          const next = new Set(prev);
          next.delete(messageId);
          return next;
        });
      })
      .catch(() => {});
  }

  function startReply(message: ChatMessage) {
    setActionTarget(null);
    setReactTarget(null);
    setReactAnchor(null);
    setReplyTo(message);
    // Signal opens the keyboard with the cursor in the composer the moment you
    // swipe-to-reply (or tap Reply). Focus after the reply strip + any
    // dismissing overlay have settled so the keyboard reliably raises on
    // Android (focusing while a modal is up, or before the reply strip mounts,
    // is dropped).
    setTimeout(() => inputRef.current?.focus(), 120);
  }

  // Copy a message's text to the clipboard (overlay "Copy" action).
  function copyMessage(message: ChatMessage) {
    setReactTarget(null);
    setReactAnchor(null);
    if (message.content) {
      Clipboard.setStringAsync(message.content).catch(() => {});
    }
  }

  // Open the Forward picker for a message reached from the reaction overlay.
  // The overlay's target lives in `reactTarget`; we promote it to
  // `actionTarget` (which drives the forward picker modal + doForward) and
  // switch into forward mode.
  function openForwardFor(message: ChatMessage) {
    setReactTarget(null);
    setReactAnchor(null);
    setActionTarget(message);
    getConversations()
      .then((r) => setConversations(r.data || []))
      .catch(() => setConversations([]));
    setForwardMode(true);
  }

  function openForward() {
    // Switch the already-open action-sheet modal into "forward" mode. We do
    // NOT dismiss this modal and present another — that cross-modal race on
    // Android is what made Forward silently fail before.
    setReactTarget(null);
    // Preload conversations so the picker isn't empty when it appears.
    getConversations()
      .then((r) => setConversations(r.data || []))
      .catch(() => setConversations([]));
    setForwardMode(true);
  }

  function closeActionSheet() {
    setActionTarget(null);
    setForwardMode(false);
    setForwardSelection([]);
  }

  function doForward(targetConvId: number) {
    // Multi-select forward: if a selection was promoted to `forwardSelection`,
    // fan the forward out across every selected message id. Otherwise fall back
    // to the single `actionTarget` (reaction-overlay / action-sheet path).
    const targets =
      forwardSelection.length > 0
        ? forwardSelection
        : actionTarget
          ? [actionTarget]
          : [];
    if (targets.length === 0) return;
    closeActionSheet();
    clearSelection();
    Promise.all(targets.map((m) => forwardMessage(m.id, [targetConvId])))
      .then(() => {
        // Small defer so the result dialog never collides with the
        // dismissing modal.
        setTimeout(
          () =>
            alert(
              "Forwarded",
              targets.length > 1
                ? `${targets.length} messages forwarded.`
                : "Message forwarded.",
            ),
          300,
        );
      })
      .catch((e: any) => {
        setTimeout(
          () =>
            alert(
              "Error",
              e?.response?.data?.error || "Could not forward message.",
            ),
          300,
        );
      });
  }

  // Short subtle tone played when a reaction is ADDED (Signal-style audible
  // feedback). Uses the same synthesized data-URI mechanism as the realtime
  // notification sounds so no audio asset is needed.
  function playReactionSound() {
    try {
      const uri = getNotificationPreviewDataUri("reaction", "subtle");
      if (!uri) return;
      setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
      }).catch(() => {});
      // Create the native player on first use (kept off the chat-open path).
      let player = reactionSoundPlayerRef.current;
      if (!player) {
        player = createAudioPlayer();
        reactionSoundPlayerRef.current = player;
      }
      player.replace({ uri });
      player.play();
    } catch {
      /* no-op */
    }
  }

  async function react(message: ChatMessage, emoji: string) {
    if (message.deleted_at) return;
    setReactTarget(null);
    // Determine whether this toggle ADDS a reaction (vs removes it) so the
    // haptic + sound feedback only fires on add (Signal only buzzes/plays when
    // you place a reaction, not when you clear one).
    const willAdd = !(message.reactions || []).some(
      (r) => r.userId === user?.id && r.emoji === emoji,
    );
    // Optimistic toggle FIRST (mirrors web handleReact): the chip appears /
    // disappears instantly. Doing the API call before the state update caused
    // two bugs: (a) the reaction only showed after the network round-trip and
    // (b) a remove raced the server's WS "removed" fan-out — the WS handler
    // removed the chip, then the late local toggle re-ADDED it, making
    // "remove reaction" appear broken.
    const applyToggle = (prev: ChatMessage[]) =>
      prev.map((m) => {
        if (m.id !== message.id) return m;
        if (m.deleted_at) return { ...m, reactions: [] };
        const existing = m.reactions || [];
        const mineIdx = existing.findIndex(
          (r) => r.userId === user?.id && r.emoji === emoji,
        );
        if (mineIdx >= 0) {
          return { ...m, reactions: existing.filter((_, i) => i !== mineIdx) };
        }
        return {
          ...m,
          reactions: [
            ...existing,
            { emoji, userId: user?.id ?? 0, fullName: user?.full_name ?? "" },
          ],
        };
      });
    setMessages(applyToggle);
    // Haptic + subtle sound on ADD (Signal parity).
    if (willAdd) {
      try {
        Vibration.vibrate(12);
      } catch {
        /* no-op */
      }
      playReactionSound();
    }
    try {
      await toggleReaction(message.id, emoji);
    } catch {
      // API failed — revert the optimistic toggle so UI matches the server.
      setMessages(applyToggle);
    }
  }

  function pickEmoji(emoji: string) {
    if (emojiMode === "compose") {
      setText((t) => t + emoji);
    } else if (reactTarget) {
      // Apply the chosen reaction to the long-pressed message. `react()` clears
      // reactTarget itself, but clear the anchor too so the reaction overlay
      // doesn't briefly re-appear behind the closing picker.
      react(reactTarget, emoji);
      setReactAnchor(null);
    }
    setShowAllEmoji(false);
  }

  // Close the full emoji picker WITHOUT picking. In "react" mode this must also
  // drop the long-pressed target/anchor, otherwise the reaction overlay (which
  // is hidden only while the picker is open) would pop straight back up.
  function closeEmojiPicker() {
    setShowAllEmoji(false);
    if (emojiMode === "react") {
      setReactTarget(null);
      setReactAnchor(null);
    }
  }

  // ── Inline emoji keyboard (Signal-style composer toggle) ──────────────────
  // Toggle between the system keyboard and the docked in-app emoji keyboard.
  function toggleEmojiKeyboard() {
    if (emojiKeyboardFocusTimer.current) {
      clearTimeout(emojiKeyboardFocusTimer.current);
      emojiKeyboardFocusTimer.current = null;
    }
    if (emojiKeyboardOpen) {
      // Emoji → system keyboard. This transition fights TWO Android quirks at
      // once, so it needs BOTH a blur AND a long-enough delayed focus:
      //
      //  1. No-op focus: the native EditText KEEPS its focus after a
      //     `Keyboard.dismiss()` (which is how the emoji panel was opened). On
      //     Android, calling `.focus()` on an already-focused field does NOT
      //     re-raise the soft keyboard — it's a no-op. So we must `blur()`
      //     first to force a real focus *change* on the later focus() call.
      //     (No keyboard is visible here — the emoji panel is — so the blur
      //     can't "collapse" anything.)
      //
      //  2. Prop-commit race: closing the panel flips the TextInput's
      //     `showSoftInputOnFocus` false → true, and Android can still see the
      //     stale native prop for a frame or two. If focus() fires too early the
      //     keyboard is suppressed and the transition feels "stuck". Keeping the
      //     emoji panel mounted removes the heavy unmount cost, so a short delay
      //     is now enough — and we cancel it on rapid re-taps so old focus
      //     requests cannot fight a newer emoji transition.
      //
      // Mirrors Signal-Android's InputAwareLayout, which requests the soft
      // input on its edit text only after the emoji page has been torn down,
      // treating keyboard↔emoji as an explicit transition.
      emojiSearchFocused.current = false;
      setEmojiKeyboardOpen(false);
      inputRef.current?.blur();
      emojiKeyboardFocusTimer.current = setTimeout(() => {
        emojiKeyboardFocusTimer.current = null;
        if (!emojiKeyboardOpenRef.current) inputRef.current?.focus();
      }, 90);
    } else {
      // System → emoji: dismiss the OS keyboard, then dock the emoji keyboard.
      // Arm the guard FIRST so the safety effect ignores the system keyboard's
      // still-animating (stale) height — otherwise the emoji panel we open on
      // the next line would be instantly closed again (the dismiss is async).
      ignoreKbForEmoji.current = true;
      emojiSearchFocused.current = false;
      // BLUR the field before dismissing. With the input still focused, RN
      // re-evaluates showSoftInputOnFocus and on Android re-shows the system
      // keyboard mid-transition — collapsing the docked panel and forcing the
      // user to tap the toggle/field again. Blurring first commits the keyboard
      // dismissal so the emoji panel mounts cleanly (Signal blurs before its
      // InputAwareLayout swaps to the emoji page).
      inputRef.current?.blur();
      Keyboard.dismiss();
      setEmojiKeyboardOpen(true);
    }
  }

  // Called from the docked emoji keyboard — insert at the end of the draft.
  function insertEmoji(native: string) {
    setText((t) => t + native);
  }

  // Backspace key on the docked emoji keyboard (mobile keyboard mode).
  function emojiBackspace() {
    setText((t) => Array.from(t).slice(0, -1).join(""));
  }

  // When the field gains focus via a tap, ensure the emoji keyboard is closed.
  function onComposerInputFocus() {
    if (emojiKeyboardOpen) setEmojiKeyboardOpen(false);
  }

  function onEmojiSearchFocus() {
    emojiSearchFocused.current = true;
  }

  function onEmojiSearchBlur() {
    emojiSearchFocused.current = false;
  }

  function startCall(type: "voice" | "video") {
    if (isGroupConv) {
      void startGroupCall(type);
      return;
    }
    router.push({
      pathname: "/call/[conversationId]",
      params: {
        conversationId: String(convId),
        mode: "outgoing",
        callType: type,
        peerName: name || "Call",
        peerAvatar: headerAvatar || "",
        isGroup: isGroupConv ? "1" : "0",
      },
    });
  }

  // Start an instant GROUP CALL (huddle). The group stays a pure chat group:
  // the server creates a hidden huddle (no "Meeting:" rename / no meeting card /
  // no calendar artifact) bound to THIS conversation and RINGS every member with
  // `call_incoming` (Signal-style group call). The initiator joins the n-way
  // mesh by navigating to the meeting room with the returned code.
  async function startGroupCall(type: "voice" | "video") {
    try {
      const { data } = await createMeeting({
        title: name || "Group call",
        conversation_id: convId,
        huddle: true,
        settings: { allowScreenShare: true, callType: type },
      });
      const code = data?.meeting_code;
      if (code) {
        // Huddle auto-join (no meeting lobby) + audio-only for a voice call.
        router.push(
          `/meeting/${code}?huddle=1&callType=${type}` as never,
        );
      } else {
        alert("Call failed", "Could not start the group call. Please try again.");
      }
    } catch {
      alert("Call failed", "Could not start the group call. Please try again.");
    }
  }

  // ── Multi-select (Signal-style) ───────────────────────────────────────────
  // Clear the selection and exit selection mode.
  function clearSelection() {
    setSelectedIds(new Set());
  }

  // Toggle a single message in/out of the selection (used on tap while in
  // selection mode). Removing the last selected message exits selection mode.
  function toggleSelect(message: ChatMessage) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(message.id)) next.delete(message.id);
      else next.add(message.id);
      return next;
    });
  }

  // The currently-selected ChatMessage objects (oldest → newest order).
  const selectedMessages = useMemo(
    () => messages.filter((m) => selectedIds.has(m.id)),
    [messages, selectedIds],
  );
  // Whether EVERY selected message is the current user's own message — gates
  // the Delete-for-everyone action (you can only delete your own messages).
  const selectionAllOwn = useMemo(
    () =>
      selectedMessages.length > 0 &&
      selectedMessages.every((m) => Number(m.sender_id) === Number(user?.id)),
    [selectedMessages, user?.id],
  );

  // Pin / unpin every selected message (header pin icon). Pin toggles per
  // message; we simply call the pin endpoint for each and refresh the banner.
  function pinSelected() {
    const targets = [...selectedMessages];
    clearSelection();
    Promise.all(
      targets.map((m) =>
        pinMessage(m.id)
          .then(({ data }) => {
            const pinned = !!(data as { pinned?: boolean })?.pinned;
            setMessages((prev) =>
              prev.map((x) =>
                x.id === m.id
                  ? {
                      ...x,
                      pinned_at: pinned ? new Date().toISOString() : null,
                    }
                  : x,
              ),
            );
          })
          .catch(() => {}),
      ),
    ).finally(() => loadPinned());
  }

  // Save (star) every selected message (header save icon).
  function saveSelected() {
    const targets = [...selectedMessages];
    clearSelection();
    Promise.all(
      targets.map((m) =>
        starMessage(m.id)
          .then(({ data }) => {
            const starred = !!(data as { starred?: boolean })?.starred;
            setStarredIds((prev) => {
              const next = new Set(prev);
              if (starred) next.add(m.id);
              else next.delete(m.id);
              return next;
            });
          })
          .catch(() => {}),
      ),
    ).then(() => {
      setTimeout(() => alert("Saved", "Messages added to saved."), 200);
    });
  }

  // Copy the text of every selected message to the clipboard, joined by
  // newlines (header copy icon).
  function copySelected() {
    const text = selectedMessages
      .map((m) => m.content || "")
      .filter((s) => s.trim().length > 0)
      .join("\n");
    clearSelection();
    if (text) Clipboard.setStringAsync(text).catch(() => {});
  }

  // Forward every selected message (header forward icon). Promotes the
  // selection to `forwardSelection` and opens the forward picker; the actual
  // fan-out happens in doForward (which loops the API per selected id).
  const [forwardSelection, setForwardSelection] = useState<ChatMessage[]>([]);
  function forwardSelected() {
    const targets = [...selectedMessages];
    if (targets.length === 0) return;
    setForwardSelection(targets);
    setActionTarget(targets[0]);
    getConversations()
      .then((r) => setConversations(r.data || []))
      .catch(() => setConversations([]));
    setForwardMode(true);
  }

  // ── Delete (WhatsApp/Telegram/Signal model) ───────────────────────────────
  // A single chooser drives BOTH single-message deletes (long-press menu) and
  // multi-select deletes (header trash). `deleteTargets` holds the messages the
  // open chooser operates on; the chooser offers "Delete for everyone" (own
  // messages only — the server rejects deleting others') and "Delete for me"
  // (a local-only hide, persisted per device).
  const [deleteTargets, setDeleteTargets] = useState<ChatMessage[] | null>(
    null,
  );
  const deleteCanForEveryone = useMemo(
    () =>
      !!deleteTargets &&
      deleteTargets.length > 0 &&
      deleteTargets.every((m) => Number(m.sender_id) === Number(user?.id)),
    [deleteTargets, user?.id],
  );

  // Open the delete chooser. Dismisses the long-press surfaces first, then opens
  // the sheet on a short delay so the dismissing Modal never collides with it
  // (same pattern the old confirm flow used).
  function requestDelete(targets: (ChatMessage | null | undefined)[]) {
    setReactTarget(null);
    setReactAnchor(null);
    setActionTarget(null);
    const list = targets.filter(Boolean) as ChatMessage[];
    if (list.length === 0) return;
    setTimeout(() => setDeleteTargets(list), 250);
  }

  function closeDeleteSheet() {
    setDeleteTargets(null);
  }

  // "Delete for everyone" — calls the server for each OWN target and marks it
  // deleted locally (the peer gets a chat_delete socket event).
  function deleteForEveryone() {
    const targets = (deleteTargets || []).filter(
      (m) => Number(m.sender_id) === Number(user?.id),
    );
    setDeleteTargets(null);
    if (targets.length === 0) return;
    Promise.all(
      targets.map((m) =>
        deleteMessage(m.id)
          .then(() =>
            setMessages((prev) =>
              prev.map((x) =>
                x.id === m.id
                  ? {
                      ...x,
                      deleted_at: new Date().toISOString(),
                      content: "",
                      file_url: null,
                      file_name: null,
                      file_type: null,
                      file_size: null,
                      reactions: [],
                    }
                  : x,
              ),
            ),
          )
          .catch(() => {}),
      ),
    ).catch(() => alert("Error", "Could not delete message(s)."));
  }

  // "Delete for me" — hides the target message(s) on this device only and
  // persists the hidden ids so they stay hidden across reloads.
  function deleteForMe() {
    const targets = deleteTargets || [];
    setDeleteTargets(null);
    if (targets.length === 0) return;
    const ids = targets.map((m) => Number(m.id));
    setLocallyDeleted((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.add(id));
      return next;
    });
    addLocalDeletedIds(convId, ids);
  }

  // Delete every selected message (header delete icon). Opens the chooser for
  // the whole selection — "Delete for everyone" applies to the own messages in
  // it, "Delete for me" hides them all locally (so a mixed mine/theirs
  // selection still has a working delete, which it previously lacked).
  function deleteSelected() {
    const targets = [...selectedMessages];
    clearSelection();
    requestDelete(targets);
  }

  // Enter multi-select mode seeded with one message (the long-press context
  // menu's "Select" action). Closes the context menu first so the header can
  // cleanly swap to the selection action bar.
  function enterSelectionWith(message: ChatMessage) {
    setReactTarget(null);
    setReactAnchor(null);
    setSelectedIds(new Set([message.id]));
  }

  // Anchor the reaction/context menu to the long-pressed bubble (mirrors the
  // web MessageBubble). Measures the bubble's host node directly for
  // reliability.
  //
  // IMPORTANT (UX fix): long-press NO LONGER enters multi-select mode. Doing
  // both at once tangled "react to this message" with "select messages" — the
  // reaction pill AND the header selection action bar appeared together, which
  // felt broken. Now long-press opens ONE cohesive context menu (reaction pill
  // + per-message actions). Multi-select is an explicit "Select" action inside
  // that menu (Signal / WhatsApp / Telegram model).
  function openReactionBar(item: ChatMessage, mine: boolean) {
    // Already selecting? Long-press just toggles this row in the selection
    // (Signal/WhatsApp): the context menu is a single-message surface, so it
    // shouldn't reappear on top of an active multi-select.
    if (selectedIds.size > 0) {
      toggleSelect(item);
      return;
    }
    // Crisp haptic the instant the menu opens (Signal-Android fires a
    // performHapticFeedback(LONG_PRESS) on long-press before the overlay
    // animates in). LONG_PRESS is a single short, firm tick — a ~20ms pulse
    // reads closer to it than the previous 12ms blip.
    try {
      Vibration.vibrate(20);
    } catch {
      /* no-op */
    }
    const node = bubbleRefs.current.get(item.id) as unknown as {
      measureInWindow?: (
        cb: (x: number, y: number, width: number, height: number) => void,
      ) => void;
    } | null;
    // IMPORTANT: call measureInWindow ON the node (not via a detached
    // reference). It is a method bound to the native view instance — invoking
    // it without its receiver loses `this` and crashes the app natively.
    if (node && typeof node.measureInWindow === "function") {
      try {
        node.measureInWindow((x, y, width, height) => {
          setReactAnchor({ x, y, width, height, mine });
          setReactTarget(item);
        });
      } catch {
        setReactAnchor(null);
        setReactTarget(item);
      }
    } else {
      setReactAnchor(null);
      setReactTarget(item);
    }
  }

  // Position the reaction bar right next to the long-pressed bubble (mirrors
  // the web MessageBubble behavior). Falls back to centered if no anchor.
  function computeBarPosition() {
    if (!reactAnchor) {
      return {
        position: "absolute" as const,
        top: winHeight / 2 - barSize.height / 2,
        left: winWidth / 2 - barSize.width / 2,
      };
    }
    const margin = 8;
    const gap = 6;
    const barW = barSize.width || 300;
    const barH = barSize.height || 44;

    // Horizontal: align with the bubble edge, clamped to the screen.
    let left = reactAnchor.mine
      ? reactAnchor.x + reactAnchor.width - barW
      : reactAnchor.x;
    left = Math.max(margin, Math.min(left, winWidth - barW - margin));

    // Vertical: prefer above the bubble; if it doesn't fit, place below.
    let top = reactAnchor.y - barH - gap;
    if (top < insets.top + margin) {
      top = reactAnchor.y + reactAnchor.height + gap;
    }
    top = Math.max(
      insets.top + margin,
      Math.min(top, winHeight - barH - margin),
    );

    return { position: "absolute" as const, top, left };
  }

  // Reaction-bar size measurement (keeps the anchor positioning accurate).
  function onReactionBarLayout(width: number, height: number) {
    if (
      Math.abs(width - barSize.width) > 1 ||
      Math.abs(height - barSize.height) > 1
    ) {
      setBarSize({ width, height });
    }
  }

  // Newest-first copy for the INVERTED FlatList (Signal-Android model). The
  // source `messages` stays oldest-first (server order) for all the existing
  // logic; the list renders this reversed view so index 0 is the newest message
  // pinned to the visual bottom — the keyboard or a new message can never push
  // it under the composer, and no scroll math is needed to "stick to bottom".
  const messagesReversed = useMemo(() => {
    // PERF: resolve the "clear chat" cutoff ONCE per recompute instead of
    // calling isBeforeClearedAt() per message. isBeforeClearedAt() does a
    // synchronous MMKV read + a Date parse of the cutoff EVERY call, so on a
    // long thread (hundreds of messages after paging) the old per-message call
    // fired hundreds of native storage reads on the JS thread on every
    // recompute — the visible freeze when opening a conversation with lots of
    // history. We read the cutoff string once, parse it once, then compare each
    // message's timestamp inline. Reactivity is unchanged: this memo already
    // only recomputes when [messages, locallyDeleted, convId] change (the exact
    // same inputs the per-message call depended on).
    const cutoffIso = getClearedAt(convId);
    const cutoffMs = cutoffIso ? new Date(cutoffIso).getTime() : NaN;
    const hasCutoff = !Number.isNaN(cutoffMs);
    const out: ChatMessage[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      // "Delete for me" — hidden message ids on this device.
      if (locallyDeleted.has(Number(m.id))) continue;
      // "Clear chat for me" — everything up to the local cutoff is hidden on
      // this device while newer messages still show (Signal model).
      if (hasCutoff && m.created_at) {
        const c = new Date(m.created_at).getTime();
        if (!Number.isNaN(c) && c <= cutoffMs) continue;
      }
      out.push(m);
    }
    return out;
  }, [messages, locallyDeleted, convId]);

  // Signal-Android-style precomputed row bind metadata. Signal's
  // ConversationAdapter resolves per-row presentation (grouping, day dividers)
  // ONCE when a page is built, not on every RecyclerView bind. Here the FlatList
  // `renderItem` previously recomputed consecutive-grouping + day-divider for
  // EVERY visible row on EVERY render — each row parsing two `new Date(...)`
  // timestamps. On a busy thread that is hundreds of Date parses per render pass
  // (scroll, typing pulse, receipt update…), all on the JS thread. We compute it
  // ONCE per `messagesReversed` change and let `renderItem` do an O(1) lookup,
  // keyed by the same stable id the list keys by (clientMsgId ?? id). Because
  // the memoized MessageBubble's inputs are unchanged, this also stops rows from
  // re-binding when unrelated state changes.
  const rowMeta = useMemo(() => {
    const GROUP_WINDOW_MS = 300000; // 5 min — same-sender consecutive grouping
    const within = (a?: ChatMessage, b?: ChatMessage) => {
      if (!a || !b) return false;
      if (a.sender_id !== b.sender_id) return false;
      const ta = new Date(a.created_at).getTime();
      const tb = new Date(b.created_at).getTime();
      return Math.abs(tb - ta) <= GROUP_WINDOW_MS;
    };
    const map = new Map<
      string,
      { firstInGroup: boolean; lastInGroup: boolean; showDaySeparator: boolean }
    >();
    for (let index = 0; index < messagesReversed.length; index++) {
      const item = messagesReversed[index];
      // INVERTED list: older (above) is index+1, newer (below) is index-1.
      const prev = messagesReversed[index + 1]; // older, above
      const next = messagesReversed[index - 1]; // newer, below
      const key = item.clientMsgId ?? String(item.id);
      map.set(key, {
        firstInGroup: !within(prev, item),
        lastInGroup: !within(item, next),
        showDaySeparator: !prev || !isSameDay(prev.created_at, item.created_at),
      });
    }
    return map;
  }, [messagesReversed]);

  const latestPin = pinnedMsgs[0];

  // Pre-parse read receipt timestamps ONCE per receipt-map change. Previously
  // every own visible MsgTicks row did `Object.entries(readReceipts)` plus
  // `new Date(readAt)` parsing during render. On text-only threads with many
  // own messages, that became repeated O(visibleRows × participants) JS work on
  // every open/reconcile. Signal computes delivery state from a cached receipt
  // model; this gives each row a tiny numeric array instead of reparsing dates.
  const readReceiptTimes = useMemo(
    () =>
      Object.entries(readReceipts)
        .map(([uid, readAt]) => [Number(uid), new Date(readAt).getTime()] as const)
        .filter(([, ts]) => Number.isFinite(ts)),
    [readReceipts],
  );

  // FlatList extraData. Keep this Signal-style targeted and O(1): message
  // content/reaction/pin/delete changes already arrive through immutable
  // `messages` updates (the FlatList `data` prop). extraData is only for
  // row-affecting state that lives outside the message object. The old
  // implementation built a giant string by scanning every message/reaction on
  // every recompute; opening a long chat could freeze the JS thread.
  const listExtraData = useMemo(
    () => ({
      starredIds,
      selectedIds,
      highlightedId,
      readReceiptTimes,
      participantCount,
      selectionMode,
      userId: user?.id,
    }),
    [
      starredIds,
      selectedIds,
      highlightedId,
      readReceiptTimes,
      participantCount,
      selectionMode,
      user?.id,
    ],
  );

  // Status line under the chat name (mirrors the web ChatHeader meta line):
  // member count for groups, live effective status for 1:1 chats.
  const headerSubtitle = isGroupConv
    ? participantCount
      ? `${participantCount} members`
      : ""
    : peerStatus
      ? STATUS_LABEL[peerStatus] || peerStatus
      : "";

  // Composer bottom inset (keyboard-aware).
  const composerBottomInset = Math.max(insets.bottom, kbInset) + 8;

  return {
    // identity / header
    name,
    headerAvatar,
    groupMemberAvatars,
    convId,
    isGroupConv,
    peerUserId,
    peerStatus,
    peerWorkMode,
    headerSubtitle,
    startCall,
    goBackToChatList,
    openHeaderPanel,
    // Signal-style overflow menu + navigation
    menuOpen,
    setMenuOpen,
    openInfo,
    openSearchScreen,
    openSharedMedia,
    openPinnedScreen,
    openSavedScreen,
    // Signal-style in-conversation search
    searchMode,
    searchQuery,
    searchMatchIds,
    searchActiveIdx,
    highlightedId,
    openSearch,
    closeSearch,
    onSearchQueryChange,
    searchPrev,
    searchNext,
    // list
    loading,
    messages,
    messagesReversed,
    rowMeta,
    listRef,
    listExtraData,
    scrollToEnd,
    onListScroll,
    prependingRef,
    hasMore,
    loadOlder,
    loadingOlder,
    // bubble
    user,
    starredIds,
    participantCount,
    readReceiptTimes,
    registerBubbleRef,
    openReactionBar,
    react,
    cancelMediaUpload,
    retryMediaUpload,
    // multi-select (Signal-style)
    selectedIds,
    selectionMode,
    selectionAllOwn,
    selectedCount: selectedIds.size,
    toggleSelect,
    clearSelection,
    enterSelectionWith,
    pinSelected,
    saveSelected,
    copySelected,
    forwardSelected,
    deleteSelected,
    // delete chooser (delete for everyone / delete for me)
    deleteTargets,
    deleteCanForEveryone,
    deleteForEveryone,
    deleteForMe,
    closeDeleteSheet,
    // typing / reply
    peerTyping,
    replyTo,
    setReplyTo,
    // pinned banner
    latestPin,
    pinnedMsgs,
    jumpToMessage,
    jumpToReply,
    unpinFromBanner,
    // composer
    text,
    editingId,
    uploading,
    recordingMillis,
    composerBottomInset,
    onChangeText,
    send,
    saveEdit,
    cancelEdit,
    setPlusOpen,
    startRecording,
    cancelRecording,
    stopRecordingAndSend,
    isRecordingActive,
    // voice recorder controller wiring (mounted only while recording)
    voiceHandleRef,
    onRecorderDuration,
    onRecorderError,
    onRecorderStartFailed,
    // inline emoji keyboard (Signal-style)
    inputRef,
    emojiKeyboardOpen,
    emojiKeyboardHeight: lastKbHeight.current,
    kbInset,
    toggleEmojiKeyboard,
    insertEmoji,
    emojiBackspace,
    onComposerInputFocus,
    onEmojiSearchFocus,
    onEmojiSearchBlur,
    // attachment picker
    plusOpen,
    attachCamera,
    attachFile,
    // in-app camera (Signal-style)
    cameraOpen,
    setCameraOpen,
    handleCameraPhoto,
    handleCameraVideo,
    handlePickRecentMedia,
    // video preview (review before send)
    videoPreview,
    setVideoPreview,
    sendVideoPreview,
    // media editor (Signal-style)
    editorItems,
    setEditorItems,
    handleMediaEditorSend,
    attachGifFromEmoji,
    attachStickerFromEmoji,
    tenorOpen,
    tenorKind,
    setTenorOpen,
    pickTenorMedia,
    attachDocument,
    setEmojiMode,
    setShowAllEmoji,
    // reaction bar / overlay
    reactTarget,
    reactAnchor,
    computeBarPosition,
    onReactionBarLayout,
    startReply,
    retryFailedMessage,
    copyMessage,
    openForwardFor,
    setReactTarget,
    setActionTarget,
    setReactAnchor,
    // emoji picker
    showAllEmoji,
    emojiMode,
    pickEmoji,
    closeEmojiPicker,
    // action sheet
    actionTarget,
    forwardMode,
    conversations,
    closeActionSheet,
    openForward,
    doForward,
    doStar,
    doPin,
    startEdit,
    doDelete,
    // header sheet
    headerSheet,
    sheetLoading,
    sheetSearchQ,
    sheetSearchResults,
    sharedFiles,
    savedMsgs,
    setHeaderSheet,
    onSheetSearchChange,
    jumpFromSheet,
    unstarFromSheet,
    doClearChat,
    // block user (Signal parity)
    isBlocked,
    doToggleBlock,
    // dialog
    dialog,
  };
}
