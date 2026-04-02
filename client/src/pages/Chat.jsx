import ConfirmDialog from '../components/ConfirmDialog';
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
import { getConvName } from './chat/chatUtils';
import s from './Chat.module.css';
import msgStyles from './chat/ChatMessages.module.css';

export default function Chat() {
    const state = useChatState();
    const actions = useChatActions(state);

    const {
        user, conversations, activeConv, messages, input, setInput,
        search, setSearch, searchResults, searching,
        typingUsers, mobileView, setMobileView, onlineUsers,
        replyTo, editingMsg, showSearch, setShowSearch,
        showPinned, setShowPinned, showGroupModal, setShowGroupModal,
        groupEditData, setGroupEditData, forwardMsg, setForwardMsg,
        recording, setRecording, dragOver, setDragOver, readReceipts,
        showEmojiPicker, setShowEmojiPicker,
        showSharedFiles, setShowSharedFiles, showStarred, setShowStarred,
        showPollCreator, setShowPollCreator, convMembers,
        deleteConfirm, setDeleteConfirm, convMenu, setConvMenu,
        callState, wsSend,
        loadingMsgs, hasMore,
        messagesEndRef, messagesContainerRef, fileInputRef, mentionInputRef,
        searchInputRef,
        startConversation, openConversation, loadMore, loadConversations,
    } = state;

    const {
        handleSend, handleFileUpload, handleVoiceSend, handleDrop,
        handleReply, handleEdit, handleDelete, handlePin, handleReact,
        handleForward, handleStar, handleCreatePoll, handleEmojiInsert,
        handleJumpTo, handleUnpin,
        handleDeleteConv, handlePinConv, handleFavConv,
        openGroupEdit, handleTyping,
        handleVoiceCall, handleVideoCall, handleEndCall,
    } = actions;

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
                convMenu={convMenu}
                mobileView={mobileView}
                onSearchUser={startConversation}
                onOpenConv={(c) => openConversation(c.id, {
                    other_user_id: c.other_user_id,
                    other_username: c.other_username,
                    other_full_name: c.other_full_name,
                    other_avatar: c.other_avatar,
                    is_group: c.is_group,
                    group_name: c.group_name,
                    name: c.name,
                    member_count: c.member_count
                })}
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

            {/* ─── Call Overlay ─── */}
            {callState && (
                <CallOverlay
                    callState={callState}
                    user={user}
                    wsSend={wsSend}
                    onEnd={handleEndCall}
                />
            )}
        </div>
    );
}
