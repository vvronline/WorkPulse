import {
    uploadChatFile, toggleReaction, editMessage, deleteMessage, togglePin,
    toggleStar, createPoll, deleteConversation,
    togglePinConversation, toggleFavouriteConversation, getMembers
} from '../../api';

export default function useChatActions(state) {
    const {
        user, wsSend,
        activeConv, setActiveConv,
        messages, setMessages,
        input, setInput,
        setConversations,
        replyTo, setReplyTo,
        editingMsg, setEditingMsg,
        setForwardMsg,
        setRecording, setDragOver,
        setShowEmojiPicker, setShowPollCreator,
        setDeleteConfirm, setConvMenu,
        setShowGroupModal, setGroupEditData,
        mentionInputRef, pendingCounter, typingTimerRef,
        refreshUnread,
        setCallState, callSignalRef, callEndRef
    } = state;

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
            }).catch(() => { });
            setEditingMsg(null);
            setInput('');
            return;
        }
        const mentions = mentionInputRef.current?.getMentionedIds?.() || [];
        mentionInputRef.current?.resetMentionedIds?.();

        setMessages(prev => [...prev, {
            id: `pending_${++pendingCounter.current}`, sender_id: user.id, sender_name: user.full_name,
            content, created_at: new Date().toISOString(), reply_to_id: replyTo?.id || null,
            reactions: []
        }]);
        wsSend('chat_message', {
            conversationId: activeConv.id, content,
            ...(replyTo ? { replyToId: replyTo.id } : {}),
            ...(mentions.length > 0 ? { mentions } : {})
        });
        setInput('');
        setReplyTo(null);
    };

    // ─── File upload ───
    const handleFileUpload = async (file) => {
        if (!activeConv || !file) return;
        const formData = new FormData();
        formData.append('file', file);
        try { await uploadChatFile(activeConv.id, formData); } catch { /* ignore */ }
    };

    // ─── Voice send ───
    const handleVoiceSend = (blob, _duration, ext = 'webm') => {
        if (!activeConv) return;
        const formData = new FormData();
        formData.append('file', blob, `voice.${ext}`);
        uploadChatFile(activeConv.id, formData).catch(() => { });
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
    const handleReply = (msg) => { setReplyTo(msg); setEditingMsg(null); };
    const handleEdit = (msg) => { setEditingMsg(msg); setInput(msg.content || ''); setReplyTo(null); };

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
        try { await toggleReaction(msgId, emoji); } catch { /* ignore */ }
    };

    const handleForward = (msg) => setForwardMsg(msg);

    const handleStar = async (msg) => {
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

    // ─── Conversation actions ───
    const handleDeleteConv = async (convId) => {
        try {
            await deleteConversation(convId);
            if (activeConv?.id === convId) { setActiveConv(null); setMessages([]); }
            setConversations(prev => prev.filter(c => c.id !== convId));
            refreshUnread();
        } catch { /* ignore */ }
        setDeleteConfirm(null);
    };

    const handlePinConv = async (convId) => {
        try {
            const { data } = await togglePinConversation(convId);
            setConversations(prev => prev.map(c =>
                c.id === convId ? { ...c, is_pinned: data.pinned } : c
            ));
        } catch { /* ignore */ }
        setConvMenu(null);
    };

    const handleFavConv = async (convId) => {
        try {
            const { data } = await toggleFavouriteConversation(convId);
            setConversations(prev => prev.map(c =>
                c.id === convId ? { ...c, is_favourite: data.favourite } : c
            ));
        } catch { /* ignore */ }
        setConvMenu(null);
    };

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

    // ─── Call actions ───
    const initiateCall = async (callType) => {
        if (!activeConv) return;

        // Acquire media NOW inside the click handler (user gesture required by browsers)
        let stream = null;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: true,
                video: callType === 'video' ? { width: 1280, height: 720, facingMode: 'user' } : false
            });
        } catch (err) {
            console.error('Failed to get media:', err);
            alert('Could not access microphone' + (callType === 'video' ? '/camera' : '') + '. Please allow permissions and try again.');
            return;
        }

        const remoteName = activeConv.is_group
            ? (activeConv.group_name || activeConv.name)
            : (activeConv.other_full_name || activeConv.other_username);
        const remoteAvatar = activeConv.is_group ? null : activeConv.other_avatar;

        setCallState({
            callId: null,
            conversationId: activeConv.id,
            callType,
            isIncoming: false,
            callerId: user.id,
            remoteName,
            remoteAvatar,
            isGroup: activeConv.is_group || false,
            accepted: false,
            acceptedBy: null,
            onSignal: callSignalRef,
            onEndExternal: callEndRef,
            localStream: stream
        });

        wsSend('call_initiate', {
            conversationId: activeConv.id,
            callType
        });
    };

    const handleVoiceCall = () => initiateCall('voice');
    const handleVideoCall = () => initiateCall('video');
    const handleEndCall = () => setCallState(null);

    return {
        handleSend, handleFileUpload, handleVoiceSend, handleDrop,
        handleReply, handleEdit, handleDelete, handlePin, handleReact,
        handleForward, handleStar, handleCreatePoll, handleEmojiInsert,
        handleJumpTo, handleUnpin,
        handleDeleteConv, handlePinConv, handleFavConv,
        openGroupEdit, handleTyping,
        handleVoiceCall, handleVideoCall, handleEndCall,
    };
}
