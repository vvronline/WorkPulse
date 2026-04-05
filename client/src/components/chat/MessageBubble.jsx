import { useState, useCallback, useRef, useEffect } from 'react';
import { Pin, Star, Pencil, Trash2 } from 'lucide-react';
import s from './MessageBubble.module.css';
import ChatAvatar from './ChatAvatar';
import FilePreview from './FilePreview';
import ReplyPreview from './ReplyPreview';
import ContextMenu from './ContextMenu';
import PollDisplay from './PollDisplay';
import MessageContent from './MessageContent';
import DeliveryStatus from './DeliveryStatus';
import MessageToolbar from './MessageToolbar';
import ReactionBar from './ReactionBar';

export default function MessageBubble({
    msg, isMine, userId, showAvatar, showName,
    onReply, onEdit, onDelete, onPin, onForward, onReact, onStar,
    participantCount, readReceipts
}) {
    const [showReactions, setShowReactions] = useState(false);
    const [ctxMenu, setCtxMenu] = useState(null);
    const [toolbarOpen, setToolbarOpen] = useState(false);
    const bubbleRef = useRef(null);
    const rowRef = useRef(null);

    const handleContext = useCallback((e) => {
        e.preventDefault();
        setCtxMenu({ x: e.clientX, y: e.clientY });
    }, []);

    const handleTouchEnd = useCallback((e) => {
        if (e.target.closest && (
            e.target.closest('[data-toolbar]') ||
            e.target.closest('[data-picker]') ||
            e.target.closest('[data-reaction]')
        )) return;
        setToolbarOpen(t => !t);
    }, []);

    useEffect(() => {
        if (!toolbarOpen) return;
        const handler = (e) => {
            if (rowRef.current && !rowRef.current.contains(e.target)) {
                setToolbarOpen(false);
            }
        };
        document.addEventListener('touchstart', handler, { passive: true });
        return () => document.removeEventListener('touchstart', handler);
    }, [toolbarOpen]);

    if (msg.deleted_at) {
        return (
            <div className={`${s.row} ${isMine ? s.mine : s.theirs} ${!showAvatar ? s.grouped : s.groupStart}`}>
                <div className={s.avatarCol}>
                    {showAvatar && <ChatAvatar name={msg.sender_name} avatar={msg.sender_avatar} size="sm" />}
                </div>
                <div className={`${s.bubble} ${s.deleted}`}>
                    <em>This message was deleted</em>
                </div>
            </div>
        );
    }

    const isPoll = msg.format_type === 'poll' && msg.metadata?.pollId;

    const menuItems = [
        isMine && !msg.file_url && !isPoll && { icon: <Pencil size={14} />, label: 'Edit', onClick: () => onEdit?.(msg) },
        { icon: <Pin size={14} />, label: msg.pinned_at ? 'Unpin' : 'Pin', onClick: () => onPin?.(msg) },
        { icon: <Star size={14} />, label: msg.starred ? 'Unsave' : 'Save', onClick: () => onStar?.(msg) },
        { icon: <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M14 7H7a5 5 0 000 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>, label: 'Forward', onClick: () => onForward?.(msg) },
        isMine && { icon: <Trash2 size={14} />, label: 'Delete', onClick: () => onDelete?.(msg), danger: true },
    ];

    return (
        <div ref={rowRef} className={`${s.row} ${isMine ? s.mine : s.theirs} ${!showAvatar ? s.grouped : s.groupStart}`}>
            <div className={s.avatarCol}>
                {showAvatar && <ChatAvatar name={msg.sender_name} avatar={msg.sender_avatar} size="sm" />}
            </div>

            <div className={s.bubbleWrap}>
                {showName && !isMine && msg.sender_name && (
                    <div className={s.senderName}>{msg.sender_name}</div>
                )}
                {showName && isMine && (
                    <div className={`${s.senderName} ${s.mineName}`}>You</div>
                )}

                <div
                    ref={bubbleRef}
                    className={`${s.bubble} ${isMine ? s.myBubble : s.theirBubble} ${msg.pinned_at ? s.pinned : ''} ${msg.starred ? s.starredBubble : ''} ${toolbarOpen ? s.toolbarActive : ''}`}
                    onContextMenu={handleContext}
                    onTouchEnd={handleTouchEnd}
                >
                    {msg.pinned_at && <div className={s.pinnedBadge}><Pin size={11} style={{marginRight:4}} />Pinned</div>}
                    {msg.starred && <div className={s.starBadge}><Star size={11} /></div>}

                    {msg.forwarded_from_id && (
                        <div className={s.forwarded}>↗ Forwarded</div>
                    )}

                    {msg.reply_to_id && (
                        <ReplyPreview
                            senderName={msg.reply_sender_name || 'User'}
                            content={msg.reply_content}
                        />
                    )}

                    {msg.file_url && (
                        <FilePreview
                            fileUrl={msg.file_url}
                            fileName={msg.file_name}
                            fileType={msg.file_type}
                            fileSize={msg.file_size}
                            isMessage
                        />
                    )}

                    {isPoll && <PollDisplay pollId={msg.metadata.pollId} userId={userId} isMine={isMine} />}

                    {msg.content && !isPoll && (
                        <MessageContent text={msg.content} isMine={isMine} />
                    )}

                    <div className={s.meta}>
                        <span className={s.time}>
                            {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        {msg.edited_at && <span className={s.edited}>(edited)</span>}
                        <DeliveryStatus
                            isMine={isMine}
                            msg={msg}
                            participantCount={participantCount}
                            readReceipts={readReceipts}
                            userId={userId}
                        />
                    </div>

                    <MessageToolbar
                        msg={msg}
                        isMine={isMine}
                        onReply={onReply}
                        onReact={onReact}
                        onOpenReactions={() => setShowReactions(true)}
                        onOpenContextMenu={handleContext}
                        onCloseToolbar={() => setToolbarOpen(false)}
                    />
                </div>

                <ReactionBar
                    msg={msg}
                    userId={userId}
                    onReact={onReact}
                />
            </div>

            {ctxMenu && (
                <ContextMenu
                    x={ctxMenu.x}
                    y={ctxMenu.y}
                    items={menuItems}
                    onClose={() => setCtxMenu(null)}
                />
            )}
        </div>
    );
}
