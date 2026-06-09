/* eslint-disable @typescript-eslint/no-explicit-any */
/* ─────────────────────────────────────────────────────────
   SubPagesPanel — list of direct children of the current page.
   Rendered above the BacklinksPanel inside the editor.
   ───────────────────────────────────────────────────────── */
import React, { useMemo } from "react";
import { ChevronsRight, FileText, Plus } from "../../../constants/icons";
import { formatDate, stripHtml } from "../notesUtils";
import s from "./SubPagesPanel.module.css";

function snippet(html?: string, max = 80): string {
    const t = stripHtml(html || "").trim();
    return t.length > max ? t.slice(0, max).trim() + "…" : t;
}

interface SubPagesPanelProps {
    activePage?: any;
    pages: any[];
    onSelectPage?: (id: any) => void;
    onAddChild?: (id: any) => void;
}

export default function SubPagesPanel({ activePage, pages, onSelectPage, onAddChild }: SubPagesPanelProps) {
    const children = useMemo(() => {
        if (!activePage) return [];
        return pages
            .filter(p => p.parentPageId === activePage.id && !p.archived)
            .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    }, [activePage, pages]);

    if (!activePage) return null;

    return (
        <section className={s.panel} aria-label="Sub-pages">
            <header className={s.header}>
                <ChevronsRight size={13} className={s.icon} aria-hidden="true" />
                <span className={s.title}>
                    Sub-pages {children.length > 0 && `(${children.length})`}
                </span>
                <button
                    type="button"
                    className={s.addBtn}
                    onClick={() => onAddChild?.(activePage.id)}
                    title="Add sub-page"
                >
                    <Plus size={12} />
                    Add
                </button>
            </header>
            {children.length === 0 ? (
                <p className={s.empty}>No sub-pages yet. Add one to organise related notes underneath this page.</p>
            ) : (
                <ul className={s.list}>
                    {children.map(c => (
                        <li key={c.id}>
                            <button
                                type="button"
                                className={s.row}
                                onClick={() => onSelectPage?.(c.id)}
                                title={c.title}
                            >
                                {c.icon
                                    ? <span className={s.rowIcon}>{c.icon}</span>
                                    : <FileText size={13} className={s.rowIcon} aria-hidden="true" />}
                                <span className={s.rowBody}>
                                    <span className={s.rowTitle}>{c.title || "Untitled"}</span>
                                    {snippet(c.content) && (
                                        <span className={s.rowSnippet}>{snippet(c.content)}</span>
                                    )}
                                </span>
                                <span className={s.rowDate}>{formatDate(c.updatedAt)}</span>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}