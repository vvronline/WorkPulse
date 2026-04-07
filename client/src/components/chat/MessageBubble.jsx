import { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
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
import EmojiGifPicker from './EmojiGifPicker';

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

    const touchStartRef = useRef(null);

    const handleTouchStart = useCallback((e) => {
        touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, time: Date.now() };
    }, []);

    const handleTouchEnd = useCallback((e) => {
        if (!touchStartRef.current) return;
        const dx = Math.abs(e.changedTouches[0].clientX - touchStartRef.current.x);
        const dy = Math.abs(e.changedTouches[0].clientY - touchStartRef.current.y);
        const dt = Date.now() - touchStartRef.current.time;
        touchStartRef.current = null;
        // Ignore if it was a scroll gesture or long press
        if (dx > 10 || dy > 10 || dt > 500) return;
        if (e.target.closest && (
            e.target.closest('[data-toolbar]') ||
            e.target.closest('[data-picker]') ||
            e.target.closest('[data-reaction]') ||
            e.target.closest('a')
        )) return;
        e.preventDefault();
        setToolbarOpen(t => !t);
    }, []);

    useEffect(() => {
        if (!toolbarOpen) return;
        const handler = (e) => {
            if (rowRef.current && !rowRef.current.contains(e.target)) {
                setToolbarOpen(false);
            }
        };
        document.addEventListener('pointerdown', handler);
        return () => document.removeEventListener('pointerdown', handler);
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
                    onTouchStart={handleTouchStart}
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
                        onOpenReactions={() => { setShowReactions(true); setToolbarOpen(false); }}
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

            {showReactions && createPortal(
                <EmojiGifPicker
                    onSelectEmoji={(emoji) => { onReact?.(msg.id, emoji); setShowReactions(false); }}
                    onClose={() => setShowReactions(false)}
                    style={(() => {
                        const isMobile = window.innerWidth <= 480;
                        const rect = bubbleRef.current?.getBoundingClientRect();
                        if (!rect || isMobile) {
                            return { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 10000 };
                        }
                        const pickerWidth = Math.min(340, window.innerWidth - 16);
                        const pickerHeight = Math.min(400, window.innerHeight - 16);
                        let left = isMine ? rect.right - pickerWidth : rect.left;
                        left = Math.max(8, Math.min(left, window.innerWidth - pickerWidth - 8));
                        let top = rect.top - pickerHeight - 8;
                        if (top < 8) top = rect.bottom + 4;
                        if (top + pickerHeight > window.innerHeight - 8) top = window.innerHeight - pickerHeight - 8;
                        return { position: 'fixed', top: `${top}px`, left: `${left}px`, bottom: 'auto', right: 'auto', marginBottom: 0, zIndex: 10000 };
                    })()}
                />,
                document.body
            )}

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
