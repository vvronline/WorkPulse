import s from './ReactionPicker.module.css';
import { useRef, useEffect } from 'react';

const EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '👏', '🎉', '👎', '💯'];

export default function ReactionPicker({ onSelect, onClose }) {
    const ref = useRef(null);

    useEffect(() => {
        const handler = (e) => {
            if (ref.current && !ref.current.contains(e.target)) onClose();
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [onClose]);

    return (
        <div ref={ref} className={s.picker}>
            {EMOJIS.map(e => (
                <button key={e} className={s.emoji} onClick={() => { onSelect(e); onClose(); }}>
                    {e}
                </button>
            ))}
        </div>
    );
}
