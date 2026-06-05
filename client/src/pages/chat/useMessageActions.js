import {
    uploadChatFile, toggleReaction, editMessage, deleteMessage, togglePin,
    toggleStar, createPoll
} from '../../api';

export default function useMessageActions(state) {
    const {
        user, wsSend,
        activeConv,
        messages, setMessages,
        input, setInput,
        replyTo, setReplyTo,
        editingMsg, setEditingMsg,
        setForwardMsg,
        setRecording, setDragOver,
        setShowEmojiPicker, setShowPollCreator,
        mentionInputRef, pendingCounter,
    } = state;

    const handleSend = (e) => {
        e.preventDefault();
        if (!input.trim() || !activeConv) return;
        const content = input.trim();
        if (editingMsg) {
            editMessage(editingMsg.id, content).then(() => {
                setMessages(prev => prev.map(m =>
                    m.id === editingMsg.id ? { ...m, content, edited_at: new Date().toISOString() } : m
                ));
            }).catch(() => { });
            setEditingMsg(null);
            setInput('');
            return;
        }
        const mentions = mentionInputRef.current?.getMentionedIds?.() || [];
        mentionInputRef.current?.resetMentionedIds?.();

        const clientMsgId = `pending_${++pendingCounter.current}`;
        setMessages(prev => [...prev, {
            id: clientMsgId, sender_id: user.id, sender_name: user.full_name,
            content, created_at: new Date().toISOString(), reply_to_id: replyTo?.id || null,
            reactions: []
        }]);
        wsSend('chat_message', {
            conversationId: activeConv.id, content, clientMsgId,
            ...(replyTo ? { replyToId: replyTo.id } : {}),
            ...(mentions.length > 0 ? { mentions } : {})
        });
        setInput('');
        setReplyTo(null);
    };

    const handleFileUpload = async (file) => {
        if (!activeConv || !file) return;
        const formData = new FormData();
        formData.append('file', file);
        try { await uploadChatFile(activeConv.id, formData); } catch { /* ignore */ }
    };

    const handleVoiceSend = (blob, _duration, ext = 'webm') => {
        if (!activeConv) return;
        const formData = new FormData();
        formData.append('file', blob, `voice.${ext}`);
        uploadChatFile(activeConv.id, formData).catch(() => { });
        setRecording(false);
    };

    const handleDrop = (e) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files[0];
        if (file) handleFileUpload(file);
    };

    const handleReply = (msg) => { setReplyTo(msg); setEditingMsg(null); };
    const handleEdit = (msg) => {
        if (String(msg.id).startsWith('pending_')) return;
        setEditingMsg(msg); setInput(msg.content || ''); setReplyTo(null);
    };

    const handleDelete = async (msg) => {
        if (String(msg.id).startsWith('pending_')) return;
        try {
            await deleteMessage(msg.id);
            setMessages(prev => prev.map(m =>
                m.id === msg.id ? { ...m, deleted_at: new Date().toISOString() } : m
            ));
        } catch { /* ignore */ }
    };

    const handlePin = async (msg) => {
        if (String(msg.id).startsWith('pending_')) return;
        try {
            await togglePin(msg.id);
            setMessages(prev => prev.map(m =>
                m.id === msg.id ? { ...m, pinned_at: m.pinned_at ? null : new Date().toISOString(), pinned_by: m.pinned_at ? null : user.id } : m
            ));
        } catch { /* ignore */ }
    };

    const handleReact = async (msgId, emoji) => {
        if (String(msgId).startsWith('pending_')) return;
        // Optimistic toggle: update UI immediately, the WS echo reconciles.
        const toggle = (prev) => prev.map(m => {
            if (m.id !== msgId) return m;
            const reactions = m.reactions || [];
            const mine = reactions.some(r => r.userId === user.id && r.emoji === emoji);
            return {
                ...m,
                reactions: mine
                    ? reactions.filter(r => !(r.userId === user.id && r.emoji === emoji))
                    : [...reactions, { userId: user.id, fullName: user.full_name, emoji }],
            };
        });
        setMessages(toggle);
        try {
            await toggleReaction(msgId, emoji);
        } catch {
            // Revert on failure (toggle is its own inverse).
            setMessages(toggle);
        }
    };

    const handleForward = (msg) => {
        if (String(msg.id).startsWith('pending_')) return;
        setForwardMsg(msg);
    };

    const handleStar = async (msg) => {
        if (String(msg.id).startsWith('pending_')) return;
        try {
            const { data } = await toggleStar(msg.id);
            setMessages(prev => prev.map(m =>
                m.id === msg.id ? { ...m, starred: data.starred } : m
            ));
        } catch { /* ignore */ }
    };

    const handleCreatePoll = async (pollData) => {
        if (!activeConv) return;
        try { await createPoll(activeConv.id, pollData); setShowPollCreator(false); } catch { /* ignore */ }
    };

    const handleEmojiInsert = (emoji) => { setInput(prev => prev + emoji); setShowEmojiPicker(false); };

    const handleJumpTo = (msgId, highlightClass) => {
        const el = document.getElementById(`msg-${msgId}`);
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            if (highlightClass) {
                el.classList.add(highlightClass);
                setTimeout(() => el.classList.remove(highlightClass), 2000);
            }
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

    return {
        handleSend, handleFileUpload, handleVoiceSend, handleDrop,
        handleReply, handleEdit, handleDelete, handlePin, handleReact,
        handleForward, handleStar, handleCreatePoll, handleEmojiInsert,
        handleJumpTo, handleUnpin,
    };
}
