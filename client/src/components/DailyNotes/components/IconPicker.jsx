/* ─────────────────────────────────────────────────────────
   IconPicker — small emoji-icon popover for page icons.
   Curated list (no external picker dep) plus a "Remove" option.
   ───────────────────────────────────────────────────────── */
import React, { useEffect, useRef, useState } from 'react';
import { useClickOutside } from '../../../hooks/useClickOutside';
import s from './IconPicker.module.css';

const ICON_GROUPS = [
    { label: 'Frequent', icons: ['📝', '📄', '📒', '📓', '📕', '📗', '📘', '📙', '📔', '📚', '📖', '🗒️', '🗂️', '📁', '📂'] },
    { label: 'Symbols', icons: ['⭐', '✨', '💡', '🔥', '🚀', '🎯', '🏆', '🎉', '🌟', '⚡', '💎', '🌈', '☘️', '🍀', '🌸'] },
    { label: 'Work', icons: ['💼', '📊', '📈', '📉', '🗓️', '📅', '🔧', '🔨', '⚙️', '🧰', '📌', '📍', '🔑', '🗝️', '✅'] },
    { label: 'People', icons: ['👤', '👥', '👨‍💻', '👩‍💻', '🤝', '🙋', '🧠', '💬', '💭', '👀', '👋', '🤔', '😀', '😎', '🥳'] },
    { label: 'Misc', icons: ['🌍', '🏠', '🏢', '☕', '🍕', '🎨', '🎵', '🔔', '❤️', '💛', '💚', '💙', '💜', '🖤', '🤍'] },
];

const COVER_COLORS = [
    '', '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#10b981',
    '#14b8a6', '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1', '#8b5cf6',
    '#a855f7', '#d946ef', '#ec4899', '#f43f5e', '#64748b',
];

export default function IconPicker({
    icon, coverColor, onChange, onClose,
}) {
    const ref = useRef(null);
    useClickOutside(ref, onClose, true);

    return (
        <div ref={ref} className={s.popover} role="dialog" aria-label="Page icon">
            <div className={s.section}>
                <div className={s.sectionLabel}>Icon</div>
                <div className={s.iconRow}>
                    <button
                        type="button"
                        className={s.removeBtn}
                        onClick={() => onChange?.({ icon: '', coverColor })}
                        title="Remove icon"
                    >Remove</button>
                </div>
                {ICON_GROUPS.map(g => (
                    <div key={g.label} className={s.group}>
                        <div className={s.groupLabel}>{g.label}</div>
                        <div className={s.grid}>
                            {g.icons.map(i => (
                                <button
                                    type="button"
                                    key={i}
                                    className={`${s.iconBtn} ${i === icon ? s.iconBtnActive : ''}`}
                                    onClick={() => onChange?.({ icon: i, coverColor })}
                                    aria-label={`Use icon ${i}`}
                                >
                                    {i}
                                </button>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
            <div className={s.section}>
                <div className={s.sectionLabel}>Cover colour</div>
                <div className={s.colorRow}>
                    {COVER_COLORS.map(c => (
                        <button
                            type="button"
                            key={c || 'none'}
                            className={`${s.colorBtn} ${c === coverColor ? s.colorBtnActive : ''}`}
                            style={c ? { background: c } : undefined}
                            onClick={() => onChange?.({ icon, coverColor: c })}
                            aria-label={c ? `Cover colour ${c}` : 'No cover'}
                            title={c || 'No cover'}
                        >{!c && '×'}</button>
                    ))}
                </div>
            </div>
        </div>
    );
}