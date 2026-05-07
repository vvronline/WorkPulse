/* ─────────────────────────────────────────────────────────
   SmartSuggestionsPanel — floating chat-style window with
   client-side suggestions:
     • Related pages (token-overlap similarity)
     • Pages with pending action items
     • Stale pages (not edited in N days)

   Rendered via createPortal in the bottom-right corner with
   a close icon, matching the AI assist window UX.
   ───────────────────────────────────────────────────────── */
import React, { useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
    Sparkles, X, Link2, AlertCircle, CheckSquare, FileText,
} from '../../../constants/icons';
import { findRelatedPages, findStalePages, extractActionItems } from '../notesAi';
import { formatDate } from '../notesUtils';
import s from './SmartSuggestionsPanel.module.css';

export default function SmartSuggestionsPanel({
    activePage,
    pages,
    onSelectPage,
    onClose,
}) {
    /* Esc to close */
    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    const related = useMemo(
        () => activePage ? findRelatedPages(activePage, pages, 5) : [],
        [activePage, pages],
    );

    const stale = useMemo(
        () => findStalePages(pages, 21, 5),
        [pages],
    );

    /* Pages with at least one open action item */
    const withOpenActions = useMemo(() => {
        if (!Array.isArray(pages)) return [];
        return pages
            .filter(p => !p.archived)
            .map(p => {
                const items = extractActionItems(p.content || '');
                const open = items.filter(it => !it.done).length;
                return { page: p, openCount: open };
            })
            .filter(x => x.openCount > 0)
            .sort((a, b) => b.openCount - a.openCount)
            .slice(0, 5);
    }, [pages]);

    const Section = ({ title, icon: Icon, empty, children }) => (
        <section className={s.section}>
            <h3 className={s.sectionTitle}>
                <Icon size={12} /> {title}
            </h3>
            {empty ? <p className={s.empty}>{empty}</p> : children}
        </section>
    );

    return createPortal(
        <div className={s.window} role="dialog" aria-label="Smart suggestions">
            <div className={s.header}>
                <div className={s.titleWrap}>
                    <span className={s.headerTitle}>
                        <Sparkles size={14} /> Smart suggestions
                    </span>
                    <span className={s.subtitle}>
                        Related notes & open work
                    </span>
                </div>
                <button className={s.closeBtn} onClick={onClose} aria-label="Close" title="Close (Esc)">
                    <X size={15} />
                </button>
            </div>

            <div className={s.body}>
                <Section
                    title="Related to this page"
                    icon={Link2}
                    empty={!activePage
                        ? 'Open a page to see related notes.'
                        : related.length === 0
                            ? 'Nothing related yet — add tags or write more content.'
                            : null}
                >
                    {related.length > 0 && (
                        <ul className={s.list}>
                            {related.map(r => (
                                <li key={r.page.id}>
                                    <button
                                        className={s.row}
                                        onClick={() => onSelectPage?.(r.page.id)}
                                        title={`Similarity score ${(r.score * 100).toFixed(0)}%`}
                                    >
                                        <FileText size={12} className={s.rowIcon} />
                                        <span className={s.rowTitle}>
                                            {r.page.title || 'Untitled'}
                                        </span>
                                        <span className={s.rowMeta}>
                                            {Math.round(r.score * 100)}%
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </Section>

                <Section
                    title="Pages with open actions"
                    icon={CheckSquare}
                    empty={withOpenActions.length === 0
                        ? 'No pending checklist items in any page.'
                        : null}
                >
                    {withOpenActions.length > 0 && (
                        <ul className={s.list}>
                            {withOpenActions.map(({ page, openCount }) => (
                                <li key={page.id}>
                                    <button
                                        className={s.row}
                                        onClick={() => onSelectPage?.(page.id)}
                                    >
                                        <CheckSquare size={12} className={s.rowIcon} />
                                        <span className={s.rowTitle}>
                                            {page.title || 'Untitled'}
                                        </span>
                                        <span className={`${s.rowMeta} ${s.rowMetaWarn}`}>
                                            {openCount} open
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </Section>

                <Section
                    title="Haven't been touched in 3+ weeks"
                    icon={AlertCircle}
                    empty={stale.length === 0 ? 'Everything is fresh — nice!' : null}
                >
                    {stale.length > 0 && (
                        <ul className={s.list}>
                            {stale.map(p => (
                                <li key={p.id}>
                                    <button
                                        className={s.row}
                                        onClick={() => onSelectPage?.(p.id)}
                                    >
                                        <FileText size={12} className={s.rowIcon} />
                                        <span className={s.rowTitle}>
                                            {p.title || 'Untitled'}
                                        </span>
                                        <span className={s.rowMeta}>
                                            {formatDate(p.updatedAt)}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </Section>
            </div>
        </div>,
        document.body,
    );
}