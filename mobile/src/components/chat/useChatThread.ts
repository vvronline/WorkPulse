import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
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
  RecordingPresets,
  setAudioModeAsync,
  useAudioPlayer,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import { getNotificationPreviewDataUri } from "../../utils/notificationSoundPreview";
import { useAuth } from "../../auth/AuthContext";
import { useDialog } from "../../hooks/useDialog";
import {
  ackDelivered,
  clearChat,
  cancelChatMediaJob,
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
import { setActiveConversation } from "../../realtime/activeConversation";
import { emitChatUnreadChanged, chatUnreadManager } from "../../realtime/chatUnreadEvents";
import { subscribeChatJump } from "../../realtime/chatJumpEvents";
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
import { STATUS_LABEL, type HeaderSheet } from "./chatUtils";

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
  replyTo?: { id: number; content?: string | null; sender_name?: string | null } | null;
  editing?: { id: number; text?: string | null } | null;
  mediaDrafts: PendingMediaSource[];
};

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
  const isCamel = "fileUrl" in data || "mediaState" in data || "senderId" in data;
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
    reply_to_sender_name: data.replySenderName ?? data.reply_to_sender_name ?? null,
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
    media_pipeline_meta: data.mediaPipelineMeta ?? data.media_pipeline_meta ?? null,
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
  }>();
  const { id } = params;
  const convId = Number(id);
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
  // Group conversations get NO 1:1 call buttons — the native call screen is
  // strictly peer-to-peer (single remote stream), so initiating a "group call"
  // from here would produce a broken half-connected call. Mirrors the web,
  // where group calls go through the meeting flow instead.
  const [isGroupConv, setIsGroupConv] = useState(params.isGroup === "1");
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
  const [messages, setMessages] = useState<ChatMessage[]>(
    () => cachedMessages || [],
  );
  const [loading, setLoading] = useState(
    () => !cachedMessages || cachedMessages.length === 0,
  );
  // Cursor pagination for older history (mirrors web loadMore).
  const [hasMore, setHasMore] = useState(false);
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
  // Delivery / read receipts (userId → ISO last_read_at) + participant count.
  // Seed from the on-device cache SYNCHRONOUSLY (same pattern as `messages`)
  // so the read-receipt tick colour is correct on the FIRST frame. Without
  // this, the cached messages painted instantly but `readReceipts` started
  // empty and was only filled by the async `getReadStatus()` round-trip in
  // `load()` — so the ticks flipped from delivered (muted) → read (accent) a
  // fraction of a second after the chat opened. The network refresh below now
  // just confirms what's already shown instead of causing a visible flip.
  const cachedReceipts = useMemo(
    () => getCachedReadStatus(convId),
    [convId],
  );
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
  // Voice recording (expo-audio). Poll the recorder state every 100ms (vs the
  // 500ms default) so the in-composer recording bar appears immediately on
  // record() and the live duration counter ticks smoothly.
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(recorder, 100);
  // Dedicated player for the short "reaction added" feedback tone (Signal-style
  // haptic + subtle sound when you react). Separate from the recorder so it
  // never fights the record audio session.
  const reactionSoundPlayer = useAudioPlayer();
  // Explicit recording flag set SYNCHRONOUSLY the instant record() succeeds.
  // The polled `recorderState.isRecording` lags on Android (the 100ms poll can
  // miss the transition), so the recording bar "didn't appear" when the mic was
  // tapped. Driving the UI from this state (OR'd with the poll) makes the bar
  // show immediately. A ref mirror guards against double-start re-entrancy
  // without depending on the stale polled value.
  const [isRecordingActive, setIsRecordingActive] = useState(false);
  const recordingRef = useRef(false);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  // Bubble host-node refs so we can reliably measure each bubble's window rect
  // for the reaction-bar anchor (Pressable forwards its ref to the host View,
  // which exposes measureInWindow — currentTarget often does not).
  const bubbleRefs = useRef<Map<number, View>>(new Map());
  const mediaUploadControllers = useRef<Map<number, AbortController>>(new Map());
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
  // Last-measured system keyboard height — the in-app emoji keyboard is shown
  // at this height so toggling between them doesn't shift the message list.
  const lastKbHeight = useRef(280);
  if (kbInset > 100) lastKbHeight.current = kbInset;

  // Hydrate emoji recents + skin-tone preference once.
  useEffect(() => {
    hydrateEmojiStore();
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
      if (emojiKeyboardOpen) setEmojiKeyboardOpen(false);
    } else {
      ignoreKbForEmoji.current = false; // keyboard fully hidden → re-arm
    }
  }, [kbInset, emojiKeyboardOpen]);

  // Scroll to the newest message. The message list is an INVERTED FlatList
  // (Signal-Android model: newest row pinned to the visual bottom), so the
  // "bottom" is offset 0. With an inverted list the newest message is already
  // structurally at the bottom — the keyboard opening/closing or sending a new
  // message can NEVER push it under the composer — so this is just a nicety for
  // explicit "jump to latest" cases (send, incoming, typing-indicator appears).
  const scrollToEnd = useCallback((animated = false) => {
    listRef.current?.scrollToOffset({ offset: 0, animated });
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
      setActiveConversation(convId);
      return () => setActiveConversation(null);
    }, [convId]),
  );

  const load = useCallback(async () => {
    try {
      const { data } = await getMessages(convId);
      // Map the REST reply aliases (reply_content / reply_sender_name /
      // reply_file_*) to the canonical reply_to_* shape so the in-bubble quote
      // doesn't collapse to the generic "Message" when this refresh replaces
      // the optimistic / WS rows (see normalizeFetchedMessage).
      const normalized = (data || []).map(normalizeFetchedMessage);
      setMessages(normalized);
      // Persist the freshest page so the next open paints instantly from disk.
      setCachedMessages(convId, normalized);
      setHasMore(normalized.length >= 50);
      markReadAndSync();
      // Seed read receipts so own messages show the correct tick immediately.
      // Also persist them to the on-device cache so the NEXT open paints the
      // read colour on the first frame (no delivered→read flip).
      getReadStatus(convId)
        .then((r) => {
          const map: Record<number, string> = {};
          for (const row of r.data || []) {
            if (row.user_id != null && row.last_read_at) {
              map[row.user_id] = row.last_read_at;
            }
          }
          setReadReceipts(map);
          setCachedReadStatus(convId, map);
        })
        .catch(() => {});
      // Jump to the newest message once the list has content.
      setTimeout(() => scrollToEnd(false), 80);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [convId, markReadAndSync, scrollToEnd]);

  useEffect(() => {
    load();
    loadPinned();
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
      const resolvedName = conv.is_group
        ? conv.group_name || "Group"
        : conv.other_full_name || conv.other_username || "Chat";
      const resolvedAvatar = conv.is_group ? null : conv.other_avatar || null;
      if (!params.name && resolvedName) setName(resolvedName);
      if (!params.avatar && resolvedAvatar) setHeaderAvatar(resolvedAvatar);
      if (!conv.is_group && conv.other_user_id) {
        const uid = conv.other_user_id;
        setPeerUserId(uid);
        getChatPresence([uid])
          .then((r) => {
            if (active) setPeerStatus(r.data?.[uid]?.userStatus ?? null);
          })
          .catch(() => {});
      }
    };

    if (peerFromParam) {
      setPeerUserId(peerFromParam);
      getChatPresence([peerFromParam])
        .then((r) => {
          if (active) setPeerStatus(r.data?.[peerFromParam]?.userStatus ?? null);
        })
        .catch(() => {});
      // The header name/avatar were supplied alongside the peer id — nothing to
      // resolve. (This is the conversation-list open path.)
      if (haveIdentity) {
        return () => {
          active = false;
        };
      }
    }

    // Resolve identity from the cached conversation list FIRST (synchronous, no
    // network) so deep-links / notification taps light up the header instantly
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

    return () => {
      active = false;
    };
  }, [convId, params.peerId, params.name, params.avatar]);

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
        const clientMsgId = typeof d.clientMsgId === "string" ? d.clientMsgId : null;
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
                  : m.media_progress ?? null,
              media_failure_reason: d.failureReason ?? null,
              _mediaState:
                d.status === "processing"
                  ? "uploading"
                  : d.status ?? m._mediaState,
              _mediaProgress:
                typeof d.progress === "number"
                  ? d.progress
                  : m._mediaProgress ?? 0,
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
      setPeerTyping(false);
      setMessages((prev) => {
        // Replace optimistic message if clientMsgId matches, else append.
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
              reply_to_file_name: d.replyFileName ?? null,
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
        return [
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
            reply_to_file_name: d.replyFileName ?? null,
            _mediaState: d.mediaState ?? null,
            _mediaProgress:
              typeof d.mediaProgress === "number" ? d.mediaProgress : 0,
            _failureReason: d.failureReason ?? null,
            media_job_id: d.mediaJobId ?? null,
          },
        ];
      });
      markReadAndSync();
      // Acknowledge delivery so the sender sees "✓✓ delivered" (mirrors the
      // web ackDelivered call in the chat_message WS handler).
      if (d.senderId !== user?.id && d.id) {
        ackDelivered(d.id).catch(() => {});
      }
      scrollToEnd(true);
    });
    return off;
  }, [convId, user?.id, loadPinned, markReadAndSync, scrollToEnd, router]);

  const send = useCallback(() => {
    const content = text.trim();
    if (!content || !user) return;
    const clientMsgId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const replyToId = replyTo?.id;
    // Optimistic append.
    setMessages((prev) => [
      ...prev,
      {
        id: -Date.now(),
        sender_id: user.id,
        sender_name: user.full_name,
        content,
        created_at: new Date().toISOString(),
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
    socket.send("chat_message", {
      conversationId: convId,
      content,
      clientMsgId,
      ...(replyToId ? { replyToId } : {}),
    });
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
                      metadata: { ...(m.metadata || {}), ...(normalized.metadata || {}) },
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
                        : e?.response?.data?.error || "Could not send this media.",
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

      socket.send("chat_message", {
        conversationId: convId,
        content,
        clientMsgId,
        ...(replyToId ? { replyToId } : {}),
      });
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
    // Guard against a double-tap while a recording is already underway. Use the
    // synchronous ref (NOT the polled recorderState) so the guard reflects the
    // true state the instant record() succeeds — the poll lags up to ~100ms and
    // let a quick second tap through, which threw "already recording".
    if (recordingRef.current) return;
    try {
      const perm = await AudioModule.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        alert(
          "Microphone needed",
          "Allow microphone access to record a voice message.",
        );
        return;
      }
      // Switch the audio session into record mode BEFORE preparing/recording.
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });
      // prepareToRecordAsync MUST resolve before record() — calling record()
      // on an unprepared recorder silently no-ops on Android, which is why the
      // Mic button "did nothing" (no recording bar, nothing sent).
      try {
        await recorder.prepareToRecordAsync();
      } catch {
        // Some Android devices/reporting paths expose a prepared recorder
        // already; keep going and attempt to start recording.
      }
      await recorder.record();
      // Flip the recording UI ON synchronously — don't wait for the polled
      // `recorderState.isRecording` (which can miss the transition on Android,
      // leaving the mic tap with no visible recording bar). The composer's
      // recording bar is driven by this flag OR'd with the poll.
      recordingRef.current = true;
      setIsRecordingActive(true);
    } catch (e: any) {
      recordingRef.current = false;
      setIsRecordingActive(false);
      // Restore the playback session so a failed start doesn't leave the audio
      // route stuck in record mode.
      setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
      }).catch(() => {});
      alert(
        "Recording failed",
        e?.message || "Could not start the voice recording.",
      );
    }
  }

  async function stopRecordingAndSend() {
    // Clear the recording UI immediately so the bar collapses on tap.
    recordingRef.current = false;
    setIsRecordingActive(false);
    try {
      await recorder.stop();
    } catch {
      /* the recorder may already be stopped; fall through to upload the uri */
    }
    // Restore the playback audio session — leaving allowsRecording=true
    // routes/silences subsequent voice-note playback on iOS.
    setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(
      () => {},
    );
    const uri = recorder.uri;
    if (!uri) return;
    enqueueMediaUpload({
      uri,
      fileName: `voice-${Date.now()}.m4a`,
      mimeType: "audio/mp4",
    });
  }

  async function cancelRecording() {
    // Clear the recording UI immediately so the bar collapses on tap.
    recordingRef.current = false;
    setIsRecordingActive(false);
    try {
      await recorder.stop();
    } catch {
      /* ignore */
    }
    // Same audio-session restore as stopRecordingAndSend.
    setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(
      () => {},
    );
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
              uploadProgressTs.current.set(tempId, { t: now, loaded: evt.loaded });
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
                  metadata: { ...(m.metadata || {}), ...(normalized.metadata || {}) },
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
      const target = messages.find((m) => m.id === pendingDraftReply.current!.id);
      if (target) {
        setReplyTo(target);
        pendingDraftReply.current = null;
      }
    }
    if (pendingDraftEditing.current?.id) {
      const target = messages.find((m) => m.id === pendingDraftEditing.current!.id);
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
    if (!payload.text.trim() && !payload.replyTo && !payload.editing && payload.mediaDrafts.length === 0) {
      SecureStore.deleteItemAsync(draftStorageKey).catch(() => {});
      return;
    }
      SecureStore.setItemAsync(draftStorageKey, JSON.stringify(payload)).catch(() => {});
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
      setEditorItems([{ uri: item.uri, width: item.width, height: item.height }]);
    },
    [],
  );

  // A recorded VIDEO from the in-app camera → close the camera and upload it
  // directly (the media editor only handles still images).
  const handleCameraVideo = useCallback(
    (item: { uri: string; fileName: string; mimeType: string }) => {
      setCameraOpen(false);
      enqueueMediaUpload({
        uri: item.uri,
        fileName: item.fileName,
        mimeType: item.mimeType,
      });
    },
    [enqueueMediaUpload],
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
        enqueueMediaUpload({
          uri: item.uri,
          fileName: item.fileName || `video-${Date.now()}.mp4`,
          mimeType: item.mimeType || "video/mp4",
        });
      } else {
        setEditorItems([{ uri: item.uri, width: item.width, height: item.height }]);
      }
    },
    [enqueueMediaUpload],
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

  async function pickTenorMedia(item: { mediaUrl: string }, kind: "gif" | "sticker") {
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
                    _failureReason:
                      e?.response?.data?.error || "Retry failed",
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
    // Dismiss BOTH long-press surfaces (reaction overlay + action sheet) first,
    // then confirm. Deleting used to fire immediately with no confirmation —
    // mirror the web/desktop "delete for everyone" confirm flow. Defer the
    // confirm slightly so the themed dialog never collides with the dismissing
    // overlay/sheet modal (same pattern as doClearChat).
    setReactTarget(null);
    setReactAnchor(null);
    setActionTarget(null);
    setTimeout(() => {
      confirm({
        title: "Delete message",
        message: "Delete this message for everyone? This cannot be undone.",
        confirmText: "Delete",
        isDanger: true,
        onConfirm: () => {
          deleteMessage(message.id)
            .then(() =>
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === message.id
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
              ),
            )
            .catch(() => alert("Error", "Could not delete message."));
        },
      });
    }, 250);
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
          prev.map((m) =>
            m.id === messageId ? { ...m, pinned_at: null } : m,
          ),
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
    peerStatus: peerStatus || "",
    memberCount: String(participantCount),
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

  function openSharedMedia(tab: "media" | "files" | "links" = "media") {
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

  function doClearChat() {
    setHeaderSheet(null);
    // Defer so the confirm dialog never collides with the dismissing modal.
    setTimeout(() => {
      confirm({
        title: "Clear chat",
        message:
          "Delete all messages in this conversation for everyone? This cannot be undone.",
        confirmText: "Clear",
        isDanger: true,
        onConfirm: () => {
          clearChat(convId)
            .then(() => {
              setMessages([]);
              setPinnedMsgs([]);
              setHasMore(false);
              clearCachedMessages(convId);
            })
            .catch((e: any) =>
              alert(
                "Error",
                e?.response?.data?.error || "Could not clear chat.",
              ),
            );
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
    Promise.all(
      targets.map((m) => forwardMessage(m.id, [targetConvId])),
    )
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
      reactionSoundPlayer.replace({ uri });
      reactionSoundPlayer.play();
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
      //     `showSoftInputOnFocus` false → true, but unmounting the heavy
      //     EmojiKeyboard SectionList can delay React committing that prop to
      //     the native view. If focus() fires before the commit lands, Android
      //     still sees `showSoftInputOnFocus=false` and SUPPRESSES the keyboard
      //     (the panel collapses with nothing replacing it). A 50ms / rAF timer
      //     lost this race on real devices; 150ms reliably outlasts the unmount
      //     + commit (the same delay startEdit uses to focus after a modal
      //     tears down).
      //
      // Mirrors Signal-Android's InputAwareLayout, which requests the soft
      // input on its edit text only after the emoji page has been torn down,
      // treating keyboard↔emoji as an explicit transition.
      setEmojiKeyboardOpen(false);
      inputRef.current?.blur();
      setTimeout(() => inputRef.current?.focus(), 150);
    } else {
      // System → emoji: dismiss the OS keyboard, then dock the emoji keyboard.
      // Arm the guard FIRST so the safety effect ignores the system keyboard's
      // still-animating (stale) height — otherwise the emoji panel we open on
      // the next line would be instantly closed again (the dismiss is async).
      ignoreKbForEmoji.current = true;
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

  function startCall(type: "voice" | "video") {
    router.push({
      pathname: "/call/[conversationId]",
      params: {
        conversationId: String(convId),
        mode: "outgoing",
        callType: type,
        peerName: name || "Call",
        peerAvatar: headerAvatar || "",
      },
    });
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
                  ? { ...x, pinned_at: pinned ? new Date().toISOString() : null }
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

  // Delete every selected (own) message for everyone (header delete icon).
  function deleteSelected() {
    const targets = selectedMessages.filter(
      (m) => Number(m.sender_id) === Number(user?.id),
    );
    clearSelection();
    if (targets.length === 0) return;
    setTimeout(() => {
      confirm({
        title: targets.length > 1 ? "Delete messages" : "Delete message",
        message:
          targets.length > 1
            ? `Delete ${targets.length} messages for everyone? This cannot be undone.`
            : "Delete this message for everyone? This cannot be undone.",
        confirmText: "Delete",
        isDanger: true,
        onConfirm: () => {
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
          );
        },
      });
    }, 250);
  }

  // Anchor the reaction bar to the long-pressed bubble (mirrors the web
  // MessageBubble). Measures the bubble's host node directly for reliability.
  // Long-press ALSO enters selection mode with this single message selected so
  // the header swaps to the selection action bar (Signal-style).
  function openReactionBar(item: ChatMessage, mine: boolean) {
    // Crisp haptic the instant the reaction bar opens (Signal-Android fires a
    // performHapticFeedback(LONG_PRESS) on long-press before the overlay
    // animates in). LONG_PRESS is a single short, firm tick — a ~20ms pulse
    // reads closer to it than the previous 12ms blip.
    try {
      Vibration.vibrate(20);
    } catch {
      /* no-op */
    }
    // Enter selection mode with just this message selected.
    setSelectedIds(new Set([item.id]));
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
  const messagesReversed = useMemo(() => [...messages].reverse(), [messages]);

  const latestPin = pinnedMsgs[0];

  // FlatList re-render key. With `maintainVisibleContentPosition` enabled,
  // RN's VirtualizedList skips re-rendering already-mounted rows unless
  // `extraData` changes. Optimistic reaction add/remove mutates a message's
  // `reactions` in place (same array length/order), so without this the chip
  // only appeared after an unrelated re-render or the WS echo — making
  // react/unreact feel laggy. Deriving a signature from reactions + starred
  // ids forces the toggled row to re-render instantly (matches the web).
  const listSignature = useMemo(() => {
    let sig = "";
    for (const m of messages) {
      sig += `${m.id}:${(m.reactions || [])
        .map((r) => `${r.userId}${r.emoji}`)
        .join(",")}:${m.pinned_at ? 1 : 0}:${m.deleted_at ? 1 : 0};`;
    }
    sig += `|starred:${Array.from(starredIds).join(",")}`;
    return sig;
  }, [messages, starredIds]);

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
    convId,
    isGroupConv,
    peerUserId,
    peerStatus,
    headerSubtitle,
    startCall,
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
    listRef,
    listSignature,
    scrollToEnd,
    prependingRef,
    hasMore,
    loadOlder,
    loadingOlder,
    // bubble
    user,
    starredIds,
    participantCount,
    readReceipts,
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
    pinSelected,
    saveSelected,
    copySelected,
    forwardSelected,
    deleteSelected,
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
    recorderState,
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
    // inline emoji keyboard (Signal-style)
    inputRef,
    emojiKeyboardOpen,
    emojiKeyboardHeight: lastKbHeight.current,
    toggleEmojiKeyboard,
    insertEmoji,
    emojiBackspace,
    onComposerInputFocus,
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
    // dialog
    dialog,
  };
}