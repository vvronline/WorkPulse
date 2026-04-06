import s from './ReactionPicker.module.css';
import { useRef, useEffect } from 'react';

const EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '👏', '🎉', '👎', '💯'];

export default function ReactionPicker({ onSelect, onClose, onOpenFull, style }) {
    const ref = useRef(null);

    useEffect(() => {
        const handler = (e) => {
            if (ref.current && !ref.current.contains(e.target)) onClose();
        };
        // Defer listener so the tap/click that opened the picker doesn't immediately close it
        const timerId = setTimeout(() => {
            document.addEventListener('pointerdown', handler);
        }, 80);
        return () => {
            clearTimeout(timerId);
            document.removeEventListener('pointerdown', handler);
        };
    }, [onClose]);

    return (
        <div ref={ref} className={s.picker} style={style}>
            <div className={s.emojiRow}>
                {EMOJIS.map(e => (
                    <button key={e} className={s.emoji} onClick={() => { onSelect(e); onClose(); }}>
                        {e}
                    </button>
                ))}
            </div>
            {onOpenFull && (
                <button className={s.openFull} onClick={() => { onClose(); onOpenFull(); }} title="Browse all emoji">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.3"/><circle cx="5.2" cy="6.5" r="0.8" fill="currentColor"/><circle cx="10.8" cy="6.5" r="0.8" fill="currentColor"/><path d="M5 10a3.5 3.5 0 006 0" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/></svg>
                    <span>All Emoji</span>
                </button>
            )}
        </div>
    );
}
