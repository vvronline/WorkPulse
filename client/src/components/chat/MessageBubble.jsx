import { useState, useCallback, useRef } from 'react';
import s from './MessageBubble.module.css';
import ChatAvatar from './ChatAvatar';
import FilePreview from './FilePreview';
import ReplyPreview from './ReplyPreview';
import ReactionPicker from './ReactionPicker';
import ContextMenu from './ContextMenu';
import CodeBlock from './CodeBlock';
import PollDisplay from './PollDisplay';

/** Parse markdown-style text: **bold**, *italic*, ~~strike~~, `code`, @mentions, URLs */
function renderContent(text, isMine) {
    if (!text) return null;
    const tokens = [];
    // Regex: code blocks, inline code, bold, italic (*word*), strikethrough, mentions, URLs
    const regex = /```(\w*)\n([\s\S]*?)```|`([^`]+)`|\*\*(.+?)\*\*|\*(?!\s)(.+?)(?<!\s)\*|~~(.+?)~~|(@\w[\w\s]*?)(?=\s|$)|(https?:\/\/[^\s<]+)/g;
    let last = 0;
    let match;
    let key = 0;

    while ((match = regex.exec(text)) !== null) {
        if (match.index > last) {
            tokens.push(text.slice(last, match.index));
        }
        if (match[2] !== undefined) {
            // Code block ```lang\ncode```
            tokens.push(<CodeBlock key={key++} language={match[1] || ''} code={match[2]} />);
        } else if (match[3]) {
            tokens.push(<code key={key++} className={s.inlineCode}>{match[3]}</code>);
        } else if (match[4]) {
            tokens.push(<strong key={key++}>{match[4]}</strong>);
        } else if (match[5]) {
            tokens.push(<em key={key++}>{match[5]}</em>);
        } else if (match[6]) {
            tokens.push(<del key={key++}>{match[6]}</del>);
        } else if (match[7]) {
            tokens.push(<span key={key++} className={s.mention}>{match[7]}</span>);
        } else if (match[8]) {
            tokens.push(
                <a key={key++} href={match[8]} target="_blank" rel="noopener noreferrer"
                   className={s.link}>{match[8]}</a>
            );
        }
        last = match.index + match[0].length;
    }
    if (last < text.length) tokens.push(text.slice(last));

    return tokens.length > 0 ? tokens : text;
}

export default function MessageBubble({
    msg, isMine, userId, showAvatar, showName,
    onReply, onEdit, onDelete, onPin, onForward, onReact, onStar,
    participantCount
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

    // Group reactions by emoji
    const reactionGroups = {};
    for (const r of msg.reactions || []) {
        if (!reactionGroups[r.emoji]) reactionGroups[r.emoji] = [];
        reactionGroups[r.emoji].push(r);
    }

    const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮'];

    // Delivery status for own messages
    const deliveryIcon = (() => {
        if (!isMine) return null;
        const delivered = msg.delivered_to || [];
        const others = (participantCount || 2) - 1;
        if (others <= 0) return null;
        if (delivered.length >= others) {
            return <span className={s.deliveryRead} title="Delivered to all">✓✓</span>;
        }
        if (delivered.length > 0) {
            return <span className={s.deliveryPartial} title="Delivered">✓✓</span>;
        }
        return <span className={s.deliverySent} title="Sent">✓</span>;
    })();

    const isPoll = msg.format_type === 'poll' && msg.metadata?.pollId;

    const menuItems = [
        isMine && !msg.file_url && !isPoll && { icon: '✏️', label: 'Edit', onClick: () => onEdit?.(msg) },
        { icon: '📌', label: msg.pinned_at ? 'Unpin' : 'Pin', onClick: () => onPin?.(msg) },
        { icon: msg.starred ? '★' : '☆', label: msg.starred ? 'Unsave' : 'Save', onClick: () => onStar?.(msg) },
        { icon: <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M14 7H7a5 5 0 000 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>, label: 'Forward', onClick: () => onForward?.(msg) },
        isMine && { icon: '🗑️', label: 'Delete', onClick: () => onDelete?.(msg), danger: true },
    ];

    return (
        <div className={`${s.row} ${isMine ? s.mine : s.theirs} ${!showAvatar ? s.grouped : s.groupStart}`}>
            {/* Avatar – always on the left (Teams style) */}
            <div className={s.avatarCol}>
                {showAvatar && <ChatAvatar name={msg.sender_name} avatar={msg.sender_avatar} size="sm" />}
            </div>

            <div className={s.bubbleWrap}>
                {/* Sender name above bubble */}
                {showName && !isMine && msg.sender_name && (
                    <div className={s.senderName}>{msg.sender_name}</div>
                )}
                {showName && isMine && (
                    <div className={`${s.senderName} ${s.mineName}`}>You</div>
                )}

                <div
                    ref={bubbleRef}
                    className={`${s.bubble} ${isMine ? s.myBubble : s.theirBubble} ${msg.pinned_at ? s.pinned : ''} ${msg.starred ? s.starredBubble : ''}`}
                    onContextMenu={handleContext}
                >
                    {msg.pinned_at && <div className={s.pinnedBadge}>📌 Pinned</div>}
                    {msg.starred && <div className={s.starBadge}>⭐</div>}

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

                    {/* Poll display */}
                    {isPoll && <PollDisplay pollId={msg.metadata.pollId} userId={userId} isMine={isMine} />}

                    {/* Text content with rich formatting */}
                    {msg.content && !isPoll && (
                        <div className={s.text}>{renderContent(msg.content, isMine)}</div>
                    )}

                    <div className={s.meta}>
                        <span className={s.time}>
                            {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        {msg.edited_at && <span className={s.edited}>(edited)</span>}
                        {deliveryIcon}
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
                </div>

                {/* Reactions display – outside bubble, left-bottom */}
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
