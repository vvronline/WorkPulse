import { ChatAvatar, MessageBubble, PinnedMessages, SharedFilesPanel } from '../../components/chat';
import SystemMessage from '../../components/chat/SystemMessage';
import MeetingCard from '../../components/chat/MeetingCard';
import s from './ChatMessages.module.css';

export default function ChatMessages({
    messages, user, activeConv, convMembers, readReceipts,
    typingUsers, loadingMsgs, hasMore, dragOver,
    messagesContainerRef, messagesEndRef,
    onLoadMore, onDragOver, onDragLeave, onDrop,
    onReply, onEdit, onDelete, onPin, onForward, onReact, onStar,
    showPinned, onClosePinned, onJumpTo, onUnpin,
    showSharedFiles, onCloseSharedFiles
}) {
    return (
        <div className={s.chatBody}>
            <div
                className={`${s.messagesContainer} ${dragOver ? s.dragOver : ''}`}
                ref={messagesContainerRef}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
            >
                {dragOver && <div className={s.dropOverlay}>Drop file to send</div>}
                {hasMore && (
                    <button className={s.loadMore} onClick={onLoadMore}>Load older messages</button>
                )}
                {loadingMsgs && (
                    <div className={s.loadingContainer}>
                        <div className={s.msgSpinner} />
                        <span>Loading messages…</span>
                    </div>
                )}
                {!loadingMsgs && messages.length === 0 && (
                    <div className={s.hint} style={{ padding: '2rem', textAlign: 'center' }}>
                        No messages yet. Say hello! 👋
                    </div>
                )}
                {messages.map((m, i) => {
                    const isMine = m.sender_id === user.id;
                    const showDate = i === 0 || new Date(m.created_at).toDateString() !== new Date(messages[i - 1].created_at).toDateString();
                    const prev = messages[i - 1];
                    const isNewGroup = !prev || prev.sender_id !== m.sender_id || showDate
                        || (new Date(m.created_at) - new Date(prev.created_at)) > 120000;

                    // System messages (call events, meeting events)
                    if (m.format_type === 'system') {
                        return (
                            <div key={m.id} id={`msg-${m.id}`}>
                                {showDate && (
                                    <div className={s.dateDivider}>
                                        <span>{new Date(m.created_at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</span>
                                    </div>
                                )}
                                <SystemMessage msg={m} />
                            </div>
                        );
                    }

                    // Meeting invite cards
                    if (m.format_type === 'meeting' && m.metadata?.meetingCode) {
                        return (
                            <div key={m.id} id={`msg-${m.id}`}>
                                {showDate && (
                                    <div className={s.dateDivider}>
                                        <span>{new Date(m.created_at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</span>
                                    </div>
                                )}
                                <div style={{ padding: '0 0.5rem' }}>
                                    <MeetingCard msg={m} />
                                </div>
                            </div>
                        );
                    }

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
                                onReply={onReply}
                                onEdit={onEdit}
                                onDelete={onDelete}
                                onPin={onPin}
                                onForward={onForward}
                                onReact={onReact}
                                onStar={onStar}
                                participantCount={convMembers.length || 2}
                                readReceipts={readReceipts}
                            />
                        </div>
                    );
                })}
                {typingUsers[activeConv?.id] && (() => {
                    const typingUserId = typingUsers[activeConv.id];
                    const typingMember = convMembers.find(m => m.id === typingUserId);
                    return (
                        <div className={s.typingRow}>
                            <div className={s.typingAvatar}>
                                <ChatAvatar
                                    name={typingMember?.full_name || ''}
                                    avatar={typingMember?.avatar}
                                    size="sm"
                                />
                            </div>
                            <div className={`${s.bubble} ${s.typingBubble}`}>
                                <span className={s.typingDots}><i /><i /><i /></span>
                            </div>
                        </div>
                    );
                })()}
                <div ref={messagesEndRef} />
            </div>

            {showPinned && (
                <PinnedMessages
                    convId={activeConv.id}
                    currentUserId={user.id}
                    onClose={onClosePinned}
                    onJumpTo={onJumpTo}
                    onUnpin={onUnpin}
                />
            )}
            {showSharedFiles && (
                <SharedFilesPanel
                    convId={activeConv.id}
                    onClose={onCloseSharedFiles}
                />
            )}
        </div>
    );
}
