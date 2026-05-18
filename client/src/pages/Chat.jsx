import { useState, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import ConfirmDialog from '../components/common/ConfirmDialog';
import { uploadChatFile } from '../api';
import {
    MessageSearch, ForwardModal, GroupModal,
    StarredMessages, PollCreator, CallOverlay
} from '../components/chat';
import ChatSidebar from './chat/ChatSidebar';
import ChatHeader from './chat/ChatHeader';
import ChatMessages from './chat/ChatMessages';
import ChatInputBar from './chat/ChatInputBar';
import useChatState from './chat/useChatState';
import useChatActions from './chat/useChatActions';
import { useUserStatus } from '../UserStatusContext';
import { getConvName } from './chat/chatUtils';
import s from './Chat.module.css';
import msgStyles from './chat/ChatMessages.module.css';

export default function Chat() {
    const state = useChatState();
    const actions = useChatActions(state);
    const { myStatus } = useUserStatus();
    const { pathname } = useLocation();
    const isChatPage = pathname === '/chat';

    const {
        user, conversations, activeConv, messages, input, setInput,
        search, setSearch, searchResults, searching,
        typingUsers, mobileView, setMobileView, onlineUsers,
        userStatusMap: rawStatusMap,
        replyTo, setReplyTo, editingMsg, setEditingMsg, showSearch, setShowSearch,
        showPinned, setShowPinned, showGroupModal, setShowGroupModal,
        groupEditData, setGroupEditData, forwardMsg, setForwardMsg,
        recording, setRecording, dragOver, setDragOver, readReceipts,
        showEmojiPicker, setShowEmojiPicker,
        showSharedFiles, setShowSharedFiles, showStarred, setShowStarred,
        showPollCreator, setShowPollCreator, convMembers,
        deleteConfirm, setDeleteConfirm, convMenu, setConvMenu,
        callState, wsSend, callReactionRef,
        loadingMsgs, loadingConvs, hasMore,
        messagesEndRef, messagesContainerRef, fileInputRef, mentionInputRef,
        searchInputRef,
        startConversation, openConversation, loadMore, loadConversations,
    } = state;

    const {
        handleSend, handleFileUpload, handleVoiceSend, handleDrop,
        handleReply, handleEdit, handleDelete, handlePin, handleReact,
        handleForward, handleStar, handleCreatePoll, handleEmojiInsert,
        handleJumpTo, handleUnpin,
        handleDeleteConv, handlePinConv, handleFavConv, handleClearChat,
        openGroupEdit, handleTyping,
        handleVoiceCall, handleVideoCall, handleEndCall,
    } = actions;

    // Ensure the current user's own status in the map reflects the local source of truth
    // (fixes self-chat showing stale server status like "away" when user is actually "available")
    const userStatusMap = user ? { ...rawStatusMap, [user.id]: myStatus } : rawStatusMap;

    const [clearConfirm, setClearConfirm] = useState(null);

    // Warn before closing/refreshing during an active call
    useEffect(() => {
        if (!callState) return;
        const handler = (e) => { e.preventDefault(); e.returnValue = ''; };
        window.addEventListener('beforeunload', handler);
        return () => window.removeEventListener('beforeunload', handler);
    }, [callState]);

    // When a call BECOMES active, auto-open its conversation ONCE so the
    // in-call chat panel has the live message history & WS updates. After
    // that the user must be free to browse other chats during the call —
    // including `activeConv?.id` in the deps below would re-fire this
    // effect every time the user clicks another conversation, instantly
    // forcing them back to the call's chat (making the sidebar look
    // "broken" / "mixing up" selections).
    //
    // We track the last conversationId we auto-opened in a ref so the
    // effect only acts when a *new* call starts, not when the user
    // intentionally navigates away during the same call.
    const lastAutoOpenedCallConvRef = useRef(null);
    useEffect(() => {
        const callConvId = callState?.conversationId;
        if (!callConvId) {
            lastAutoOpenedCallConvRef.current = null;
            return;
        }
        if (lastAutoOpenedCallConvRef.current === callConvId) return;
        lastAutoOpenedCallConvRef.current = callConvId;

        if (activeConv?.id === callConvId) return; // already on it

        // Find conversation metadata from the loaded list. If we don't have
        // it yet (e.g. a brand-new conversation created remotely), fall back
        // to a minimal stub — openConversation will still load the messages.
        const conv = conversations.find(c => c.id === callConvId);
        const meta = conv ? {
            other_user_id: conv.other_user_id,
            other_username: conv.other_username,
            other_full_name: conv.other_full_name,
            other_avatar: conv.other_avatar,
            is_group: conv.is_group,
            is_self_chat: conv.is_self_chat,
            group_name: conv.group_name,
            name: conv.name,
            member_count: conv.member_count,
        } : {
            other_full_name: callState.remoteName,
            other_avatar: callState.remoteAvatar,
            is_group: !!callState.isGroup,
        };
        openConversation(callConvId, meta);
    }, [callState?.conversationId, conversations]); // eslint-disable-line react-hooks/exhaustive-deps

    // Hide navbar & bottom tab bar on mobile when a chat conversation is active
    useEffect(() => {
        const isMobileChat = isChatPage && mobileView === 'chat' && activeConv;
        if (isMobileChat) {
            document.body.setAttribute('data-chat-active', '');
        } else {
            document.body.removeAttribute('data-chat-active');
        }
        return () => document.body.removeAttribute('data-chat-active');
    }, [isChatPage, mobileView, activeConv]);

    const jumpTo = (msgId) => handleJumpTo(msgId, msgStyles.highlight);

    return (
        <div className={s.chatPage}>
            <ChatSidebar
                conversations={conversations}
                activeConvId={activeConv?.id}
                search={search}
                setSearch={setSearch}
                searchResults={searchResults}
                searching={searching}
                typingUsers={typingUsers}
                onlineUsers={onlineUsers}
                userStatusMap={userStatusMap}
                convMenu={convMenu}
                mobileView={mobileView}
                loadingConvs={loadingConvs}
                onSearchUser={startConversation}
                onOpenConv={(c) => openConversation(c.id, {
                    other_user_id: c.other_user_id,
                    other_username: c.other_username,
                    other_full_name: c.other_full_name,
                    other_avatar: c.other_avatar,
                    is_group: c.is_group,
                    is_self_chat: c.is_self_chat,
                    group_name: c.group_name,
                    name: c.name,
                    member_count: c.member_count
                })}
                userId={user.id}
                onMenuToggle={(id) => setConvMenu(convMenu === id ? null : id)}
                onPinConv={handlePinConv}
                onFavConv={handleFavConv}
                onDeleteConv={(c) => { setConvMenu(null); setDeleteConfirm(c); }}
                onNewGroup={() => { setGroupEditData(null); setShowGroupModal(true); }}
                searchInputRef={searchInputRef}
            />

            <div className={`${s.chatArea} ${mobileView === 'list' ? s.hideMobile : ''}`}>
                {!activeConv ? (
                    <div className={s.noChat}>
                        <div className={s.noChatIcon}>💬</div>
                        <h3>Select a conversation</h3>
                        <p>Search for a colleague to start chatting</p>
                    </div>
                ) : (
                    <>
                        <ChatHeader
                            activeConv={activeConv}
                            onlineUsers={onlineUsers}
                            userStatusMap={userStatusMap}
                            onBack={() => setMobileView('list')}
                            onGroupEdit={openGroupEdit}
                            onToggleSearch={() => setShowSearch(true)}
                            onTogglePinned={() => setShowPinned(!showPinned)}
                            showPinned={showPinned}
                            onToggleSharedFiles={() => setShowSharedFiles(!showSharedFiles)}
                            showSharedFiles={showSharedFiles}
                            onToggleStarred={() => setShowStarred(!showStarred)}
                            showStarred={showStarred}
                            onVoiceCall={handleVoiceCall}
                            onVideoCall={handleVideoCall}
                            onClearChat={(convId) => setClearConfirm(convId)}
                        />

                        <ChatMessages
                            messages={messages}
                            user={user}
                            activeConv={activeConv}
                            convMembers={convMembers}
                            readReceipts={readReceipts}
                            typingUsers={typingUsers}
                            loadingMsgs={loadingMsgs}
                            hasMore={hasMore}
                            dragOver={dragOver}
                            messagesContainerRef={messagesContainerRef}
                            messagesEndRef={messagesEndRef}
                            onLoadMore={loadMore}
                            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                            onDragLeave={() => setDragOver(false)}
                            onDrop={handleDrop}
                            onReply={handleReply}
                            onEdit={handleEdit}
                            onDelete={handleDelete}
                            onPin={handlePin}
                            onForward={handleForward}
                            onReact={handleReact}
                            onStar={handleStar}
                            showPinned={showPinned}
                            onClosePinned={() => setShowPinned(false)}
                            onJumpTo={jumpTo}
                            onUnpin={handleUnpin}
                            showSharedFiles={showSharedFiles}
                            onCloseSharedFiles={() => setShowSharedFiles(false)}
                        />

                        <ChatInputBar
                            input={input}
                            setInput={setInput}
                            editingMsg={editingMsg}
                            replyTo={replyTo}
                            recording={recording}
                            showEmojiPicker={showEmojiPicker}
                            convMembers={convMembers}
                            mentionInputRef={mentionInputRef}
                            fileInputRef={fileInputRef}
                            isGroup={!!activeConv?.is_group}
                            onSend={handleSend}
                            onFileUpload={handleFileUpload}
                            onVoiceSend={handleVoiceSend}
                            onCancelRecording={() => setRecording(false)}
                            onStartRecording={() => setRecording(true)}
                            onEmojiInsert={handleEmojiInsert}
                            onToggleEmoji={() => setShowEmojiPicker(!showEmojiPicker)}
                            onOpenPollCreator={() => setShowPollCreator(true)}
                            onClearReply={() => setReplyTo(null)}
                            onClearEdit={() => { setEditingMsg(null); setInput(''); }}
                            onTyping={handleTyping}
                        />
                    </>
                )}
            </div>

            {/* ─── Modals ─── */}
            {showStarred && (
                <StarredMessages
                    onJumpTo={(convId, msgId) => { setShowStarred(false); jumpTo(msgId); }}
                    onClose={() => setShowStarred(false)}
                />
            )}
            {showPollCreator && (
                <PollCreator
                    onSubmit={handleCreatePoll}
                    onClose={() => setShowPollCreator(false)}
                />
            )}
            {showSearch && (
                <MessageSearch
                    convId={activeConv?.id}
                    onJumpTo={(msgId) => { setShowSearch(false); jumpTo(msgId); }}
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

            <ConfirmDialog
                isOpen={!!deleteConfirm}
                title="Delete Conversation"
                message={`Delete your conversation with ${deleteConfirm ? getConvName(deleteConfirm) : ''}? This will permanently remove all messages for everyone.`}
                confirmText="Delete"
                onConfirm={() => handleDeleteConv(deleteConfirm.id)}
                onCancel={() => setDeleteConfirm(null)}
            />

            <ConfirmDialog
                isOpen={!!clearConfirm}
                title="Clear Chat"
                message="Clear all messages in this conversation? This cannot be undone."
                confirmText="Clear"
                onConfirm={() => { handleClearChat(clearConfirm); setClearConfirm(null); }}
                onCancel={() => setClearConfirm(null)}
            />

            {/* ─── Call Overlay ─── */}
            {callState && (
                <CallOverlay
                    callState={callState}
                    user={user}
                    wsSend={wsSend}
                    onEnd={handleEndCall}
                    callReactionRef={callReactionRef}
                    chatMessages={callState.conversationId === activeConv?.id ? messages : []}
                    onSendChat={(text) => {
                        if (!text || !callState.conversationId) return;
                        // Send directly via the chat WS — the server echoes
                        // the message back through `chat_message`, which the
                        // useChatState handler picks up and appends to the
                        // active conversation's `messages` array. This is the
                        // same path the regular chat input bar uses.
                        wsSend('chat_message', {
                            conversationId: callState.conversationId,
                            content: text,
                        });
                    }}
                    onSendChatFile={(file) => {
                        // Reuse the same multipart upload endpoint the regular
                        // chat input uses. The server broadcasts a chat_message
                        // event so the file appears in both the in-call chat
                        // panel and the conversation history without extra
                        // wiring.
                        if (!file || !callState.conversationId) return;
                        const formData = new FormData();
                        formData.append('file', file);
                        uploadChatFile(callState.conversationId, formData).catch(() => { /* ignore */ });
                    }}
                />
            )}
        </div>
    );
}
