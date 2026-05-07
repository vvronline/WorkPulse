/* ─────────────────────────────────────────────────────────
   PageLinkPicker — floating page picker popover.
   Opened by the slash-menu "Link to page" command. Filters
   pages live; Enter inserts a `pagelink` formatted span at
   the saved range; Escape closes.
   ───────────────────────────────────────────────────────── */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileText, Search, Plus } from '../../../constants/icons';
import s from './PageLinkPicker.module.css';

export default function PageLinkPicker({ pages, position, onPick, onCreate, onClose }) {
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(0);
    const inputRef = useRef(null);

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        const list = (pages || []).filter(p => !p.archived);
        if (!q) return list.slice(0, 12);
        return list
            .filter(p => (p.title || '').toLowerCase().includes(q))
            .slice(0, 12);
    }, [pages, query]);

    useEffect(() => { setActive(0); }, [query]);
    useEffect(() => { setTimeout(() => inputRef.current?.focus(), 30); }, []);

    const onKey = (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(i + 1, filtered.length)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)); }
        else if (e.key === 'Enter') {
            e.preventDefault();
            if (active < filtered.length) {
                onPick(filtered[active]);
            } else if (query.trim() && onCreate) {
                onCreate(query.trim());
            }
        } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
        }
    };

    const showCreate = query.trim().length > 0
        && !filtered.some(p => p.title?.toLowerCase() === query.trim().toLowerCase());

    const style = position
        ? { top: position.top, left: position.left }
        : { top: '30%', left: '50%', transform: 'translateX(-50%)' };

    return createPortal(
        <div
            className={s.popover}
            style={style}
            role="dialog"
            aria-label="Link to page"
            onMouseDown={e => e.stopPropagation()}
        >
            <div className={s.inputWrap}>
                <Search size={14} className={s.searchIcon} aria-hidden="true" />
                <input
                    ref={inputRef}
                    className={s.input}
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    onKeyDown={onKey}
                    placeholder="Search or create page…"
                    aria-label="Search pages to link"
                />
            </div>
            <div className={s.list} role="listbox">
                {filtered.length === 0 && !showCreate && (
                    <div className={s.empty}>No pages found</div>
                )}
                {filtered.map((p, idx) => (
                    <button
                        type="button"
                        key={p.id}
                        className={`${s.row} ${idx === active ? s.rowActive : ''}`}
                        onMouseEnter={() => setActive(idx)}
                        onMouseDown={(e) => { e.preventDefault(); onPick(p); }}
                        role="option"
                        aria-selected={idx === active}
                    >
                        {p.icon
                            ? <span className={s.icon}>{p.icon}</span>
                            : <FileText size={13} className={s.icon} />}
                        <span className={s.title}>{p.title || 'Untitled'}</span>
                    </button>
                ))}
                {showCreate && onCreate && (
                    <button
                        type="button"
                        className={`${s.row} ${s.rowCreate} ${active === filtered.length ? s.rowActive : ''}`}
                        onMouseEnter={() => setActive(filtered.length)}
                        onMouseDown={(e) => { e.preventDefault(); onCreate(query.trim()); }}
                    >
                        <Plus size={13} className={s.icon} />
                        <span className={s.title}>Create &ldquo;{query.trim()}&rdquo;</span>
                    </button>
                )}
            </div>
            <div className={s.footer}>
                <kbd>↑</kbd><kbd>↓</kbd> navigate · <kbd>↵</kbd> select · <kbd>Esc</kbd> close
            </div>
        </div>,
        document.body
    );
}