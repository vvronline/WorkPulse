import { useState } from 'react';
import ReactionPicker from './ReactionPicker';
import EmojiGifPicker from './EmojiGifPicker';
import s from './MessageBubble.module.css';

export default function ReactionBar({ msg, userId, onReact }) {
    const [showReactions, setShowReactions] = useState(false);
    const [showFullPicker, setShowFullPicker] = useState(false);

    // Group reactions by emoji
    const reactionGroups = {};
    for (const r of msg.reactions || []) {
        if (!reactionGroups[r.emoji]) reactionGroups[r.emoji] = [];
        reactionGroups[r.emoji].push(r);
    }

    if (Object.keys(reactionGroups).length === 0 && !showReactions && !showFullPicker) return null;

    return (
        <>
            {Object.keys(reactionGroups).length > 0 && (
                <div className={s.reactions} data-reaction>
                    {Object.entries(reactionGroups).map(([emoji, users]) => (
                        <button
                            key={emoji}
                            className={`${s.reactionChip} ${users.some(u => u.userId === userId) ? s.myReaction : ''}`}
                            onClick={() => onReact?.(msg.id, emoji)}
                            title={users.map(u => u.fullName).join(', ')}
                        >
                            <span className={s.reactionEmoji}>{emoji}</span>
                            <span className={s.reactionCount}>{users.length}</span>
                        </button>
                    ))}
                    <button
                        className={s.addReactionBtn}
                        onClick={() => setShowFullPicker(p => !p)}
                        title="Add reaction"
                    >
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                    </button>
                </div>
            )}

            {showReactions && (
                <div className={s.pickerWrap} data-picker>
                    <ReactionPicker
                        onSelect={(emoji) => { onReact?.(msg.id, emoji); setShowReactions(false); }}
                        onClose={() => setShowReactions(false)}
                        onOpenFull={() => { setShowReactions(false); setShowFullPicker(true); }}
                    />
                </div>
            )}

            {showFullPicker && (
                <div className={s.pickerWrap} data-picker>
                    <EmojiGifPicker
                        onSelectEmoji={(emoji) => onReact?.(msg.id, emoji)}
                        onClose={() => setShowFullPicker(false)}
                    />
                </div>
            )}
        </>
    );
}
