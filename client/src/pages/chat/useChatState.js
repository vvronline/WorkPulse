import { useState, useEffect, useRef, useCallback } from 'react';
import {
    searchChatUsers, getConversations, createConversation, getMessages,
    markConversationRead, getPresence, getMembers, getReadStatus,
    ackDelivered
} from '../../api';
import { useAuth } from '../../AuthContext';
import { useChatUnread } from '../../ChatContext';
import useWebSocket from '../../hooks/useWebSocket';

export default function useChatState() {
    const { user } = useAuth();
    const { refreshUnread } = useChatUnread();

    // Core state
    const [conversations, setConversations] = useState([]);
    const [activeConv, setActiveConv] = useState(null);
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState('');
    const [search, setSearch] = useState('');
    const [searchResults, setSearchResults] = useState([]);
    const [searching, setSearching] = useState(false);
    const [loadingMsgs, setLoadingMsgs] = useState(false);
    const [hasMore, setHasMore] = useState(false);
    const [typingUsers, setTypingUsers] = useState({});
    const [mobileView, setMobileView] = useState('list');

    // Feature state
    const [onlineUsers, setOnlineUsers] = useState(new Set());
    const [replyTo, setReplyTo] = useState(null);
    const [editingMsg, setEditingMsg] = useState(null);
    const [showSearch, setShowSearch] = useState(false);
    const [showPinned, setShowPinned] = useState(false);
    const [showGroupModal, setShowGroupModal] = useState(false);
    const [groupEditData, setGroupEditData] = useState(null);
    const [forwardMsg, setForwardMsg] = useState(null);
    const [recording, setRecording] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const [readReceipts, setReadReceipts] = useState({});
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);
    const [showSharedFiles, setShowSharedFiles] = useState(false);
    const [showStarred, setShowStarred] = useState(false);
    const [showPollCreator, setShowPollCreator] = useState(false);
    const [convMembers, setConvMembers] = useState([]);
    const [deleteConfirm, setDeleteConfirm] = useState(null);
    const [convMenu, setConvMenu] = useState(null);

    // Refs
    const messagesEndRef = useRef(null);
    const messagesContainerRef = useRef(null);
    const typingTimerRef = useRef(null);
    const typingTimeouts = useRef({});
    const fileInputRef = useRef(null);
    const mentionInputRef = useRef(null);
    const pendingCounter = useRef(0);
    const activeConvRef = useRef(activeConv);
    const searchInputRef = useRef(null);
    activeConvRef.current = activeConv;
    const messagesRef = useRef(messages);
    messagesRef.current = messages;

    // ─── WebSocket handler ───
    const onWsMessage = useCallback((msg) => {
        const d = msg.data;
        switch (msg.type) {
            case 'chat_message': {
                if (activeConvRef.current?.id === d.conversationId) {
                    const msgFields = {
                        id: d.id, sender_id: d.senderId, sender_name: d.senderName,
                        sender_avatar: d.senderAvatar, content: d.content, created_at: d.createdAt,
                        reply_to_id: d.replyToId || null, reply_sender_name: d.replySenderName,
                        reply_content: d.replyContent, file_url: d.fileUrl, file_name: d.fileName,
                        file_type: d.fileType, file_size: d.fileSize, forwarded_from_id: d.forwardedFromId,
                        format_type: d.formatType || 'text', metadata: d.metadata || null,
                        delivered_to: [], reactions: []
                    };
                    setMessages(prev => {
                        if (d.senderId === user?.id) {
                            const idx = prev.findIndex(p => String(p.id).startsWith('pending_') && p.content === d.content);
                            if (idx >= 0) {
                                const updated = [...prev];
                                updated[idx] = msgFields;
                                return updated;
                            }
                        }
                        return [...prev, msgFields];
                    });
                    markConversationRead(d.conversationId).then(() => refreshUnread()).catch(() => { });
                    if (d.senderId !== user?.id && d.id) {
                        ackDelivered(d.id).catch(() => { });
                    }
                }
                setConversations(prev => {
                    const isActive = activeConvRef.current?.id === d.conversationId;
                    const preview = d.content || (d.fileName ? `📎 ${d.fileName}` : '🎤 Voice');
                    return prev.map(c =>
                        c.id === d.conversationId
                            ? {
                                ...c, last_message: preview, last_sender_id: d.senderId, last_message_at: d.createdAt,
                                unread_count: (isActive || d.senderId === user.id) ? 0 : (c.unread_count || 0) + 1
                            }
                            : c
                    ).sort((a, b) => new Date(b.last_message_at || b.updated_at) - new Date(a.last_message_at || a.updated_at));
                });
                break;
            }
            case 'chat_typing': {
                setTypingUsers(prev => ({ ...prev, [d.conversationId]: d.userId }));
                clearTimeout(typingTimeouts.current[d.conversationId]);
                typingTimeouts.current[d.conversationId] = setTimeout(() => {
                    setTypingUsers(prev => { const n = { ...prev }; delete n[d.conversationId]; return n; });
                }, 3000);
                break;
            }
            case 'chat_reaction': {
                if (activeConvRef.current?.id === d.conversationId) {
                    setMessages(prev => prev.map(m => {
                        if (m.id !== d.messageId) return m;
                        let reactions = [...(m.reactions || [])];
                        if (d.action === 'added') {
                            reactions.push({ userId: d.userId, fullName: d.fullName, emoji: d.emoji });
                        } else {
                            reactions = reactions.filter(r => !(r.userId === d.userId && r.emoji === d.emoji));
                        }
                        return { ...m, reactions };
                    }));
                }
                break;
            }
            case 'chat_edit': {
                if (activeConvRef.current?.id === d.conversationId) {
                    setMessages(prev => prev.map(m =>
                        m.id === d.messageId ? { ...m, content: d.content, edited_at: d.editedAt } : m
                    ));
                }
                break;
            }
            case 'chat_delete': {
                if (activeConvRef.current?.id === d.conversationId) {
                    setMessages(prev => prev.map(m =>
                        m.id === d.messageId ? { ...m, deleted_at: new Date().toISOString() } : m
                    ));
                }
                break;
            }
            case 'chat_pin': {
                if (activeConvRef.current?.id === d.conversationId) {
                    setMessages(prev => prev.map(m =>
                        m.id === d.messageId ? { ...m, pinned_at: d.pinned ? new Date().toISOString() : null, pinned_by: d.pinned ? d.pinnedBy : null } : m
                    ));
                }
                break;
            }
            case 'chat_read_receipt': {
                if (activeConvRef.current?.id === d.conversationId) {
                    setReadReceipts(prev => ({ ...prev, [d.userId]: d.readAt }));
                }
                break;
            }
            case 'presence_change': {
                setOnlineUsers(prev => {
                    const next = new Set(prev);
                    d.status === 'online' ? next.add(d.userId) : next.delete(d.userId);
                    return next;
                });
                break;
            }
            case 'chat_group_created':
            case 'chat_group_added': {
                loadConversations();
                break;
            }
            case 'chat_group_removed': {
                if (activeConvRef.current?.id === d.conversationId && d.userId === user?.id) {
                    setActiveConv(null);
                    setMessages([]);
                }
                loadConversations();
                break;
            }
            case 'chat_conv_deleted': {
                if (activeConvRef.current?.id === d.conversationId) {
                    setActiveConv(null);
                    setMessages([]);
                }
                setConversations(prev => prev.filter(c => c.id !== d.conversationId));
                break;
            }
            case 'chat_poll_vote': {
                window.dispatchEvent(new CustomEvent('poll_vote_update', { detail: d }));
                break;
            }
            case 'chat_mention': break;
            default: break;
        }
    }, [user?.id]);

    const { sendMessage: wsSend } = useWebSocket(onWsMessage);

    // ─── Effects ───

    // Close conv menu on outside click
    useEffect(() => {
        if (!convMenu) return;
        const handler = () => setConvMenu(null);
        document.addEventListener('click', handler);
        return () => document.removeEventListener('click', handler);
    }, [convMenu]);

    // Cleanup typing timeouts on unmount
    useEffect(() => {
        return () => {
            clearTimeout(typingTimerRef.current);
            Object.values(typingTimeouts.current).forEach(clearTimeout);
        };
    }, []);

    // Load conversations on mount
    useEffect(() => { loadConversations(); }, []);

    // Ctrl+F shortcut
    useEffect(() => {
        const handler = (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                e.preventDefault();
                if (activeConv) setShowSearch(true);
                else searchInputRef.current?.focus();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [activeConv]);

    // Search users
    useEffect(() => {
        if (search.trim().length < 2) { setSearchResults([]); return; }
        const timer = setTimeout(async () => {
            setSearching(true);
            try {
                const { data } = await searchChatUsers(search.trim());
                setSearchResults(data);
            } catch { setSearchResults([]); }
            setSearching(false);
        }, 300);
        return () => clearTimeout(timer);
    }, [search]);

    // Scroll to bottom on new messages
    useEffect(() => {
        if (messagesEndRef.current) {
            messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [messages]);

    // ─── Core operations ───

    const loadConversations = async () => {
        try {
            const { data } = await getConversations();
            setConversations(data);
            const uids = new Set();
            data.forEach(c => { if (c.other_user_id) uids.add(c.other_user_id); });
            if (uids.size > 0) {
                try {
                    const { data: pres } = await getPresence([...uids]);
                    setOnlineUsers(new Set(
                        Object.entries(pres).filter(([, v]) => v === 'online').map(([k]) => Number(k))
                    ));
                } catch { /* ignore */ }
            }
        } catch { /* ignore */ }
    };

    const startConversation = async (otherUser) => {
        try {
            const { data } = await createConversation(otherUser.id);
            setSearch('');
            setSearchResults([]);
            await loadConversations();
            openConversation(data.conversationId, {
                other_user_id: otherUser.id,
                other_username: otherUser.username,
                other_full_name: otherUser.full_name,
                other_avatar: otherUser.avatar
            });
        } catch { /* ignore */ }
    };

    const openConversation = async (convId, convData) => {
        setActiveConv({ ...convData, id: convId });
        setMessages([]);
        setLoadingMsgs(true);
        setMobileView('chat');
        setReplyTo(null);
        setEditingMsg(null);
        setShowPinned(false);
        setShowSearch(false);
        setShowSharedFiles(false);
        try {
            const { data } = await getMessages(convId);
            setMessages(data);
            setHasMore(data.length >= 50);
            await markConversationRead(convId);
            refreshUnread();
            wsSend('chat_read', { conversationId: convId });
            setConversations(prev => prev.map(c => c.id === convId ? { ...c, unread_count: 0 } : c));
            try {
                const { data: rs } = await getReadStatus(convId);
                const map = {};
                rs.forEach(r => { map[r.user_id] = r.last_read_at; });
                setReadReceipts(map);
            } catch { /* ignore */ }
            try {
                const { data: members } = await getMembers(convId);
                setConvMembers(members);
            } catch { setConvMembers([]); }
        } catch { /* ignore */ }
        setLoadingMsgs(false);
    };

    const loadMore = async () => {
        if (!activeConv || messages.length === 0 || !hasMore) return;
        const container = messagesContainerRef.current;
        const prevHeight = container?.scrollHeight || 0;
        try {
            const { data } = await getMessages(activeConv.id, messages[0].id);
            setMessages(prev => [...data, ...prev]);
            setHasMore(data.length >= 50);
            requestAnimationFrame(() => {
                if (container) container.scrollTop = container.scrollHeight - prevHeight;
            });
        } catch { /* ignore */ }
    };

    return {
        user, wsSend, loadConversations, refreshUnread,
        // State
        conversations, setConversations,
        activeConv, setActiveConv,
        messages, setMessages,
        input, setInput,
        search, setSearch,
        searchResults, searching,
        loadingMsgs, hasMore,
        typingUsers,
        mobileView, setMobileView,
        onlineUsers,
        replyTo, setReplyTo,
        editingMsg, setEditingMsg,
        showSearch, setShowSearch,
        showPinned, setShowPinned,
        showGroupModal, setShowGroupModal,
        groupEditData, setGroupEditData,
        forwardMsg, setForwardMsg,
        recording, setRecording,
        dragOver, setDragOver,
        readReceipts,
        showEmojiPicker, setShowEmojiPicker,
        showSharedFiles, setShowSharedFiles,
        showStarred, setShowStarred,
        showPollCreator, setShowPollCreator,
        convMembers,
        deleteConfirm, setDeleteConfirm,
        convMenu, setConvMenu,
        // Refs
        messagesEndRef, messagesContainerRef,
        fileInputRef, mentionInputRef,
        pendingCounter, typingTimerRef,
        searchInputRef,
        // Operations
        startConversation, openConversation, loadMore,
    };
}
