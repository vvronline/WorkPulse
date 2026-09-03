import { useState, useEffect, useRef, useCallback } from "react";
import {
  searchChatUsers,
  createConversation,
  markConversationRead,
  ackDelivered,
} from "../../api";
import { useAuth } from "../../AuthContext";
import { useChatUnread } from "../../ChatContext";
import useWebSocket from "../../hooks/useWebSocket";
import type { WebSocketMessage } from "../../hooks/useWebSocket";
import useChatNotification from "../../hooks/useChatNotification";
import useCallState from "./useCallState";
import useConversationDraft from "./useConversationDraft";
import useConversationLoader from "./useConversationLoader";
import useConversationList from "./useConversationList";
import {
  applyRealtimeDelete,
  applyRealtimeEdit,
  applyRealtimeMediaJob,
  applyRealtimePin,
  applyRealtimeReaction,
  mapRealtimeMessage,
  updateRealtimeMessage,
} from "./chatRealtimeReducers";
import useScrollPin from "./useScrollPin";
import { NEAR_BOTTOM_PX } from "./chatUtils";
import { reconcileOwnMessage } from "./messageDelivery";
import type { AnyRecord } from "../../types";

type ChatMessage = AnyRecord & { id: number | string };
type Conversation = AnyRecord & { id: number | string };

export default function useChatState() {
  const { user } = useAuth();
  const { refreshUnread, updateUnreadFromConversations } = useChatUnread();
  const { notifyMessage, notifyMention, notifyReaction } =
    useChatNotification();
  const {
    conversations,
    setConversations,
    loadingConversations: loadingConvs,
    onlineUsers,
    setOnlineUsers,
    userStatusMap,
    setUserStatusMap,
    userWorkModeMap,
    loadConversations,
  } = useConversationList({ updateUnreadFromConversations });

  // Ref for wsSend (allows useCallState to access it before WS is initialized)
  const wsSendRef = useRef<((type: string, data?: unknown) => void) | null>(
    null,
  );

  // Call state (extracted hook)
  const {
    callState,
    setCallState,
    callSignalRef,
    callEndRef,
    callReactionRef,
    callActiveRef,
    handleCallWsEvent,
  } = useCallState(wsSendRef);

  // Core state
  const [activeConv, setActiveConv] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<AnyRecord[]>([]);
  const [searching, setSearching] = useState(false);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [typingUsers, setTypingUsers] = useState<
    Record<string, number | string>
  >({});
  const [mobileView, setMobileView] = useState("list");

  // Feature state
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editingMsg, setEditingMsg] = useState<ChatMessage | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [showPinned, setShowPinned] = useState(false);
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [groupEditData, setGroupEditData] = useState<AnyRecord | null>(null);
  const [forwardMsg, setForwardMsg] = useState<ChatMessage | null>(null);
  const [recording, setRecording] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [readReceipts, setReadReceipts] = useState<Record<string, unknown>>({});
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showSharedFiles, setShowSharedFiles] = useState(false);
  const [showStarred, setShowStarred] = useState(false);
  // Conversation info drawer (mirrors the mobile /chat/info screen). Opened
  // by clicking the chat header profile.
  const [showInfo, setShowInfo] = useState(false);
  const [showPollCreator, setShowPollCreator] = useState(false);
  const [convMembers, setConvMembers] = useState<AnyRecord[]>([]);
  const [deleteConfirm, setDeleteConfirm] = useState<AnyRecord | null>(null);
  const [convMenu, setConvMenu] = useState<AnyRecord | null>(null);
  const [selectedMessageIds, setSelectedMessageIds] = useState<
    Set<number | string>
  >(new Set());

  // Refs
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingTimeouts = useRef<Record<string, ReturnType<typeof setTimeout>>>(
    {},
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mentionInputRef = useRef<HTMLInputElement | null>(null);
  const pendingCounter = useRef(0);
  const activeConvRef = useRef<Conversation | null>(activeConv);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  activeConvRef.current = activeConv;
  const messagesRef = useRef<ChatMessage[]>(messages);
  messagesRef.current = messages;

  // ─── WebSocket handler ───
  const onWsMessage = useCallback(
    (msg: WebSocketMessage) => {
      const d = msg.data as AnyRecord;
      switch (msg.type) {
        case "chat_message": {
          if (activeConvRef.current?.id === d.conversationId) {
            // Clear typing indicator for this sender
            if (d.senderId !== user?.id) {
              setTypingUsers((prev) => {
                if (prev[d.conversationId as string] === d.senderId) {
                  const n = { ...prev };
                  delete n[d.conversationId as string];
                  return n;
                }
                return prev;
              });
              clearTimeout(typingTimeouts.current[d.conversationId as string]);
            }
            const msgFields = mapRealtimeMessage(d);
            setMessages((prev) => {
              if (d.senderId === user?.id) {
                return reconcileOwnMessage(prev, d, msgFields);
              }
              // Deduplicate realtime events already loaded from history.
              if (prev.some((m) => m.id === d.id)) return prev;
              return [...prev, msgFields];
            });
            markConversationRead(d.conversationId as number | string).catch(
              () => {},
            );
            if (d.senderId !== user?.id && d.id) {
              ackDelivered(d.id as number | string).catch(() => {});
            }
          }
          // Play notification sound for messages from others
          if (d.senderId !== user?.id) {
            notifyMessage(
              d.senderName as string,
              d.content as string,
              d.conversationId as number | string,
            );
          }
          setConversations((prev) => {
            const isActive = activeConvRef.current?.id === d.conversationId;
            const exists = prev.some((c) => c.id === d.conversationId);
            // If conversation is not in the list (created from another device), reload
            if (!exists) {
              loadConversations();
              return prev;
            }
            const preview =
              d.content || (d.fileName ? `📎 ${d.fileName}` : "🎤 Voice");
            return prev
              .map((c) =>
                c.id === d.conversationId
                  ? {
                      ...c,
                      last_message: preview,
                      last_sender_id: d.senderId,
                      last_message_at: d.createdAt,
                      last_deleted: null,
                      // A brand-new message hasn't been
                      // read/delivered yet — reset the
                      // sidebar tick to "sent".
                      last_message_read: false,
                      last_message_delivered: false,
                      unread_count: isActive
                        ? 0
                        : ((c.unread_count as number) || 0) + 1,
                    }
                  : c,
              )
              .sort(
                (a, b) =>
                  new Date(
                    (a.last_message_at as string) || (a.updated_at as string),
                  ).getTime() -
                  new Date(
                    (b.last_message_at as string) || (b.updated_at as string),
                  ).getTime(),
              )
              .reverse();
          });
          break;
        }
        case "chat_typing": {
          setTypingUsers((prev) => ({
            ...prev,
            [d.conversationId as string]: d.userId as number | string,
          }));
          clearTimeout(typingTimeouts.current[d.conversationId as string]);
          typingTimeouts.current[d.conversationId as string] = setTimeout(
            () => {
              setTypingUsers((prev) => {
                const n = { ...prev };
                delete n[d.conversationId as string];
                return n;
              });
            },
            3000,
          );
          break;
        }
        case "chat_message_error": {
          const clientMsgId = d.clientMsgId as string | undefined;
          if (!clientMsgId) break;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === clientMsgId
                ? {
                    ...m,
                    _failed: true,
                    _pending: false,
                    _failureReason:
                      (d.reason as string) || "Could not send message.",
                  }
                : m,
            ),
          );
          break;
        }
        case "chat_media_job": {
          if (activeConvRef.current?.id === d.conversationId) {
            setMessages(
              (current) =>
                updateRealtimeMessage(
                  current,
                  d.messageId as number | string,
                  (message) => applyRealtimeMediaJob(message, d),
                ) as ChatMessage[],
            );
          }
          break;
        }
        case "chat_reaction": {
          if (activeConvRef.current?.id === d.conversationId) {
            // Notify when someone reacts to our message
            if (d.action === "added" && d.userId !== user?.id) {
              const target = messagesRef.current.find(
                (m) => m.id === d.messageId,
              );
              if (target && target.sender_id === user?.id) notifyReaction();
            }
            setMessages(
              (current) =>
                updateRealtimeMessage(
                  current,
                  d.messageId as number | string,
                  (message) => applyRealtimeReaction(message, d),
                ) as ChatMessage[],
            );
          }
          break;
        }
        case "chat_edit": {
          if (activeConvRef.current?.id === d.conversationId) {
            setMessages(
              (current) =>
                updateRealtimeMessage(
                  current,
                  d.messageId as number | string,
                  (message) => applyRealtimeEdit(message, d),
                ) as ChatMessage[],
            );
          }
          break;
        }
        case "chat_delete": {
          const target = messagesRef.current.find((m) => m.id === d.messageId);
          const targetTs = target
            ? new Date(target.created_at as string).getTime()
            : null;
          const isLatest =
            targetTs != null &&
            !messagesRef.current.some(
              (m) =>
                m.id !== d.messageId &&
                new Date(m.created_at as string).getTime() > targetTs,
            );
          if (activeConvRef.current?.id === d.conversationId) {
            setMessages(
              (current) =>
                updateRealtimeMessage(
                  current,
                  d.messageId as number | string,
                  applyRealtimeDelete,
                ) as ChatMessage[],
            );
          }
          if (isLatest) {
            setConversations((prev) =>
              prev.map((c) =>
                c.id === d.conversationId
                  ? {
                      ...c,
                      last_message: null,
                      last_file_url: null,
                      last_deleted: new Date().toISOString(),
                      last_sender_id: target?.sender_id ?? c.last_sender_id,
                      last_sender_name:
                        target?.sender_name ?? c.last_sender_name,
                    }
                  : c,
              ),
            );
          }
          break;
        }
        case "chat_cleared": {
          if (activeConvRef.current?.id === d.conversationId) {
            setMessages([]);
          }
          setConversations((prev) =>
            prev.map((c) =>
              c.id === d.conversationId
                ? {
                    ...c,
                    last_message: null,
                    last_sender_id: null,
                  }
                : c,
            ),
          );
          break;
        }
        case "chat_pin": {
          if (activeConvRef.current?.id === d.conversationId) {
            setMessages(
              (current) =>
                updateRealtimeMessage(
                  current,
                  d.messageId as number | string,
                  (message) => applyRealtimePin(message, d),
                ) as ChatMessage[],
            );
          }
          break;
        }
        case "chat_read_receipt": {
          if (activeConvRef.current?.id === d.conversationId) {
            setReadReceipts((prev) => ({
              ...prev,
              [d.userId as string]: d.readAt,
            }));
          }
          // Sidebar read receipt (Signal parity): a peer reading the
          // conversation flips the list row's tick to "read" live.
          if (d.userId !== user?.id) {
            setConversations((prev) =>
              prev.map((c) =>
                c.id === d.conversationId
                  ? { ...c, last_message_read: true }
                  : c,
              ),
            );
          }
          break;
        }
        case "user_status": {
          // PR7: legacy `presence_change` and `status_change` events
          // were retired in favour of the unified `user_status` event
          // broadcast by services/status/broadcaster.js. We keep a
          // local copy in `onlineUsers` / `userStatusMap` so the chat
          // sidebar dots don't have to re-render through the global
          // StatusContext. The two values are kept in sync by
          // construction — both consume the same event.
          if (!d?.userId) break;
          const isOnline = d.presence === "online";
          setOnlineUsers((prev) => {
            if (isOnline === prev.has(d.userId as number | string)) return prev;
            const next = new Set(prev);
            if (isOnline) next.add(d.userId as number | string);
            else next.delete(d.userId as number | string);
            return next;
          });
          setUserStatusMap((prev) => ({
            ...prev,
            [d.userId as string]:
              (d.effective as string) || (isOnline ? "available" : "offline"),
          }));
          break;
        }
        case "chat_group_created":
        case "chat_group_added": {
          loadConversations();
          break;
        }
        case "chat_group_removed": {
          if (
            activeConvRef.current?.id === d.conversationId &&
            d.userId === user?.id
          ) {
            setActiveConv(null);
            setMessages([]);
          }
          loadConversations();
          break;
        }
        case "chat_conv_muted": {
          setConversations((prev) =>
            prev.map((c) =>
              c.id === d.conversationId
                ? {
                    ...c,
                    is_muted: d.muted,
                    muted_until: d.mutedUntil || null,
                  }
                : c,
            ),
          );
          break;
        }
        case "chat_conv_archived": {
          setConversations((prev) =>
            prev.map((c) =>
              c.id === d.conversationId ? { ...c, is_archived: d.archived } : c,
            ),
          );
          break;
        }
        case "chat_user_blocked": {
          setConversations((prev) =>
            prev.map((c) =>
              !c.is_group && c.other_user_id === d.userId
                ? { ...c, is_blocked: d.blocked }
                : c,
            ),
          );
          break;
        }
        case "chat_conv_deleted": {
          if (activeConvRef.current?.id === d.conversationId) {
            setActiveConv(null);
            setMessages([]);
          }
          setConversations((prev) =>
            prev.filter((c) => c.id !== d.conversationId),
          );
          break;
        }
        case "chat_poll_vote": {
          window.dispatchEvent(
            new CustomEvent("poll_vote_update", { detail: d }),
          );
          break;
        }
        case "chat_mention": {
          if (d.senderId !== user?.id) {
            notifyMention(
              d.senderName as string,
              d.content as string,
              d.conversationId as number | string,
            );
          }
          break;
        }
        // ─── Call events (delegated to useCallState) ───
        case "call_incoming":
        case "call_started":
        case "call_accepted":
        case "call_rejected":
        case "call_ended":
        case "call_signal":
        case "call_reconnect":
        case "call_peer_ready":
        case "call_reaction": {
          handleCallWsEvent(msg.type, d);
          break;
        }
        default:
          break;
      }
    },
    [user?.id],
  );

  const { sendMessage: wsSend } = useWebSocket(onWsMessage);

  // Keep wsSendRef in sync for useCallState
  useEffect(() => {
    wsSendRef.current = wsSend;
  }, [wsSend]);

  // ─── Effects ───

  // Close conv menu on outside click
  useEffect(() => {
    if (!convMenu) return;
    const handler = () => setConvMenu(null);
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [convMenu]);

  // Cleanup typing timeouts on unmount or conversation change
  useEffect(() => {
    return () => {
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      Object.values(typingTimeouts.current).forEach(clearTimeout);
      typingTimeouts.current = {};
    };
  }, [activeConv?.id]);

  // Sync current user's avatar into self-chat conversation
  useEffect(() => {
    setConversations((prev) =>
      prev.map((c) =>
        c.is_self_chat ? { ...c, other_avatar: user?.avatar || null } : c,
      ),
    );
    if (activeConv?.is_self_chat) {
      setActiveConv((prev) =>
        prev ? { ...prev, other_avatar: user?.avatar || null } : prev,
      );
    }
  }, [user?.avatar]);

  // Ctrl+F shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        if (activeConv) setShowSearch(true);
        else searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeConv]);

  // Search users
  useEffect(() => {
    if (search.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const { data } = await searchChatUsers(search.trim());
        setSearchResults(data as AnyRecord[]);
      } catch {
        setSearchResults([]);
      }
      setSearching(false);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // ─── Initial "open at the latest message" pin ───
  // Extracted to useScrollPin so the scroll behaviour can be unit tested
  // directly; see that hook for why the naive rAF-only approach left the
  // thread parked mid-history on desktop.
  const { userScrolledUpRef } = useScrollPin({
    containerRef: messagesContainerRef,
    conversationId: activeConv?.id ?? null,
    loading: loadingMsgs,
    isEmpty: messages.length === 0,
  });

  // Scroll to bottom on new messages — Signal-style "smart" auto-scroll. We
  // only follow the conversation to the newest message when the user is
  // ALREADY near the bottom (or it's their own freshly-sent message). If they
  // have scrolled up to read history we leave their position untouched so the
  // view doesn't yank them down every time a message arrives (the floating
  // "scroll to latest" button in ChatMessages lets them jump back manually).
  const lastMessageId = messages.length
    ? messages[messages.length - 1].id
    : null;
  useEffect(() => {
    const end = messagesEndRef.current;
    const container = messagesContainerRef.current;
    if (!end) return;
    // The initial open is owned by the pin effect above — skip this one
    // while the thread is still hydrating so the two don't fight.
    if (loadingMsgs) return;
    const last = messages[messages.length - 1];
    const isOwn = last && Number(last.sender_id) === Number(user?.id);
    let nearBottom = true;
    if (container) {
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      nearBottom = distanceFromBottom < NEAR_BOTTOM_PX;
    }
    if (nearBottom || isOwn) {
      if (isOwn) userScrolledUpRef.current = false;
      end.scrollIntoView({ behavior: "smooth" });
    }
    // Keyed on the newest message id (not the whole array) so reactions /
    // edits to older messages don't trigger a scroll.
  }, [lastMessageId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Core operations ───

  const startConversation = async (otherUser: AnyRecord) => {
    try {
      const { data } = await createConversation(
        otherUser.id as number | string,
      );
      setSearch("");
      setSearchResults([]);
      await loadConversations();
      openConversation((data as AnyRecord).conversationId as number | string, {
        other_user_id: otherUser.id,
        other_username: otherUser.username,
        other_full_name: otherUser.full_name,
        other_avatar: otherUser.avatar,
        is_self_chat: otherUser.id === user?.id,
      });
    } catch (e) {
      console.error("Failed to start conversation", e);
    }
  };

  const selectConversation = useCallback(
    (convId: number | string, convData: AnyRecord) => {
      const selected = { ...convData, id: convId } as Conversation;
      // Update synchronously so an immediately-resolved request observes
      // the new active conversation before React's next render.
      activeConvRef.current = selected;
      setActiveConv(selected);
      setMobileView("chat");
      setReplyTo(null);
      setEditingMsg(null);
      setShowPinned(false);
      setShowSearch(false);
      setShowSharedFiles(false);
      setShowInfo(false);
      setSelectedMessageIds(new Set());
    },
    [],
  );

  const markConversationReadInList = useCallback((convId: number | string) => {
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === convId
          ? { ...conversation, unread_count: 0 }
          : conversation,
      ),
    );
  }, []);

  const sendReadReceipt = useCallback(
    (convId: number | string) => {
      wsSend("chat_read", { conversationId: convId });
    },
    [wsSend],
  );

  const { openConversation, loadMore } = useConversationLoader({
    activeConversation: activeConv,
    activeConversationRef: activeConvRef,
    messages,
    hasMore,
    messagesContainerRef,
    setMessages,
    setHasMore,
    setLoading: setLoadingMsgs,
    setLoadingMore,
    setLoadMoreError,
    setReadReceipts,
    setMembers: setConvMembers,
    onSelectConversation: selectConversation,
    onMarkedRead: markConversationReadInList,
    sendReadReceipt,
  });

  useConversationDraft({
    identity:
      user?.id != null
        ? {
            id: user.id as number | string,
            tenantId: user.tenant_id as number | string | null | undefined,
          }
        : null,
    conversationId: activeConv?.id,
    messages,
    input,
    setInput,
    replyTo,
    setReplyTo,
    editingMessage: editingMsg,
    setEditingMessage: setEditingMsg,
  });

  return {
    user,
    wsSend,
    loadConversations,
    refreshUnread,
    // State
    conversations,
    setConversations,
    activeConv,
    setActiveConv,
    messages,
    setMessages,
    input,
    setInput,
    search,
    setSearch,
    searchResults,
    searching,
    loadingMsgs,
    loadingMore,
    loadMoreError,
    loadingConvs,
    hasMore,
    setHasMore,
    typingUsers,
    mobileView,
    setMobileView,
    onlineUsers,
    userStatusMap,
    userWorkModeMap,
    replyTo,
    setReplyTo,
    editingMsg,
    setEditingMsg,
    showSearch,
    setShowSearch,
    showPinned,
    setShowPinned,
    showGroupModal,
    setShowGroupModal,
    groupEditData,
    setGroupEditData,
    forwardMsg,
    setForwardMsg,
    recording,
    setRecording,
    dragOver,
    setDragOver,
    readReceipts,
    showEmojiPicker,
    setShowEmojiPicker,
    showSharedFiles,
    setShowSharedFiles,
    showStarred,
    setShowStarred,
    showInfo,
    setShowInfo,
    showPollCreator,
    setShowPollCreator,
    convMembers,
    deleteConfirm,
    setDeleteConfirm,
    convMenu,
    setConvMenu,
    selectedMessageIds,
    setSelectedMessageIds,
    // Call state
    callState,
    setCallState,
    callSignalRef,
    callEndRef,
    callReactionRef,
    callActiveRef,
    // Refs
    messagesEndRef,
    messagesContainerRef,
    fileInputRef,
    mentionInputRef,
    pendingCounter,
    typingTimerRef,
    searchInputRef,
    // Operations
    startConversation,
    openConversation,
    loadMore,
  };
}
