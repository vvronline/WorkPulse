import { useState, useEffect, useRef, useCallback } from 'react';
import {
    searchChatUsers, getConversations, createConversation, getMessages,
    markConversationRead, getPresence, getMembers, getReadStatus,
    uploadChatFile, toggleReaction, editMessage, deleteMessage, togglePin,
    forwardMessage
} from '../api';
import { useAuth } from '../AuthContext';
import { useChatUnread } from '../ChatContext';
import useWebSocket from '../hooks/useWebSocket';
import {
    ChatAvatar, MessageBubble, VoiceRecorder, ReplyPreview,
    MessageSearch, ForwardModal, GroupModal, PinnedMessages
} from '../components/chat';
import s from './Chat.module.css';

export default function Chat() {
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

    // New feature state
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

    // Refs
    const messagesEndRef = useRef(null);
    const messagesContainerRef = useRef(null);
    const typingTimerRef = useRef(null);
    const typingTimeouts = useRef({});
    const fileInputRef = useRef(null);
    const activeConvRef = useRef(activeConv);
    activeConvRef.current = activeConv;
    const messagesRef = useRef(messages);
    messagesRef.current = messages;

    // ─── WebSocket handler ───
    const onWsMessage = useCallback((msg) => {
        const d = msg.data;
        switch (msg.type) {
            case 'chat_message': {
                if (activeConvRef.current?.id === d.conversationId) {
                    setMessages(prev => {
                        if (d.senderId === user?.id) {
                            const idx = prev.findIndex(p => String(p.id).startsWith('pending_') && p.content === d.content);
                            if (idx >= 0) {
                                const updated = [...prev];
                                updated[idx] = {
                                    id: d.id, sender_id: d.senderId, sender_name: d.senderName,
                                    sender_avatar: d.senderAvatar, content: d.content, created_at: d.createdAt,
                                    reply_to_id: d.replyToId || null, reply_sender_name: d.replySenderName,
                                    reply_content: d.replyContent, file_url: d.fileUrl, file_name: d.fileName,
                                    file_type: d.fileType, file_size: d.fileSize, forwarded_from_id: d.forwardedFromId,
                                    reactions: []
                                };
                                return updated;
                            }
                        }
                        return [...prev, {
                            id: d.id, sender_id: d.senderId, sender_name: d.senderName,
                            sender_avatar: d.senderAvatar, content: d.content, created_at: d.createdAt,
                            reply_to_id: d.replyToId || null, reply_sender_name: d.replySenderName,
                            reply_content: d.replyContent, file_url: d.fileUrl, file_name: d.fileName,
                            file_type: d.fileType, file_size: d.fileSize, forwarded_from_id: d.forwardedFromId,
                            reactions: []
                        }];
                    });
                    markConversationRead(d.conversationId).then(() => refreshUnread()).catch(() => {});
                }
                setConversations(prev => {
                    const isActive = activeConvRef.current?.id === d.conversationId;
                    const preview = d.content || (d.fileName ? `📎 ${d.fileName}` : '🎤 Voice');
                    return prev.map(c =>
                        c.id === d.conversationId
                            ? { ...c, last_message: preview, last_sender_id: d.senderId, last_message_at: d.createdAt,
                                unread_count: (isActive || d.senderId === user.id) ? 0 : (c.unread_count || 0) + 1 }
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
            default: break;
        }
    }, [user?.id]);

    const { sendMessage: wsSend } = useWebSocket(onWsMessage);

    // ─── Load conversations & presence on mount ───
    useEffect(() => {
        loadConversations();
    }, []);

    const loadConversations = async () => {
        try {
            const { data } = await getConversations();
            setConversations(data);
            // Fetch presence for all unique user IDs
            const uids = new Set();
            data.forEach(c => {
                if (c.other_user_id) uids.add(c.other_user_id);
            });
            if (uids.size > 0) {
                try {
                    const { data: pres } = await getPresence([...uids]);
                    setOnlineUsers(new Set(
                        Object.entries(pres)
                            .filter(([, v]) => v === 'online')
                            .map(([k]) => Number(k))
                    ));
                } catch { /* ignore */ }
            }
        } catch { /* ignore */ }
    };

    // ─── Search users ───
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

    // ─── Start conversation from search ───
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

    // ─── Open conversation ───
    const openConversation = async (convId, convData) => {
        setActiveConv({ ...convData, id: convId });
        setMessages([]);
        setLoadingMsgs(true);
        setMobileView('chat');
        setReplyTo(null);
        setEditingMsg(null);
        setShowPinned(false);
        setShowSearch(false);
        try {
            const { data } = await getMessages(convId);
            setMessages(data);
            setHasMore(data.length >= 50);
            await markConversationRead(convId);
            refreshUnread();
            wsSend('chat_read', { conversationId: convId });
            setConversations(prev => prev.map(c =>
                c.id === convId ? { ...c, unread_count: 0 } : c
            ));
            // Load read receipts
            try {
                const { data: rs } = await getReadStatus(convId);
                const map = {};
                rs.forEach(r => { map[r.user_id] = r.last_read_at; });
                setReadReceipts(map);
            } catch { /* ignore */ }
        } catch { /* ignore */ }
        setLoadingMsgs(false);
    };

    // ─── Scroll to bottom ───
    useEffect(() => {
        if (messagesEndRef.current) {
            messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [messages]);

    // ─── Load older messages ───
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

    // ─── Send text message ───
    const handleSend = (e) => {
        e.preventDefault();
        if (!input.trim() || !activeConv) return;
        const content = input.trim();
        if (editingMsg) {
            editMessage(editingMsg.id, content).then(() => {
                setMessages(prev => prev.map(m =>
                    m.id === editingMsg.id ? { ...m, content, edited_at: new Date().toISOString() } : m
                ));
            }).catch(() => {});
            setEditingMsg(null);
            setInput('');
            return;
        }
        setMessages(prev => [...prev, {
            id: `pending_${Date.now()}`, sender_id: user.id, sender_name: user.full_name,
            content, created_at: new Date().toISOString(), reply_to_id: replyTo?.id || null,
            reactions: []
        }]);
        wsSend('chat_message', {
            conversationId: activeConv.id, content,
            ...(replyTo ? { replyToId: replyTo.id } : {})
        });
        setInput('');
        setReplyTo(null);
    };

    // ─── File upload ───
    const handleFileUpload = async (file) => {
        if (!activeConv || !file) return;
        const formData = new FormData();
        formData.append('file', file);
        try {
            await uploadChatFile(activeConv.id, formData);
        } catch { /* ignore */ }
    };

    // ─── Voice send ───
    const handleVoiceSend = (blob) => {
        if (!activeConv) return;
        const formData = new FormData();
        formData.append('file', blob, 'voice.webm');
        uploadChatFile(activeConv.id, formData).catch(() => {});
        setRecording(false);
    };

    // ─── Drag & drop ───
    const handleDrop = (e) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files[0];
        if (file) handleFileUpload(file);
    };

    // ─── Message actions ───
    const handleReply = (msg) => {
        setReplyTo(msg);
        setEditingMsg(null);
    };

    const handleEdit = (msg) => {
        setEditingMsg(msg);
        setInput(msg.content || '');
        setReplyTo(null);
    };

    const handleDelete = async (msg) => {
        try {
            await deleteMessage(msg.id);
            setMessages(prev => prev.map(m =>
                m.id === msg.id ? { ...m, deleted_at: new Date().toISOString() } : m
            ));
        } catch { /* ignore */ }
    };

    const handlePin = async (msg) => {
        try {
            await togglePin(msg.id);
            setMessages(prev => prev.map(m =>
                m.id === msg.id ? { ...m, pinned_at: m.pinned_at ? null : new Date().toISOString(), pinned_by: m.pinned_at ? null : user.id } : m
            ));
        } catch { /* ignore */ }
    };

    const handleReact = async (msgId, emoji) => {
        try {
            await toggleReaction(msgId, emoji);
        } catch { /* ignore */ }
    };

    const handleForward = (msg) => setForwardMsg(msg);

    const handleJumpTo = (msgId) => {
        const el = document.getElementById(`msg-${msgId}`);
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.classList.add(s.highlight);
            setTimeout(() => el.classList.remove(s.highlight), 2000);
        }
    };

    const handleUnpin = async (msgId) => {
        try {
            await togglePin(msgId);
            setMessages(prev => prev.map(m =>
                m.id === msgId ? { ...m, pinned_at: null, pinned_by: null } : m
            ));
        } catch { /* ignore */ }
    };

    // ─── Group actions ───
    const openGroupEdit = async () => {
        if (!activeConv?.is_group) return;
        try {
            const { data } = await getMembers(activeConv.id);
            setGroupEditData({ group: activeConv, members: data });
            setShowGroupModal(true);
        } catch { /* ignore */ }
    };

    // ─── Typing indicator ───
    const handleTyping = () => {
        if (!activeConv) return;
        clearTimeout(typingTimerRef.current);
        typingTimerRef.current = setTimeout(() => {
            wsSend('chat_typing', { conversationId: activeConv.id });
        }, 200);
    };

    // ─── Helpers ───
    const fmtTime = (ts) => {
        if (!ts) return '';
        const dt = new Date(ts);
        const now = new Date();
        if (dt.toDateString() === now.toDateString())
            return dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const yest = new Date(now);
        yest.setDate(yest.getDate() - 1);
        if (dt.toDateString() === yest.toDateString()) return 'Yesterday';
        return dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
    };

    const getConvName = (c) => {
        if (c.is_group) return c.group_name || c.name || 'Group';
        return c.other_full_name || 'Unknown';
    };

    const getConvAvatar = (c) => {
        if (c.is_group) return null;
        return c.other_avatar;
    };

    const isUserOnline = (c) => {
        if (c.is_group) return false;
        return onlineUsers.has(c.other_user_id);
    };

    const totalUnread = conversations.reduce((sum, c) => sum + (c.unread_count || 0), 0);

    return (
        <div className={s.chatPage}>
            {/* ─── Sidebar ─── */}
            <div className={`${s.sidebar} ${mobileView === 'chat' ? s.hideMobile : ''}`}>
                <div className={s.sidebarHeader}>
                    <h2>💬 Messages{totalUnread > 0 && <span className={s.totalBadge}>{totalUnread}</span>}</h2>
                    <button className={s.newGroupBtn} onClick={() => { setGroupEditData(null); setShowGroupModal(true); }} title="New group">👥+</button>
                </div>
                <div className={s.searchBox}>
                    <input
                        type="text"
                        placeholder="Search by name, username, or email..."
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        className={s.searchInput}
                    />
                    {search && (
                        <button className={s.clearBtn} onClick={() => { setSearch(''); setSearchResults([]); }}>✕</button>
                    )}
                </div>

                {search.trim().length >= 2 && (
                    <div className={s.searchResults}>
                        {searching && <div className={s.hint}>Searching...</div>}
                        {!searching && searchResults.length === 0 && <div className={s.hint}>No users found</div>}
                        {searchResults.map(u => (
                            <div key={u.id} className={s.searchItem} onClick={() => startConversation(u)}>
                                <ChatAvatar name={u.full_name} avatar={u.avatar} size="md" online={onlineUsers.has(u.id)} />
                                <div className={s.userInfo}>
                                    <div className={s.userName}>{u.full_name}</div>
                                    <div className={s.userMeta}>@{u.username}{u.email ? ` · ${u.email}` : ''}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {!search && (
                    <div className={s.convList}>
                        {conversations.length === 0 && (
                            <div className={s.empty}>No conversations yet. Search for a colleague to start chatting.</div>
                        )}
                        {conversations.map(c => (
                            <div
                                key={c.id}
                                className={`${s.convItem} ${activeConv?.id === c.id ? s.active : ''}`}
                                onClick={() => openConversation(c.id, {
                                    other_user_id: c.other_user_id,
                                    other_username: c.other_username,
                                    other_full_name: c.other_full_name,
                                    other_avatar: c.other_avatar,
                                    is_group: c.is_group,
                                    group_name: c.group_name,
                                    name: c.name,
                                    member_count: c.member_count
                                })}
                            >
                                <ChatAvatar name={getConvName(c)} avatar={getConvAvatar(c)} size="md" online={isUserOnline(c)} />
                                <div className={s.convInfo}>
                                    <div className={s.convTop}>
                                        <span className={s.convName}>
                                            {c.is_group && '👥 '}{getConvName(c)}
                                        </span>
                                        <span className={s.convTime}>{fmtTime(c.last_message_at)}</span>
                                    </div>
                                    <div className={s.convPreview}>
                                        {typingUsers[c.id]
                                            ? <span className={s.typing}>typing...</span>
                                            : <span className={c.unread_count > 0 ? s.unread : ''}>
                                                {c.is_group && c.last_sender_name ? `${c.last_sender_name.split(' ')[0]}: ` : ''}
                                                {c.last_message || 'No messages yet'}
                                              </span>}
                                        {c.unread_count > 0 && <span className={s.badge}>{c.unread_count}</span>}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* ─── Chat area ─── */}
            <div className={`${s.chatArea} ${mobileView === 'list' ? s.hideMobile : ''}`}>
                {!activeConv ? (
                    <div className={s.noChat}>
                        <div className={s.noChatIcon}>💬</div>
                        <h3>Select a conversation</h3>
                        <p>Search for a colleague to start chatting</p>
                    </div>
                ) : (
                    <>
                        <div className={s.chatHeader}>
                            <button className={s.backBtn} onClick={() => setMobileView('list')}>←</button>
                            <ChatAvatar
                                name={getConvName(activeConv)}
                                avatar={getConvAvatar(activeConv)}
                                size="md"
                                online={isUserOnline(activeConv)}
                            />
                            <div className={s.chatHeaderInfo} onClick={activeConv.is_group ? openGroupEdit : undefined}
                                 style={activeConv.is_group ? { cursor: 'pointer' } : undefined}>
                                <div className={s.chatHeaderName}>
                                    {activeConv.is_group && '👥 '}{getConvName(activeConv)}
                                </div>
                                <div className={s.chatHeaderMeta}>
                                    {activeConv.is_group
                                        ? `${activeConv.member_count || ''} members`
                                        : isUserOnline(activeConv) ? 'Online' : `@${activeConv.other_username}`}
                                </div>
                            </div>
                            <div className={s.headerActions}>
                                <button onClick={() => setShowSearch(true)} title="Search messages">🔍</button>
                                <button onClick={() => setShowPinned(!showPinned)} title="Pinned messages">📌</button>
                                {activeConv.is_group && <button onClick={openGroupEdit} title="Group settings">⚙️</button>}
                            </div>
                        </div>

                        <div className={s.chatBody}>
                            <div
                                className={`${s.messagesContainer} ${dragOver ? s.dragOver : ''}`}
                                ref={messagesContainerRef}
                                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                                onDragLeave={() => setDragOver(false)}
                                onDrop={handleDrop}
                            >
                                {dragOver && <div className={s.dropOverlay}>Drop file to send</div>}
                                {hasMore && (
                                    <button className={s.loadMore} onClick={loadMore}>Load older messages</button>
                                )}
                                {loadingMsgs && <div className={s.hint} style={{ padding: '2rem', textAlign: 'center' }}>Loading...</div>}
                                {!loadingMsgs && messages.length === 0 && (
                                    <div className={s.hint} style={{ padding: '2rem', textAlign: 'center' }}>
                                        No messages yet. Say hello! 👋
                                    </div>
                                )}
                                {messages.map((m, i) => {
                                    const isMine = m.sender_id === user.id;
                                    const showDate = i === 0 || new Date(m.created_at).toDateString() !== new Date(messages[i - 1].created_at).toDateString();
                                    // Teams-style grouping: show avatar/name only for first msg in a consecutive run from the same sender
                                    const prev = messages[i - 1];
                                    const isNewGroup = !prev || prev.sender_id !== m.sender_id || showDate
                                        || (new Date(m.created_at) - new Date(prev.created_at)) > 120000; // 2 min gap = new group
                                    return (
                                        <div key={m.id} id={`msg-${m.id}`}>
                                            {showDate && (
                                                <div className={s.dateDivider}>
                                                    <span>{new Date(m.created_at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</span>
                                                </div>
                                            )}
                                            <MessageBubble
                                                msg={m}
                                                isMine={isMine}
                                                userId={user.id}
                                                showAvatar={isNewGroup}
                                                showName={isNewGroup}
                                                onReply={handleReply}
                                                onEdit={handleEdit}
                                                onDelete={handleDelete}
                                                onPin={handlePin}
                                                onForward={handleForward}
                                                onReact={handleReact}
                                            />
                                        </div>
                                    );
                                })}
                                {typingUsers[activeConv?.id] && (
                                    <div className={`${s.message} ${s.theirs}`}>
                                        <div className={`${s.bubble} ${s.typingBubble}`}>
                                            <span className={s.typingDots}><i /><i /><i /></span>
                                        </div>
                                    </div>
                                )}
                                <div ref={messagesEndRef} />
                            </div>

                            {showPinned && (
                                <PinnedMessages
                                    convId={activeConv.id}
                                    currentUserId={user.id}
                                    onClose={() => setShowPinned(false)}
                                    onJumpTo={handleJumpTo}
                                    onUnpin={handleUnpin}
                                />
                            )}
                        </div>

                        {/* Reply / Edit preview */}
                        {(replyTo || editingMsg) && (
                            <div className={s.replyBar}>
                                {editingMsg
                                    ? <ReplyPreview senderName="Editing" content={editingMsg.content} onClear={() => { setEditingMsg(null); setInput(''); }} />
                                    : <ReplyPreview senderName={replyTo.sender_name} content={replyTo.content} onClear={() => setReplyTo(null)} />}
                            </div>
                        )}

                        {/* Voice recorder */}
                        {recording && (
                            <div className={s.voiceBar}>
                                <VoiceRecorder onSend={handleVoiceSend} onCancel={() => setRecording(false)} />
                            </div>
                        )}

                        {/* Input bar */}
                        {!recording && (
                            <form className={s.inputBar} onSubmit={handleSend}>
                                <button type="button" className={s.attachBtn} onClick={() => fileInputRef.current?.click()} title="Attach file">📎</button>
                                <input
                                    type="file"
                                    ref={fileInputRef}
                                    className={s.fileInput}
                                    onChange={e => { if (e.target.files[0]) handleFileUpload(e.target.files[0]); e.target.value = ''; }}
                                />
                                <input
                                    type="text"
                                    placeholder={editingMsg ? 'Edit message...' : 'Type a message...'}
                                    value={input}
                                    onChange={e => { setInput(e.target.value); handleTyping(); }}
                                    className={s.msgInput}
                                    maxLength={5000}
                                    autoFocus
                                />
                                <button type="button" className={s.voiceBtn} onClick={() => setRecording(true)} title="Voice message">🎤</button>
                                <button type="submit" className={s.sendBtn} disabled={!input.trim()}>
                                    {editingMsg ? '✓' : '➤'}
                                </button>
                            </form>
                        )}
                    </>
                )}
            </div>

            {/* ─── Modals ─── */}
            {showSearch && (
                <MessageSearch
                    convId={activeConv?.id}
                    onJumpTo={(msgId) => { setShowSearch(false); handleJumpTo(msgId); }}
                    onClose={() => setShowSearch(false)}
                />
            )}
            {forwardMsg && (
                <ForwardModal
                    msgId={forwardMsg.id}
                    conversations={conversations}
                    onClose={() => setForwardMsg(null)}
                    onSuccess={() => { setForwardMsg(null); }}
                />
            )}
            {showGroupModal && (
                <GroupModal
                    existingGroup={groupEditData?.group || null}
                    members={groupEditData?.members || []}
                    onClose={() => { setShowGroupModal(false); setGroupEditData(null); }}
                    onSuccess={() => { setShowGroupModal(false); setGroupEditData(null); loadConversations(); }}
                />
            )}
        </div>
    );
}
