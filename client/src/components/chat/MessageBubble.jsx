import { useState, useCallback, useRef } from 'react';
import s from './MessageBubble.module.css';
import ChatAvatar from './ChatAvatar';
import FilePreview from './FilePreview';
import ReplyPreview from './ReplyPreview';
import ReactionPicker from './ReactionPicker';
import ContextMenu from './ContextMenu';

function linkify(text) {
    if (!text) return text;
    const urlRegex = /(https?:\/\/[^\s<]+)/g;
    const parts = text.split(urlRegex);
    return parts.map((part, i) =>
        urlRegex.test(part)
            ? <a key={i} href={part} target="_blank" rel="noopener noreferrer" className={s.link}>{part}</a>
            : part
    );
}

export default function MessageBubble({
    msg, isMine, userId, showAvatar, showName,
    onReply, onEdit, onDelete, onPin, onForward, onReact
}) {
    const [showReactions, setShowReactions] = useState(false);
    const [ctxMenu, setCtxMenu] = useState(null);
    const bubbleRef = useRef(null);

    const handleContext = useCallback((e) => {
        e.preventDefault();
        setCtxMenu({ x: e.clientX, y: e.clientY });
    }, []);

    if (msg.deleted_at) {
        return (
            <div className={`${s.row} ${isMine ? s.mine : s.theirs} ${!showAvatar ? s.grouped : ''}`}>
                {!isMine && <div className={s.avatarCol}>{showAvatar && <ChatAvatar name={msg.sender_name} avatar={msg.sender_avatar} size="sm" />}</div>}
                <div className={`${s.bubble} ${s.deleted}`}>
                    <em>This message was deleted</em>
                </div>
                {isMine && <div className={s.avatarCol}>{showAvatar && <ChatAvatar name={msg.sender_name} avatar={msg.sender_avatar} size="sm" />}</div>}
            </div>
        );
    }

    // Group reactions by emoji
    const reactionGroups = {};
    for (const r of msg.reactions || []) {
        if (!reactionGroups[r.emoji]) reactionGroups[r.emoji] = [];
        reactionGroups[r.emoji].push(r);
    }

    const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮'];

    const menuItems = [
        isMine && !msg.file_url && { icon: '✏️', label: 'Edit', onClick: () => onEdit?.(msg) },
        { icon: '📌', label: msg.pinned_at ? 'Unpin' : 'Pin', onClick: () => onPin?.(msg) },
        { icon: <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M14 7H7a5 5 0 000 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>, label: 'Forward', onClick: () => onForward?.(msg) },
        isMine && { icon: '🗑️', label: 'Delete', onClick: () => onDelete?.(msg), danger: true },
    ];

    return (
        <div className={`${s.row} ${isMine ? s.mine : s.theirs} ${!showAvatar ? s.grouped : ''}`}>
            {/* Avatar column – left for theirs */}
            {!isMine && (
                <div className={s.avatarCol}>
                    {showAvatar && <ChatAvatar name={msg.sender_name} avatar={msg.sender_avatar} size="sm" />}
                </div>
            )}

            <div className={s.bubbleWrap}>
                {/* Sender name above bubble – Teams shows it for first msg in a group */}
                {showName && !isMine && msg.sender_name && (
                    <div className={s.senderName}>{msg.sender_name}</div>
                )}
                {showName && isMine && (
                    <div className={`${s.senderName} ${s.mineName}`}>You</div>
                )}

                <div
                    ref={bubbleRef}
                    className={`${s.bubble} ${isMine ? s.myBubble : s.theirBubble} ${msg.pinned_at ? s.pinned : ''}`}
                    onContextMenu={handleContext}
                >
                    {msg.pinned_at && <div className={s.pinnedBadge}>📌 Pinned</div>}

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

                    {msg.content && <div className={s.text}>{linkify(msg.content)}</div>}

                    <div className={s.meta}>
                        <span className={s.time}>
                            {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        {msg.edited_at && <span className={s.edited}>(edited)</span>}
                    </div>

                    {/* Hover toolbar – Teams style */}
                    <div className={s.hoverActions}>
                        <div className={s.quickReactions}>
                            {QUICK_EMOJIS.map(emoji => (
                                <button key={emoji} className={s.quickEmoji} onClick={() => onReact?.(msg.id, emoji)} title={emoji}>
                                    {emoji}
                                </button>
                            ))}
                            <button className={s.moreEmoji} onClick={() => setShowReactions(true)} title="More reactions">
                                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.3"/><circle cx="5.2" cy="6.5" r="0.9" fill="currentColor"/><circle cx="10.8" cy="6.5" r="0.9" fill="currentColor"/><path d="M5 10a3.5 3.5 0 006 0" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
                            </button>
                        </div>
                        <div className={s.toolbarDivider} />
                        <button className={s.toolbarBtn} onClick={() => onReply?.(msg)} title="Reply">
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 3L2 7l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M2 7h7a5 5 0 010 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                        </button>
                        <button className={s.toolbarBtn} onClick={handleContext} title="More options">
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="4" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="12" cy="8" r="1.2" fill="currentColor"/></svg>
                        </button>
                    </div>

                    {/* Reactions display */}
                    {Object.keys(reactionGroups).length > 0 && (
                        <div className={s.reactions}>
                            {Object.entries(reactionGroups).map(([emoji, users]) => (
                                <button
                                    key={emoji}
                                    className={`${s.reactionChip} ${users.some(u => u.userId === userId) ? s.myReaction : ''}`}
                                    onClick={() => onReact?.(msg.id, emoji)}
                                    title={users.map(u => u.fullName).join(', ')}
                                >
                                    {emoji} {users.length}
                                </button>
                            ))}
                        </div>
                    )}

                    {/* Reaction picker popup */}
                    {showReactions && (
                        <div className={s.pickerWrap}>
                            <ReactionPicker
                                onSelect={(emoji) => onReact?.(msg.id, emoji)}
                                onClose={() => setShowReactions(false)}
                            />
                        </div>
                    )}
                </div>
            </div>

            {/* Avatar column – right for mine */}
            {isMine && (
                <div className={s.avatarCol}>
                    {showAvatar && <ChatAvatar name={msg.sender_name} avatar={msg.sender_avatar} size="sm" />}
                </div>
            )}

            {/* Context menu */}
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
