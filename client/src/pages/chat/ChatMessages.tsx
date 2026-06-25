import { useEffect, useState } from "react";
import { ChevronDown, Pin, X } from "lucide-react";
import { ChatAvatar, MessageBubble, PinnedMessages, SharedFilesPanel, StarredMessages } from "../../components/chat";
import SystemMessage from "../../components/chat/SystemMessage";
import MeetingCard from "../../components/chat/MeetingCard";
import { buildTimelineRows } from "./timelineRows";
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
    onRetry: (...args: any[]) => void;
    onCancelUpload: (...args: any[]) => void;
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
    onRetry,
    onCancelUpload,
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
    const rows = buildTimelineRows(messages);

    // Signal-style "scroll to bottom" affordance. Tracks how far the user has
    // scrolled up from the bottom of the messages container; once they're more
    // than ~1.5 screens up a floating button fades in to jump back to the
    // newest message smoothly.
    const [showScrollBtn, setShowScrollBtn] = useState(false);
    useEffect(() => {
        const el = messagesContainerRef.current as HTMLDivElement | null;
        if (!el) return;
        const onScroll = () => {
            const distanceFromBottom =
                el.scrollHeight - el.scrollTop - el.clientHeight;
            setShowScrollBtn(distanceFromBottom > 400);
        };
        onScroll();
        el.addEventListener("scroll", onScroll, { passive: true });
        return () => el.removeEventListener("scroll", onScroll);
    }, [messagesContainerRef, activeConv?.id]);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

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
                {rows.map((row) => {
                    if (row.kind === "date") {
                        return (
                            <div key={row.key} className={s.dateDivider}>
                                <span>{row.label}</span>
                            </div>
                        );
                    }
                    if (row.kind === "system") {
                        return (
                            <div key={row.key} id={`msg-${row.msg.id}`}>
                                <SystemMessage msg={row.msg as any} />
                            </div>
                        );
                    }
                    if (row.kind === "meeting") {
                        return (
                            <div key={row.key} id={`msg-${row.msg.id}`}>
                                <div style={{ padding: "0 0.5rem" }}>
                                    <MeetingCard msg={row.msg} />
                                </div>
                            </div>
                        );
                    }
                    const m = row.msg;
                    const isMine = Number(m.sender_id) === Number(user.id);
                    return (
                        <div key={row.key} id={`msg-${m.id}`}>
                            <MessageBubble
                                msg={m}
                                isMine={isMine}
                                userId={user.id}
                                showAvatar={row.isNewGroup}
                                showName={row.isNewGroup && activeConv?.is_group}
                                onReply={onReply}
                                onEdit={onEdit}
                                onDelete={onDelete}
                                onPin={onPin}
                                onForward={onForward}
                                onReact={onReact}
                                onStar={onStar}
                                onRetry={onRetry}
                                onCancelUpload={onCancelUpload}
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

            {/* Floating "scroll to latest" button (Signal-style). Fades in once
                the user scrolls up past ~1.5 screens; smooth-scrolls to the
                newest message on click. */}
            <button
                type="button"
                className={`${s.scrollToBottom} ${showScrollBtn ? s.scrollToBottomVisible : ""}`}
                onClick={scrollToBottom}
                title="Scroll to latest"
                aria-label="Scroll to latest message"
            >
                <ChevronDown size={20} />
            </button>

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