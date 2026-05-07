/* ─────────────────────────────────────────────────────────
   ReactionsBar — emoji reactions on a page.
   Stores `page.reactions = { '👍': [userId, ...], ... }`.
   Click toggles the current user's reaction.
   ───────────────────────────────────────────────────────── */
import React, { useState, useRef } from 'react';
import { Smile } from '../../../constants/icons';
import { useClickOutside } from '../../../hooks/useClickOutside';
import s from './ReactionsBar.module.css';

const QUICK_REACTIONS = ['👍', '🎉', '❤️', '👀', '🚀', '🔥', '✅', '❓', '💡', '😄'];

export default function ReactionsBar({ reactions, currentUserId, onToggle }) {
    const [pickerOpen, setPickerOpen] = useState(false);
    const ref = useRef(null);
    useClickOutside(ref, () => setPickerOpen(false), pickerOpen);

    const entries = Object.entries(reactions || {})
        .filter(([, ids]) => Array.isArray(ids) && ids.length > 0);

    const handleToggle = (emoji) => {
        onToggle?.(emoji);
        setPickerOpen(false);
    };

    return (
        <div className={s.bar} aria-label="Reactions">
            {entries.map(([emoji, ids]) => {
                const mine = ids.includes(currentUserId);
                return (
                    <button
                        key={emoji}
                        type="button"
                        className={`${s.chip} ${mine ? s.chipActive : ''}`}
                        onClick={() => handleToggle(emoji)}
                        title={mine ? 'Remove your reaction' : 'Add reaction'}
                    >
                        <span className={s.chipEmoji}>{emoji}</span>
                        <span className={s.chipCount}>{ids.length}</span>
                    </button>
                );
            })}
            <div ref={ref} className={s.pickerWrap}>
                <button
                    type="button"
                    className={s.addBtn}
                    onClick={() => setPickerOpen(o => !o)}
                    title="Add reaction"
                    aria-label="Add reaction"
                >
                    <Smile size={14} />
                    {entries.length === 0 && <span className={s.addLabel}>React</span>}
                </button>
                {pickerOpen && (
                    <div className={s.picker} role="menu">
                        {QUICK_REACTIONS.map(e => (
                            <button
                                key={e}
                                type="button"
                                className={s.pickerEmoji}
                                onClick={() => handleToggle(e)}
                                title={e}
                            >{e}</button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}