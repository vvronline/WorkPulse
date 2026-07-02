import { useState, useEffect, useRef, useCallback } from "react";
import {
    searchChatUsers,
    getConversations,
    createConversation,
    getMessages,
    markConversationRead,
    getPresence,
    getMembers,
    getReadStatus,
    ackDelivered,
} from "../../api";
import { useAuth } from "../../AuthContext";
import { useChatUnread } from "../../ChatContext";
import useWebSocket from "../../hooks/useWebSocket";
import type { WebSocketMessage } from "../../hooks/useWebSocket";
import useChatNotification from "../../hooks/useChatNotification";
import useCallState from "./useCallState";
import type { AnyRecord } from "../../types";

type ChatMessage = AnyRecord & { id: number | string };
type Conversation = AnyRecord & { id: number | string };
type ChatDraft = {
    input: string;
    replyTo?: { id: number | string; content?: string | null; sender_name?: string | null } | null;
    editing?: { id: number | string; content?: string | null } | null;
};

export default function useChatState() {
    const { user } = useAuth();
    const { refreshUnread } = useChatUnread();
    const { notifyMessage, notifyMention, notifyReaction } =
        useChatNotification();

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
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [activeConv, setActiveConv] = useState<Conversation | null>(null);
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState("");
    const [search, setSearch] = useState("");
    const [searchResults, setSearchResults] = useState<AnyRecord[]>([]);
    const [searching, setSearching] = useState(false);
    const [loadingMsgs, setLoadingMsgs] = useState(false);
    const [loadingConvs, setLoadingConvs] = useState(true);
    const [hasMore, setHasMore] = useState(false);
    const [typingUsers, setTypingUsers] = useState<
        Record<string, number | string>
    >({});
    const [mobileView, setMobileView] = useState("list");

    // Feature state
    const [onlineUsers, setOnlineUsers] = useState<Set<number | string>>(
        new Set(),
    );
    const [userStatusMap, setUserStatusMap] = useState<Record<string, string>>(
        {},
    );
    const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
    const [editingMsg, setEditingMsg] = useState<ChatMessage | null>(null);
    const [showSearch, setShowSearch] = useState(false);
    const [showPinned, setShowPinned] = useState(false);
    const [showGroupModal, setShowGroupModal] = useState(false);
    const [groupEditData, setGroupEditData] = useState<AnyRecord | null>(null);
    const [forwardMsg, setForwardMsg] = useState<ChatMessage | null>(null);
    const [recording, setRecording] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const [readReceipts, setReadReceipts] = useState<Record<string, unknown>>(
        {},
    );
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);
    const [showSharedFiles, setShowSharedFiles] = useState(false);
    const [showStarred, setShowStarred] = useState(false);
    const [showPollCreator, setShowPollCreator] = useState(false);
    const [convMembers, setConvMembers] = useState<AnyRecord[]>([]);
    const [deleteConfirm, setDeleteConfirm] = useState<AnyRecord | null>(null);
    const [convMenu, setConvMenu] = useState<AnyRecord | null>(null);
    const pendingDraftReplyRef = useRef<ChatDraft["replyTo"]>(null);
    const pendingDraftEditRef = useRef<ChatDraft["editing"]>(null);

    // Refs
    const messagesEndRef = useRef<HTMLDivElement | null>(null);
    const messagesContainerRef = useRef<HTMLDivElement | null>(null);
    const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const typingTimeouts = useRef<
        Record<string, ReturnType<typeof setTimeout>>
    >({});
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
                                if (
                                    prev[d.conversationId as string] ===
                                    d.senderId
                                ) {
                                    const n = { ...prev };
                                    delete n[d.conversationId as string];
                                    return n;
                                }
                                return prev;
                            });
                            clearTimeout(
                                typingTimeouts.current[
                                    d.conversationId as string
                                ],
                            );
                        }
                        const msgFields: ChatMessage = {
                            id: d.id as number | string,
                            sender_id: d.senderId,
                            sender_name: d.senderName,
                            sender_avatar: d.senderAvatar,
                            content: d.content,
                            created_at: d.createdAt,
                            reply_to_id: d.replyToId || null,
                            reply_sender_name: d.replySenderName,
                            reply_content: d.replyContent,
                            file_url: d.fileUrl,
                            file_name: d.fileName,
                            file_type: d.fileType,
                            file_size: d.fileSize,
                            forwarded_from_id: d.forwardedFromId,
                            format_type: d.formatType || "text",
                            metadata: d.metadata || null,
                            media_job_id: d.mediaJobId || null,
                            media_state: d.mediaState || null,
                            media_progress:
                                typeof d.mediaProgress === "number"
                                    ? d.mediaProgress
                                    : null,
                            media_failure_reason: d.failureReason || null,
                            _mediaState: d.mediaState || null,
                            _mediaProgress:
                                typeof d.mediaProgress === "number"
                                    ? d.mediaProgress
                                    : null,
                            delivered_to: [],
                            reactions: [],
                        };
                        setMessages((prev) => {
                            // Deduplicate: don't add if a real message with this ID already exists
                            if (prev.some((m) => m.id === d.id)) return prev;
                            if (d.senderId === user?.id) {
                                const idx = d.clientMsgId
                                    ? prev.findIndex(
                                          (p) => p.id === d.clientMsgId,
                                      )
                                    : prev.findIndex(
                                          (p) =>
                                              String(p.id).startsWith(
                                                  "pending_",
                                              ) && p.content === d.content,
                                      );
                                if (idx >= 0) {
                                    const updated = [...prev];
                                    updated[idx] = msgFields;
                                    return updated;
                                }
                            }
                            return [...prev, msgFields];
                        });
                        markConversationRead(d.conversationId as number | string)
                            .then(() => refreshUnread())
                            .catch(() => {});
                        if (d.senderId !== user?.id && d.id) {
                            ackDelivered(d.id as number | string).catch(
                                () => {},
                            );
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
                        const isActive =
                            activeConvRef.current?.id === d.conversationId;
                        const exists = prev.some(
                            (c) => c.id === d.conversationId,
                        );
                        // If conversation is not in the list (created from another device), reload
                        if (!exists) {
                            loadConversations();
                            return prev;
                        }
                        const preview =
                            d.content ||
                            (d.fileName ? `📎 ${d.fileName}` : "🎤 Voice");
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
                                              : ((c.unread_count as number) ||
                                                    0) + 1,
                                      }
                                    : c,
                            )
                            .sort(
                                (a, b) =>
                                    new Date(
                                        (a.last_message_at as string) ||
                                            (a.updated_at as string),
                                    ).getTime() -
                                    new Date(
                                        (b.last_message_at as string) ||
                                            (b.updated_at as string),
                                    ).getTime(),
                            )
                            .reverse();
                    });
                    break;
                }
                case "chat_typing": {
                    setTypingUsers((prev) => ({
                        ...prev,
                        [d.conversationId as string]: d.userId as
                            | number
                            | string,
                    }));
                    clearTimeout(
                        typingTimeouts.current[d.conversationId as string],
                    );
                    typingTimeouts.current[d.conversationId as string] =
                        setTimeout(() => {
                            setTypingUsers((prev) => {
                                const n = { ...prev };
                                delete n[d.conversationId as string];
                                return n;
                            });
                        }, 3000);
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
                                          (d.reason as string) ||
                                          "Could not send message.",
                                  }
                                : m,
                        ),
                    );
                    break;
                }
                case "chat_media_job": {
                    if (activeConvRef.current?.id === d.conversationId) {
                        setMessages((prev) =>
                            prev.map((m) =>
                                m.id === d.messageId
                                    ? {
                                          ...m,
                                          media_job_id: d.mediaJobId || m.media_job_id,
                                          media_state: d.status || m.media_state,
                                          media_progress:
                                              typeof d.progress === "number"
                                                  ? d.progress
                                                  : m.media_progress,
                                          media_failure_reason:
                                              d.failureReason || null,
                                          _mediaState: d.status || m._mediaState,
                                          _mediaProgress:
                                              typeof d.progress === "number"
                                                  ? d.progress
                                                  : m._mediaProgress,
                                          _failureReason:
                                              d.failureReason || m._failureReason,
                                      }
                                    : m,
                            ),
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
                            if (target && target.sender_id === user?.id)
                                notifyReaction();
                        }
                        setMessages((prev) =>
                            prev.map((m) => {
                                if (m.id !== d.messageId) return m;
                                if (m.deleted_at) return { ...m, reactions: [] };
                                let reactions = [
                                    ...((m.reactions as AnyRecord[]) || []),
                                ];
                                if (d.action === "added") {
                                    // Idempotent: avoid duplicating an optimistically-added reaction.
                                    if (
                                        !reactions.some(
                                            (r) =>
                                                r.userId === d.userId &&
                                                r.emoji === d.emoji,
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
                                        (r) =>
                                            !(
                                                r.userId === d.userId &&
                                                r.emoji === d.emoji
                                            ),
                                    );
                                }
                                return { ...m, reactions };
                            }),
                        );
                    }
                    break;
                }
                case "chat_edit": {
                    if (activeConvRef.current?.id === d.conversationId) {
                        setMessages((prev) =>
                            prev.map((m) =>
                                m.id === d.messageId
                                    ? {
                                          ...m,
                                          content: d.content,
                                          edited_at: d.editedAt,
                                      }
                                    : m,
                            ),
                        );
                    }
                    break;
                }
                case "chat_delete": {
                    const target = messagesRef.current.find(
                        (m) => m.id === d.messageId,
                    );
                    const targetTs = target
                        ? new Date(target.created_at as string).getTime()
                        : null;
                    const isLatest =
                        targetTs != null &&
                        !messagesRef.current.some(
                            (m) =>
                                m.id !== d.messageId &&
                                new Date(m.created_at as string).getTime() >
                                    targetTs,
                        );
                    if (activeConvRef.current?.id === d.conversationId) {
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
                                          last_sender_name: target?.sender_name ?? c.last_sender_name,
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
                        setMessages((prev) =>
                            prev.map((m) =>
                                m.id === d.messageId
                                    ? {
                                          ...m,
                                          pinned_at: d.pinned
                                              ? new Date().toISOString()
                                              : null,
                                          pinned_by: d.pinned
                                              ? d.pinnedBy
                                              : null,
                                      }
                                    : m,
                            ),
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
                        if (
                            isOnline ===
                            prev.has(d.userId as number | string)
                        )
                            return prev;
                        const next = new Set(prev);
                        if (isOnline) next.add(d.userId as number | string);
                        else next.delete(d.userId as number | string);
                        return next;
                    });
                    setUserStatusMap((prev) => ({
                        ...prev,
                        [d.userId as string]:
                            (d.effective as string) ||
                            (isOnline ? "available" : "offline"),
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

    // Load conversations on mount
    useEffect(() => {
        loadConversations();
    }, []);

    // Sync current user's avatar into self-chat conversation
    useEffect(() => {
        setConversations((prev) =>
            prev.map((c) =>
                c.is_self_chat
                    ? { ...c, other_avatar: user?.avatar || null }
                    : c,
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
        const last = messages[messages.length - 1];
        const isOwn = last && Number(last.sender_id) === Number(user?.id);
        let nearBottom = true;
        if (container) {
            const distanceFromBottom =
                container.scrollHeight -
                container.scrollTop -
                container.clientHeight;
            nearBottom = distanceFromBottom < 160;
        }
        if (nearBottom || isOwn) {
            end.scrollIntoView({ behavior: "smooth" });
        }
        // Keyed on the newest message id (not the whole array) so reactions /
        // edits to older messages don't trigger a scroll.
    }, [lastMessageId]); // eslint-disable-line react-hooks/exhaustive-deps

    // ─── Core operations ───

    const loadConversations = async () => {
        setLoadingConvs(true);
        try {
            const { data } = await getConversations();
            setConversations(data as Conversation[]);
            const uids = new Set<number | string>();
            (data as Conversation[]).forEach((c) => {
                if (c.other_user_id)
                    uids.add(c.other_user_id as number | string);
            });
            if (uids.size > 0) {
                try {
                    const { data: pres } = await getPresence([...uids]);
                    const onlineSet = new Set<number | string>();
                    const statusMap: Record<string, string> = {};
                    for (const [k, v] of Object.entries(
                        pres as Record<string, unknown>,
                    )) {
                        const uid = Number(k);
                        if (typeof v === "object" && v !== null) {
                            // New format: { presence, userStatus }
                            const obj = v as {
                                presence?: string;
                                userStatus?: string;
                            };
                            const isOnline = obj.presence === "online";
                            if (isOnline) onlineSet.add(uid);
                            // If the user's WS is disconnected we must show
                            // them as 'offline' in chat — even if user_status
                            // in DB is still 'available' from a stale
                            // session. Otherwise the chat dot stays green
                            // while the navbar/profile shows offline.
                            statusMap[uid] = isOnline
                                ? obj.userStatus || "available"
                                : "offline";
                        } else {
                            // Legacy format: 'online' | 'offline'
                            if (v === "online") onlineSet.add(uid);
                            statusMap[uid] =
                                v === "online" ? "available" : "offline";
                        }
                    }
                    setOnlineUsers(onlineSet);
                    setUserStatusMap((prev) => ({ ...prev, ...statusMap }));
                } catch (e) {
                    console.error("Failed to load presence", e);
                }
            }
        } catch (e) {
            console.error("Failed to load conversations", e);
        }
        setLoadingConvs(false);
    };

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

    const openConversation = async (
        convId: number | string,
        convData: AnyRecord,
    ) => {
        setActiveConv({ ...convData, id: convId });
        setMessages([]);
        setLoadingMsgs(true);
        setMobileView("chat");
        setReplyTo(null);
        setEditingMsg(null);
        setShowPinned(false);
        setShowSearch(false);
        setShowSharedFiles(false);
        try {
            const { data } = await getMessages(convId);
            setMessages(data as ChatMessage[]);
            setHasMore((data as ChatMessage[]).length >= 50);
            await markConversationRead(convId);
            refreshUnread();
            wsSend("chat_read", { conversationId: convId });
            setConversations((prev) =>
                prev.map((c) =>
                    c.id === convId ? { ...c, unread_count: 0 } : c,
                ),
            );
            try {
                const { data: rs } = await getReadStatus(convId);
                const map: Record<string, unknown> = {};
                (rs as AnyRecord[]).forEach((r) => {
                    map[r.user_id as string] = r.last_read_at;
                });
                setReadReceipts(map);
            } catch (e) {
                console.error("Failed to load read status", e);
            }
            try {
                const { data: members } = await getMembers(convId);
                setConvMembers(members as AnyRecord[]);
            } catch (e) {
                setConvMembers([]);
                console.error("Failed to load members", e);
            }
        } catch (e) {
            console.error("Failed to open conversation", e);
        }
        setLoadingMsgs(false);
    };

    const loadMore = async () => {
        if (!activeConv || messages.length === 0 || !hasMore) return;
        const container = messagesContainerRef.current;
        const prevHeight = container?.scrollHeight || 0;
        try {
            const { data } = await getMessages(
                activeConv.id,
                String(messages[0].id),
            );
            setMessages((prev) => [...(data as ChatMessage[]), ...prev]);
            setHasMore((data as ChatMessage[]).length >= 50);
            requestAnimationFrame(() => {
                if (container)
                    container.scrollTop =
                        container.scrollHeight - prevHeight;
            });
        } catch (e) {
            console.error("Failed to load more messages", e);
        }
    };

    const draftKey =
        activeConv?.id != null ? `chat:draft:${String(activeConv.id)}` : null;

    useEffect(() => {
        pendingDraftReplyRef.current = null;
        pendingDraftEditRef.current = null;
        if (!draftKey) return;
        try {
            const raw = localStorage.getItem(draftKey);
            if (!raw) return;
            const parsed = JSON.parse(raw) as ChatDraft;
            if (typeof parsed.input === "string") setInput(parsed.input);
            if (parsed.replyTo) pendingDraftReplyRef.current = parsed.replyTo;
            if (parsed.editing) pendingDraftEditRef.current = parsed.editing;
        } catch {
            // ignore malformed drafts
        }
    }, [draftKey]);

    useEffect(() => {
        if (!messages.length) return;
        if (pendingDraftReplyRef.current?.id != null) {
            const match = messages.find((m) => m.id === pendingDraftReplyRef.current!.id);
            if (match) {
                setReplyTo(match);
                pendingDraftReplyRef.current = null;
            }
        }
        if (pendingDraftEditRef.current?.id != null) {
            const match = messages.find((m) => m.id === pendingDraftEditRef.current!.id);
            if (match) {
                setEditingMsg(match);
                if (typeof pendingDraftEditRef.current.content === "string") {
                    setInput(pendingDraftEditRef.current.content);
                }
                pendingDraftEditRef.current = null;
            }
        }
    }, [messages]);

    useEffect(() => {
        if (!draftKey) return;
        const payload: ChatDraft = {
            input,
            replyTo: replyTo
                ? {
                    id: replyTo.id,
                    content: (replyTo.content as string) || null,
                    sender_name: (replyTo.sender_name as string) || null,
                }
                : null,
            editing: editingMsg
                ? {
                    id: editingMsg.id,
                    content: (editingMsg.content as string) || null,
                }
                : null,
        };
        if (!payload.input.trim() && !payload.replyTo && !payload.editing) {
            localStorage.removeItem(draftKey);
            return;
        }
        localStorage.setItem(draftKey, JSON.stringify(payload));
    }, [draftKey, input, replyTo, editingMsg]);

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
        loadingConvs,
        hasMore,
        typingUsers,
        mobileView,
        setMobileView,
        onlineUsers,
        userStatusMap,
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
        showPollCreator,
        setShowPollCreator,
        convMembers,
        deleteConfirm,
        setDeleteConfirm,
        convMenu,
        setConvMenu,
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
