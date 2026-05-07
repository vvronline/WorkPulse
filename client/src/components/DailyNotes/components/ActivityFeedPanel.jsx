/* ─────────────────────────────────────────────────────────
   ActivityFeedPanel — chronological feed of recent edits
   across all pages, grouped by day. Uses notesAi.generateActivityFeed.
   Renders inside a portal as a slide-in side sheet.
   ───────────────────────────────────────────────────────── */
import React, { useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Clock, X, FileText, Sparkles } from '../../../constants/icons';
import { generateActivityFeed } from '../notesAi';
import s from './ActivityFeedPanel.module.css';

function fmtDay(iso) {
    const today = new Date();
    const todayKey = today.toISOString().slice(0, 10);
    const y = new Date(today.getTime() - 86400000).toISOString().slice(0, 10);
    if (iso === todayKey) return 'Today';
    if (iso === y) return 'Yesterday';
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString(undefined, {
        weekday: 'long', month: 'short', day: 'numeric',
    });
}

function fmtTime(iso) {
    return new Date(iso).toLocaleTimeString(undefined, {
        hour: '2-digit', minute: '2-digit',
    });
}

export default function ActivityFeedPanel({ pages, onSelectPage, onClose }) {
    const feed = useMemo(() => generateActivityFeed(pages, 14), [pages]);

    return createPortal(
        <div className={s.overlay} onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
            <aside className={s.sheet} aria-label="Activity feed">
                <div className={s.header}>
                    <span className={s.title}>
                        <Clock size={14} /> Activity feed
                    </span>
                    <button className={s.iconBtn} onClick={onClose} aria-label="Close" title="Close">
                        <X size={14} />
                    </button>
                </div>

                <div className={s.body}>
                    {feed.length === 0 ? (
                        <div className={s.empty}>
                            <Sparkles size={28} strokeWidth={1.5} />
                            <p>No edits in the last 14 days.</p>
                        </div>
                    ) : (
                        feed.map(group => (
                            <div key={group.day} className={s.dayGroup}>
                                <div className={s.dayHeader}>{fmtDay(group.day)}</div>
                                <ol className={s.timeline}>
                                    {group.items.map(it => (
                                        <li key={`${it.id}-${it.updatedAt}`} className={s.timelineItem}>
                                            <div className={s.bullet}>
                                                <span className={`${s.bulletDot} ${it.isNew ? s.bulletDotNew : ''}`} />
                                            </div>
                                            <button
                                                className={s.event}
                                                onClick={() => onSelectPage?.(it.id)}
                                            >
                                                <span className={s.eventTime}>{fmtTime(it.updatedAt)}</span>
                                                <span className={s.eventBody}>
                                                    <FileText size={12} className={s.eventIcon} />
                                                    <span className={s.eventTitle}>{it.title}</span>
                                                    {it.isNew && (
                                                        <span className={s.eventBadge}>New</span>
                                                    )}
                                                </span>
                                            </button>
                                        </li>
                                    ))}
                                </ol>
                            </div>
                        ))
                    )}
                </div>
            </aside>
        </div>,
        document.body,
    );
}