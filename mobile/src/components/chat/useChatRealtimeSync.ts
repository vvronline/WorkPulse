import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useFocusEffect, useRouter } from "expo-router";
import { useAuth } from "../../auth/AuthContext";
import {
  ackDelivered,
  type ChatMessage,
  type PinnedMessage,
} from "../../features";
import { socket } from "../../realtime/socket";
import { setActiveConversation } from "../../realtime/activeConversation";
import {
  subscribeChatJump,
  consumePendingChatJump,
} from "../../realtime/chatJumpEvents";
import { clearCachedMessages, setCachedReadStatus } from "../../storage/chatCache";
import {
  applyMediaJobUpdate,
  applyMessageDelete,
  applyMessageEdit,
  applyMessagePin,
  applyMessageReaction,
  mapRealtimeChatMessage,
  updateMessageById,
} from "./chatMessageReducers";
import type { PendingTailScroll } from "./useChatThreadScroll";

type ThreadUser = ReturnType<typeof useAuth>["user"];

type UseChatRealtimeSyncOptions = {
  convId: number;
  user: ThreadUser;
  router: ReturnType<typeof useRouter>;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setPinnedMsgs: Dispatch<SetStateAction<PinnedMessage[]>>;
  setReadReceipts: Dispatch<SetStateAction<Record<number, string>>>;
  setHasMore: Dispatch<SetStateAction<boolean>>;
  setLoadingOlder: Dispatch<SetStateAction<boolean>>;
  setLoadOlderError: Dispatch<SetStateAction<string | null>>;
  loadPinned: () => void;
  markReadAndSync: () => void;
  requestTailScroll: (animated?: boolean) => void;
  scrollToEnd: (animated?: boolean) => void;
  jumpToMessage: (messageId: number) => void;
  atBottomRef: MutableRefObject<boolean>;
  pendingTailScrollRef: MutableRefObject<PendingTailScroll | null>;
  messageGenerationRef: MutableRefObject<number>;
  latestLoadRequestRef: MutableRefObject<number>;
  olderRequestCursorRef: MutableRefObject<number | null>;
};

/**
 * Live thread wiring: the single-active-conversation focus gate, cross-screen
 * jump events and every `chat_*` socket event that mutates the loaded thread
 * (typing, receipts, media jobs, pins, reactions, edits, deletes, clears and
 * incoming messages).
 *
 * Backgrounded thread screens stay mounted in the Expo Router stack, so the
 * focus ref keeps them inert for the high-frequency cosmetic events.
 */
export default function useChatRealtimeSync({
  convId,
  user,
  router,
  setMessages,
  setPinnedMsgs,
  setReadReceipts,
  setHasMore,
  setLoadingOlder,
  setLoadOlderError,
  loadPinned,
  markReadAndSync,
  requestTailScroll,
  scrollToEnd,
  jumpToMessage,
  atBottomRef,
  pendingTailScrollRef,
  messageGenerationRef,
  latestLoadRequestRef,
  olderRequestCursorRef,
}: UseChatRealtimeSyncOptions) {
  const [peerTyping, setPeerTyping] = useState(false);
  const typingClear = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Whether THIS thread screen is the one currently focused. Expo Router keeps
  // previously-visited `chat/[id]` screens mounted in the stack, so without this
  // gate every backgrounded thread's socket handler would still run the full
  // heavy per-event work (setMessages reconciles, receipt maps, pin refreshes)
  // for EVERY live event — cost that scales with how many chats you opened this
  // session and is the root cause of the "fast at first, then lags/freezes"
  // degradation. Signal keeps a single active conversation data source; we
  // mirror that by making backgrounded threads inert for non-critical events.
  const isFocusedRef = useRef(true);

  useEffect(
    () => () => {
      if (typingClear.current) clearTimeout(typingClear.current);
    },
    [],
  );

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
          updateMessageById(prev, d.messageId, (message) =>
            applyMediaJobUpdate(message, d, true),
          ),
        );
        return;
      }
      if (msg.type === "chat_pin") {
        if (Number(d.conversationId) !== convId) return;
        setMessages((prev) =>
          updateMessageById(prev, d.messageId, (message) =>
            applyMessagePin(message, d),
          ),
        );
        loadPinned();
        return;
      }
      // Peer reactions — add/remove live (mirrors web chat_reaction handler).
      if (msg.type === "chat_reaction") {
        if (Number(d.conversationId) !== convId) return;
        setMessages((prev) =>
          updateMessageById(prev, d.messageId, (message) =>
            applyMessageReaction(message, d),
          ),
        );
        return;
      }
      // Peer edits — update content live (mirrors web chat_edit handler).
      if (msg.type === "chat_edit") {
        if (Number(d.conversationId) !== convId) return;
        setMessages((prev) =>
          updateMessageById(prev, d.messageId, (message) =>
            applyMessageEdit(message, d),
          ),
        );
        return;
      }
      // Peer deletions — mark deleted live (mirrors web chat_delete handler).
      if (msg.type === "chat_delete") {
        if (Number(d.conversationId) !== convId) return;
        setMessages((prev) =>
          updateMessageById(prev, d.messageId, applyMessageDelete),
        );
        return;
      }
      // Conversation cleared by a peer — empty the list (mirrors web).
      if (msg.type === "chat_cleared") {
        if (Number(d.conversationId) !== convId) return;
        messageGenerationRef.current += 1;
        latestLoadRequestRef.current += 1;
        olderRequestCursorRef.current = null;
        pendingTailScrollRef.current = null;
        setMessages([]);
        setPinnedMsgs([]);
        setHasMore(false);
        setLoadingOlder(false);
        setLoadOlderError(null);
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
        const realtimeMessage = mapRealtimeChatMessage(d);
        if (d.clientMsgId) {
          const idx = prev.findIndex((m) => m.clientMsgId === d.clientMsgId);
          if (idx >= 0) {
            const copy = [...prev];
            copy[idx] = realtimeMessage;
            return copy;
          }
        }
        if (prev.some((m) => m.id === d.id)) return prev;
        return [...prev, realtimeMessage];
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
      if (isOwn || atBottomRef.current) requestTailScroll(true);
    });
    return off;
  }, [
    convId,
    user?.id,
    loadPinned,
    markReadAndSync,
    requestTailScroll,
    router,
    atBottomRef,
    latestLoadRequestRef,
    messageGenerationRef,
    olderRequestCursorRef,
    pendingTailScrollRef,
    setHasMore,
    setLoadOlderError,
    setLoadingOlder,
    setMessages,
    setPinnedMsgs,
    setReadReceipts,
  ]);

  // When the peer starts typing, keep the newest bubble visible only if the user
  // is already near latest. Never restore/jump away from a historical window.
  useEffect(() => {
    if (peerTyping && atBottomRef.current) scrollToEnd(true);
  }, [atBottomRef, peerTyping, scrollToEnd]);

  return { peerTyping };
}
