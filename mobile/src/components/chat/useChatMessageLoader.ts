import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { InteractionManager } from "react-native";
import { useAuth } from "../../auth/AuthContext";
import {
  getMessages,
  getReadStatus,
  markConversationRead,
  type ChatMessage,
} from "../../features";
import { notifeeService } from "../../services/notifeeService";
import {
  emitChatUnreadChanged,
  chatUnreadManager,
} from "../../realtime/chatUnreadEvents";
import {
  setCachedMessages,
  getCachedReadStatus,
  setCachedReadStatus,
} from "../../storage/chatCache";
import { getLocalDeletedIds, getClearedAt } from "../../storage/chatLocalDeletes";
import {
  INITIAL_THREAD_PAGE_SIZE,
  THREAD_RECONCILE_TTL_MS,
  appendsNewerServerTail,
  getThreadReconcileAt,
  mergeNewestPageIntoLoadedThread,
  mergeOutboxIntoMessages,
  messageArraysEquivalentForThread,
  normalizeFetchedMessage,
  readMapsEqual,
  rememberThreadReconcile,
} from "./chatThreadMessageUtils";
import type { PendingTailScroll } from "./useChatThreadScroll";

type ThreadUser = ReturnType<typeof useAuth>["user"];

type UseChatMessageLoaderOptions = {
  convId: number;
  user: ThreadUser;
  messages: ChatMessage[];
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  messagesRef: MutableRefObject<ChatMessage[]>;
  mountedRef: MutableRefObject<boolean>;
  initialCachedMessages: ChatMessage[] | null | undefined;
  notificationMessageId: number | null;
  loadPinned: () => void;
  pendingTailScrollRef: MutableRefObject<PendingTailScroll | null>;
  initialReconcileTailAllowedRef: MutableRefObject<boolean>;
};

/**
 * Thread history: the cache-first newest-page reconcile, cursor pagination for
 * older history, read receipts, the local "delete for me" / "clear chat"
 * filtering and the generation guards that invalidate in-flight responses after
 * a destructive dataset change.
 */
export default function useChatMessageLoader({
  convId,
  user,
  messages,
  setMessages,
  messagesRef,
  mountedRef,
  initialCachedMessages,
  notificationMessageId,
  loadPinned,
  pendingTailScrollRef,
  initialReconcileTailAllowedRef,
}: UseChatMessageLoaderOptions) {
  const [loading, setLoading] = useState(
    () => !initialCachedMessages || initialCachedMessages.length === 0,
  );
  // "Delete for me" hidden ids (local-only, persisted per conversation). The
  // source `messages` array stays intact for server reconciliation; the
  // rendered list filters these out (see `visibleMessages`).
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
  const [loadOlderError, setLoadOlderError] = useState<string | null>(null);
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
  // Invalidates async page/reconcile responses after a destructive dataset
  // change (for example chat_cleared), preventing stale history resurrection.
  const messageGenerationRef = useRef(0);
  const latestLoadRequestRef = useRef(0);
  // Timestamp (ms) of the last completed network reconcile. Used to skip a
  // redundant `load()` when the same thread is re-focused within a short window
  // (quickly bouncing in/out of a chat shouldn't repay the full reconcile).
  const lastLoadedAtRef = useRef(getThreadReconcileAt(convId));
  // Synchronous pagination lock. React state is not updated until the next
  // render, so repeated start-reached events could otherwise observe
  // loadingOlder=false and issue the same cursor request in one frame.
  const olderRequestCursorRef = useRef<number | null>(null);

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

  const load = useCallback(async (opts?: { force?: boolean }) => {
    const force = opts?.force === true;
    const now = Date.now();
    if (
      !force &&
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

    const requestId = ++latestLoadRequestRef.current;
    const generation = messageGenerationRef.current;
    try {
      const { data } = await getMessages(convId);
      if (
        !mountedRef.current ||
        requestId !== latestLoadRequestRef.current ||
        generation !== messageGenerationRef.current
      )
        return;
      // Map the REST reply aliases (reply_content / reply_sender_name /
      // reply_file_*) to the canonical reply_to_* shape so the in-bubble quote
      // doesn't collapse to the generic "Message" when this refresh replaces
      // the optimistic / WS rows (see normalizeFetchedMessage).
      const normalized = (Array.isArray(data) ? data : []).map(
        normalizeFetchedMessage,
      );
      // Re-append any still-pending outbox messages — the server obviously
      // doesn't have them yet, and wholesale-replacing the list without them
      // would make an unsent (offline) message vanish mid-session.
      const refreshed = mergeOutboxIntoMessages(
        normalized,
        convId,
        user?.id,
        user?.full_name,
      );
      if (
        initialReconcileTailAllowedRef.current &&
        appendsNewerServerTail(messagesRef.current, refreshed)
      ) {
        pendingTailScrollRef.current = {
          animated: false,
          requireUntouchedOpen: true,
        };
      }
      setMessages((prev) => {
        // Keep already-loaded history and reconcile the newest server page into
        // the same continuous oldest-first collection. FlashList virtualizes the
        // native cells; removing rows from the opposite edge here would make the
        // latest messages unreachable by manual scrolling.
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
          if (
            !mountedRef.current ||
            requestId !== latestLoadRequestRef.current ||
            generation !== messageGenerationRef.current
          )
            return;
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
      rememberThreadReconcile(convId, loadedAt);
    } catch {
      /* keep the cached thread visible */
    } finally {
      if (mountedRef.current && requestId === latestLoadRequestRef.current)
        setLoading(false);
    }
  }, [
    convId,
    initialCachedMessages,
    initialReconcileTailAllowedRef,
    markReadAndSync,
    mountedRef,
    messagesRef,
    pendingTailScrollRef,
    setMessages,
    user?.id,
    user?.full_name,
  ]);

  // A notification tap carries the exact message id that must be visible. The
  // normal open path intentionally delays `load()` until after navigation
  // interactions and may skip it for THREAD_RECONCILE_TTL_MS on a warm cache.
  // That is good for ordinary chat-list opens, but bad for notification opens:
  // the status-bar push can arrive while the websocket/cache path is suspended,
  // so the cached thread may not yet contain the tapped message. If the route
  // includes a messageId and the synchronous cache seed does not contain it,
  // force an immediate reconcile that bypasses both the animation delay and TTL.
  useEffect(() => {
    if (!notificationMessageId) return;
    if (messages.some((m) => Number(m.id) === notificationMessageId)) return;
    void load({ force: true });
  }, [load, messages, notificationMessageId]);

  // Defer the network refresh + its (large) setMessages re-render until AFTER
  // the screen's open transition has settled. The cached page is already on
  // screen (see cachedMessages), so this is a pure background reconcile — running
  // it synchronously on mount used to fire a heavy re-render DURING the
  // slide-in animation, which dropped frames and made the open feel laggy.
  // InteractionManager runs it on the first idle frame after the transition,
  // keeping the animation smooth (Signal-Android feel).
  //
  // CRITICAL: that reasoning only holds for a WARM thread, where the cached
  // page is already painted and the reconcile is genuinely cosmetic. On a COLD
  // thread (first-ever open, or a cache cleared/expired) the screen is EMPTY —
  // deferring behind InteractionManager plus a 250ms timer is pure dead time
  // stacked on top of the network round-trip, and it is exactly what made a
  // first open feel slow. When there is nothing to show, fetch immediately.
  const hasWarmCache = (initialCachedMessages?.length || 0) > 0;
  useEffect(() => {
    if (!hasWarmCache) {
      // Cold open: nothing on screen, so there is no animation to protect.
      load();
      loadPinned();
      return;
    }
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
  }, [hasWarmCache, load, loadPinned]);

  // Load an older page of messages using the oldest real message id as a
  // cursor (mirrors the web loadMore). Triggered by the "load earlier"
  // header button / top-reach.
  const loadOlder = useCallback(async () => {
    if (loadingOlder || !hasMore || olderRequestCursorRef.current != null) return;
    // Oldest REAL (server-assigned) id — skip optimistic negative ids.
    const oldest = messagesRef.current.find((m) => m.id > 0);
    if (!oldest) return;
    // Acquire before setState so two edge callbacks in the same JS turn cannot
    // race. The cursor also makes the guard explicit in profiler traces.
    olderRequestCursorRef.current = oldest.id;
    const generation = messageGenerationRef.current;
    setLoadingOlder(true);
    setLoadOlderError(null);
    try {
      const { data } = await getMessages(convId, oldest.id);
      if (!mountedRef.current || generation !== messageGenerationRef.current)
        return;
      // Same reply-alias normalization as load() so prepended history keeps its
      // quoted-message text instead of collapsing to "Message".
      const older = (Array.isArray(data) ? data : []).map(
        normalizeFetchedMessage,
      );
      setHasMore(older.length >= 50);
      if (older.length > 0) {
        setMessages((prev) => {
          const serverIds = new Set(
            prev.filter((m) => m.id > 0).map((m) => m.id),
          );
          const clientIds = new Set(
            prev.map((m) => m.clientMsgId).filter(Boolean) as string[],
          );
          return [
            ...older.filter(
              (m) =>
                !serverIds.has(m.id) &&
                (!m.clientMsgId || !clientIds.has(m.clientMsgId)),
            ),
            ...prev,
          ];
        });
      }
    } catch {
      if (mountedRef.current && generation === messageGenerationRef.current) {
        // Keep hasMore intact: a network failure is not proof that history ended.
        setLoadOlderError("Could not load earlier messages. Tap to retry.");
      }
    } finally {
      if (olderRequestCursorRef.current === oldest.id) {
        olderRequestCursorRef.current = null;
      }
      if (mountedRef.current && generation === messageGenerationRef.current) {
        setLoadingOlder(false);
      }
    }
  }, [convId, hasMore, loadingOlder, messagesRef, mountedRef, setMessages]);

  // Oldest-first visible page for FlashList. Keeping server order avoids the
  // transform-heavy inverted-list path and lets FlashList recycle native cells.
  const visibleMessages = useMemo(() => {
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
    for (let i = 0; i < messages.length; i++) {
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

  return {
    loading,
    hasMore,
    setHasMore,
    loadingOlder,
    setLoadingOlder,
    loadOlderError,
    setLoadOlderError,
    locallyDeleted,
    setLocallyDeleted,
    readReceipts,
    setReadReceipts,
    visibleMessages,
    load,
    loadOlder,
    markReadAndSync,
    messageGenerationRef,
    latestLoadRequestRef,
    olderRequestCursorRef,
  };
}
