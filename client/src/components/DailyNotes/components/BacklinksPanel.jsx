/* ─────────────────────────────────────────────────────────
   BacklinksPanel — bottom-of-page list of pages that link
   to the active page. Computed client-side from rendered
   HTML (see getBacklinks in notesUtils).
   ───────────────────────────────────────────────────────── */
import React, { useMemo } from 'react';
import { Link2, FileText } from '../../../constants/icons';
import { getBacklinks, formatDate } from '../notesUtils';
import s from './BacklinksPanel.module.css';

export default function BacklinksPanel({ activePage, pages, onSelectPage }) {
    const backlinks = useMemo(
        () => activePage ? getBacklinks(activePage.id, pages) : [],
        [activePage, pages]
    );
    if (!activePage) return null;
    if (backlinks.length === 0) return null;

    return (
        <section className={s.panel} aria-label="Backlinks">
            <header className={s.header}>
                <Link2 size={13} className={s.icon} aria-hidden="true" />
                <span className={s.title}>
                    Linked from {backlinks.length} {backlinks.length === 1 ? 'page' : 'pages'}
                </span>
            </header>
            <ul className={s.list}>
                {backlinks.map(p => (
                    <li key={p.id}>
                        <button
                            type="button"
                            className={s.row}
                            onClick={() => onSelectPage?.(p.id)}
                            title={`Open ${p.title}`}
                        >
                            {p.icon
                                ? <span className={s.rowIcon}>{p.icon}</span>
                                : <FileText size={13} className={s.rowIcon} aria-hidden="true" />}
                            <span className={s.rowTitle}>{p.title || 'Untitled'}</span>
                            <span className={s.rowDate}>{formatDate(p.updatedAt)}</span>
                        </button>
                    </li>
                ))}
            </ul>
        </section>
    );
}