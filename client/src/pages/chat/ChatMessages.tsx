import { Pin, X } from "lucide-react";
import { ChatAvatar, MessageBubble, PinnedMessages, SharedFilesPanel, StarredMessages } from "../../components/chat";
import SystemMessage from "../../components/chat/SystemMessage";
import MeetingCard from "../../components/chat/MeetingCard";
import s from "./ChatMessages.module.css";

interface ChatMessagesProps {
    messages: any[];
    user: any;
    activeConv: any;
    convMembers: any[];
    readReceipts: any;
    typingUsers: Record<string, any>;
    loadingMsgs: boolean;
    hasMore: boolean;
    dragOver: boolean;
    messagesContainerRef: any;
    messagesEndRef: any;
    onLoadMore: () => void;
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
    onReply: (...args: any[]) => void;
    onEdit: (...args: any[]) => void;
    onDelete: (...args: any[]) => void;
    onPin: (...args: any[]) => void;
    onForward: (...args: any[]) => void;
    onReact: (...args: any[]) => void;
    onStar: (...args: any[]) => void;
    showPinned: boolean;
    onClosePinned: () => void;
    onJumpTo: (...args: any[]) => void;
    onUnpin: (...args: any[]) => void;
    showSharedFiles: boolean;
    onCloseSharedFiles: () => void;
    showStarred: boolean;
    onCloseStarred: () => void;
    onJumpToStarred: (...args: any[]) => void;
}

export default function ChatMessages({
    messages,
    user,
    activeConv,
    convMembers,
    readReceipts,
    typingUsers,
    loadingMsgs,
    hasMore,
    dragOver,
    messagesContainerRef,
    messagesEndRef,
    onLoadMore,
    onDragOver,
    onDragLeave,
    onDrop,
    onReply,
    onEdit,
    onDelete,
    onPin,
    onForward,
    onReact,
    onStar,
    showPinned,
    onClosePinned,
    onJumpTo,
    onUnpin,
    showSharedFiles,
    onCloseSharedFiles,
    showStarred,
    onCloseStarred,
    onJumpToStarred,
}: ChatMessagesProps) {
    // Pinned messages currently loaded in the thread, newest pin first. Drives
    // the banner shown at the very top of the chat window so pinned messages
    // are actually surfaced "at the top of the chat" (not only in the side panel).
    const pinnedInView = messages
        .filter((m) => m.pinned_at && !m.deleted_at)
        .sort(
            (a, b) =>
                new Date(b.pinned_at).getTime() - new Date(a.pinned_at).getTime(),
        );
    const latestPin = pinnedInView[0];

    return (
        <div className={s.chatBody}>
            <div
                className={`${s.messagesContainer} ${dragOver ? s.dragOver : ""}`}
                ref={messagesContainerRef}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
            >
                {latestPin && (
                    <div className={s.pinnedBanner}>
                        <button
                            type="button"
                            className={s.pinnedBannerMain}
                            onClick={() => onJumpTo?.(latestPin.id)}
                            title="Jump to pinned message"
                        >
                            <Pin size={14} className={s.pinnedBannerIcon} />
                            <span className={s.pinnedBannerLabel}>
                                Pinned
                                {pinnedInView.length > 1 ? ` · ${pinnedInView.length}` : ""}
                            </span>
                            <span className={s.pinnedBannerText}>
                                {latestPin.content ||
                                    (latestPin.file_name
                                        ? `📎 ${latestPin.file_name}`
                                        : "🎤 Voice message")}
                            </span>
                        </button>
                        <button
                            type="button"
                            className={s.pinnedBannerUnpin}
                            onClick={() => onUnpin?.(latestPin.id)}
                            title="Unpin"
                        >
                            <X size={14} />
                        </button>
                    </div>
                )}
                {dragOver && <div className={s.dropOverlay}>Drop file to send</div>}
                {hasMore && (
                    <button className={s.loadMore} onClick={onLoadMore}>
                        Load older messages
                    </button>
                )}
                {loadingMsgs && (
                    <div className={s.skeletonMessages}>
                        {[0, 1, 0, 0, 1, 0, 1, 1, 0].map((side, i) => (
                            <div key={i} className={`${s.skeletonBubbleRow} ${side ? s.skeletonMine : ""}`}>
                                {!side && <div className={s.skeletonMsgAvatar} />}
                                <div className={s.skeletonBubble} style={{ width: `${30 + (i % 4) * 15}%` }} />
                            </div>
                        ))}
                    </div>
                )}
                {!loadingMsgs && messages.length === 0 && (
                    <div className={s.hint} style={{ padding: "2rem", textAlign: "center" }}>
                        No messages yet. Say hello! 👋
                    </div>
                )}
                {messages.map((m, i) => {
                    const isMine = m.sender_id === user.id;
                    const showDate =
                        i === 0 ||
                        new Date(m.created_at).toDateString() !==
                            new Date(messages[i - 1].created_at).toDateString();
                    const prev = messages[i - 1];
                    // Consecutive messages from the same sender within 5 minutes
                    // form a group (see docs/CHAT_DESIGN_SPEC.md §4).
                    const isNewGroup =
                        !prev ||
                        prev.sender_id !== m.sender_id ||
                        showDate ||
                        new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() > 300000;

                    // System messages (call events, meeting events)
                    if (m.format_type === "system") {
                        return (
                            <div key={m.id} id={`msg-${m.id}`}>
                                {showDate && (
                                    <div className={s.dateDivider}>
                                        <span>
                                            {new Date(m.created_at).toLocaleDateString([], {
                                                weekday: "short",
                                                month: "short",
                                                day: "numeric",
                                            })}
                                        </span>
                                    </div>
                                )}
                                <SystemMessage msg={m} />
                            </div>
                        );
                    }

                    // Meeting invite cards
                    if (m.format_type === "meeting" && m.metadata?.meetingCode) {
                        return (
                            <div key={m.id} id={`msg-${m.id}`}>
                                {showDate && (
                                    <div className={s.dateDivider}>
                                        <span>
                                            {new Date(m.created_at).toLocaleDateString([], {
                                                weekday: "short",
                                                month: "short",
                                                day: "numeric",
                                            })}
                                        </span>
                                    </div>
                                )}
                                <div style={{ padding: "0 0.5rem" }}>
                                    <MeetingCard msg={m} />
                                </div>
                            </div>
                        );
                    }

                    return (
                        <div key={m.id} id={`msg-${m.id}`}>
                            {showDate && (
                                <div className={s.dateDivider}>
                                    <span>
                                        {new Date(m.created_at).toLocaleDateString([], {
                                            weekday: "short",
                                            month: "short",
                                            day: "numeric",
                                        })}
                                    </span>
                                </div>
                            )}
                            <MessageBubble
                                msg={m}
                                isMine={isMine}
                                userId={user.id}
                                showAvatar={isNewGroup}
                                showName={isNewGroup && activeConv?.is_group}
                                onReply={onReply}
                                onEdit={onEdit}
                                onDelete={onDelete}
                                onPin={onPin}
                                onForward={onForward}
                                onReact={onReact}
                                onStar={onStar}
                                onJumpTo={onJumpTo}
                                participantCount={convMembers.length || 2}
                                readReceipts={readReceipts}
                            />
                        </div>
                    );
                })}
                {typingUsers[activeConv?.id] &&
                    (() => {
                        const typingUserId = typingUsers[activeConv.id];
                        const typingMember = convMembers.find((m) => m.id === typingUserId);
                        return (
                            <div className={s.typingRow}>
                                <div className={s.typingAvatar}>
                                    <ChatAvatar
                                        name={typingMember?.full_name || ""}
                                        avatar={typingMember?.avatar}
                                        size="sm"
                                    />
                                </div>
                                <div className={`${s.bubble} ${s.typingBubble}`}>
                                    <span className={s.typingDots}>
                                        <i />
                                        <i />
                                        <i />
                                    </span>
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
            {showSharedFiles && <SharedFilesPanel convId={activeConv.id} onClose={onCloseSharedFiles} />}
            {showStarred && <StarredMessages onJumpTo={onJumpToStarred} onClose={onCloseStarred} />}
        </div>
    );
}