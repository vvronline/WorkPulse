import s from './ContextMenu.module.css';
import { useEffect, useRef } from 'react';

export default function ContextMenu({ x, y, items, onClose }) {
    const ref = useRef(null);

    useEffect(() => {
        const handler = (e) => {
            if (ref.current && !ref.current.contains(e.target)) onClose();
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [onClose]);

    // Adjust position to stay within viewport
    useEffect(() => {
        if (!ref.current) return;
        const rect = ref.current.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            ref.current.style.left = `${x - rect.width}px`;
        }
        if (rect.bottom > window.innerHeight) {
            ref.current.style.top = `${y - rect.height}px`;
        }
    }, [x, y]);

    return (
        <div ref={ref} className={s.menu} style={{ left: x, top: y }}>
            {items.filter(Boolean).map((item, i) => (
                <button
                    key={i}
                    className={`${s.item} ${item.danger ? s.danger : ''}`}
                    onClick={() => { item.onClick(); onClose(); }}
                >
                    <span className={s.icon}>{item.icon}</span>
                    {item.label}
                </button>
            ))}
        </div>
    );
}
