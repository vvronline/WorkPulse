import { useState, useCallback, useRef } from 'react';
import s from './MessageBubble.module.css';
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
    msg, isMine, userId,
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
            <div className={`${s.row} ${isMine ? s.mine : s.theirs}`}>
                <div className={`${s.bubble} ${s.deleted}`}>
                    <em>This message was deleted</em>
                </div>
            </div>
        );
    }

    // Group reactions by emoji
    const reactionGroups = {};
    for (const r of msg.reactions || []) {
        if (!reactionGroups[r.emoji]) reactionGroups[r.emoji] = [];
        reactionGroups[r.emoji].push(r);
    }

    const menuItems = [
        { icon: '↩️', label: 'Reply', onClick: () => onReply?.(msg) },
        onReact && { icon: '😀', label: 'React', onClick: () => setShowReactions(true) },
        isMine && !msg.file_url && { icon: '✏️', label: 'Edit', onClick: () => onEdit?.(msg) },
        { icon: '📌', label: msg.pinned_at ? 'Unpin' : 'Pin', onClick: () => onPin?.(msg) },
        { icon: '↗️', label: 'Forward', onClick: () => onForward?.(msg) },
        isMine && { icon: '🗑️', label: 'Delete', onClick: () => onDelete?.(msg), danger: true },
    ];

    return (
        <div className={`${s.row} ${isMine ? s.mine : s.theirs}`}>
            <div
                ref={bubbleRef}
                className={`${s.bubble} ${isMine ? s.myBubble : s.theirBubble} ${msg.pinned_at ? s.pinned : ''}`}
                onContextMenu={handleContext}
            >
                {msg.pinned_at && <div className={s.pinnedBadge}>📌 Pinned</div>}

                {msg.forwarded_from_id && (
                    <div className={s.forwarded}>↗️ Forwarded</div>
                )}

                {!isMine && msg.sender_name && (
                    <div className={s.senderName}>{msg.sender_name}</div>
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

                {/* Hover actions */}
                <div className={s.hoverActions}>
                    <button onClick={() => setShowReactions(true)} title="React">😀</button>
                    <button onClick={() => onReply?.(msg)} title="Reply">↩️</button>
                    <button onClick={handleContext} title="More">⋯</button>
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
