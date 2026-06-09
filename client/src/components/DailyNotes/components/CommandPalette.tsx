/* eslint-disable @typescript-eslint/no-explicit-any */
/* ─────────────────────────────────────────────────────────
   CommandPalette — Ctrl+K fuzzy search across pages + actions.
   Replaces sidebar discoverability with a keyboard-first UI.
   ───────────────────────────────────────────────────────── */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TEMPLATES } from "../templates";
import { formatDate } from "../notesUtils";
import {
    Search,
    Home,
    Plus,
    BookMarked,
    Inbox,
    Pin,
    Archive,
    FileText,
} from "../../../constants/icons";
import s from "./CommandPalette.module.css";

interface FuzzyResult {
    score: number;
    indices: number[];
}

/* ── Fuzzy match: returns score + character indices, or null if no match ── */
function fuzzyMatch(query: string, target: string): FuzzyResult | null {
    if (!query) return { score: 0, indices: [] };
    const q = query.toLowerCase();
    const t = (target || "").toLowerCase();
    let qi = 0, ti = 0;
    let score = 0;
    let prevMatched = false;
    const indices: number[] = [];
    while (qi < q.length && ti < t.length) {
        if (q[qi] === t[ti]) {
            indices.push(ti);
            score += prevMatched ? 5 : 1;          // bonus for consecutive
            if (ti === 0 || t[ti - 1] === " " || t[ti - 1] === "-") score += 3; // word start
            prevMatched = true;
            qi++;
        } else {
            prevMatched = false;
        }
        ti++;
    }
    return qi === q.length ? { score, indices } : null;
}

function highlight(text: string, indices: number[]): React.ReactNode {
    if (!indices || indices.length === 0) return text;
    const out: React.ReactNode[] = [];
    let last = 0;
    indices.forEach((i, k) => {
        if (i > last) out.push(<span key={`p${k}`}>{text.slice(last, i)}</span>);
        out.push(<mark key={`m${k}`} className={s.mark}>{text[i]}</mark>);
        last = i + 1;
    });
    if (last < text.length) out.push(<span key="end">{text.slice(last)}</span>);
    return out;
}

interface CommandPaletteProps {
    store: any;
    onClose: () => void;
}

interface PaletteItem {
    kind: "page" | "action";
    id: string;
    label: string;
    meta: string;
    icon: any;
    run: () => void;
    score?: number;
    indices?: number[];
}

export default function CommandPalette({ store, onClose }: CommandPaletteProps) {
    const {
        pages,
        openEditor, openHome, handleNewPage,
        handleNewFromTemplate, handleOpenTodayJournal,
        setSwitcherOpen,
        handleTogglePin, handleToggleArchive,
        activePageId,
    } = store;

    const [query, setQuery] = useState("");
    const [active, setActive] = useState(0);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);

    /* ── Action registry ── */
    const actions = useMemo(() => ([
        {
            id: "home",
            label: "Go to home",
            hint: "Ctrl+H",
            icon: Home,
            run: () => { openHome(); onClose(); },
        },
        {
            id: "new-page",
            label: "New page",
            hint: "Ctrl+N",
            icon: Plus,
            run: () => { handleNewPage(); onClose(); },
        },
        {
            id: "today-journal",
            label: "Open today's journal",
            icon: BookMarked,
            run: () => { handleOpenTodayJournal(); onClose(); },
        },
        {
            id: "switcher",
            label: "Open page switcher",
            hint: "Ctrl+Shift+O",
            icon: Inbox,
            run: () => { setSwitcherOpen(true); onClose(); },
        },
        ...TEMPLATES
            .filter((t: any) => t.id !== "blank" && t.id !== "journal")
            .map((t: any) => ({
                id: `tpl-${t.id}`,
                label: `New from template: ${t.name}`,
                icon: t.icon,
                run: () => { handleNewFromTemplate(t.id); onClose(); },
            })),
        activePageId && {
            id: "pin",
            label: "Pin / unpin current page",
            hint: "Ctrl+P",
            icon: Pin,
            run: () => { handleTogglePin(activePageId); onClose(); },
        },
        activePageId && {
            id: "archive",
            label: "Archive / unarchive current page",
            hint: "Ctrl+Shift+A",
            icon: Archive,
            run: () => { handleToggleArchive(activePageId); onClose(); },
        },
    ].filter(Boolean) as any[]), [openHome, openEditor, handleNewPage, handleOpenTodayJournal, setSwitcherOpen, handleNewFromTemplate, handleTogglePin, handleToggleArchive, activePageId, onClose]);

    /* ── Build searchable items: pages first, then actions ── */
    const items = useMemo<PaletteItem[]>(() => {
        const pageItems: PaletteItem[] = (pages || [])
            .filter((p: any) => !p.archived)
            .map((p: any) => ({
                kind: "page",
                id: p.id,
                label: p.title || "Untitled",
                meta: formatDate(p.updatedAt),
                icon: p.pinned ? Pin : FileText,
                run: () => { openEditor(p.id); onClose(); },
            }));
        const actionItems: PaletteItem[] = actions.map((a: any) => ({
            kind: "action",
            id: a.id,
            label: a.label,
            meta: a.hint || "",
            icon: a.icon,
            run: a.run,
        }));
        return [...pageItems, ...actionItems];
    }, [pages, actions, openEditor, onClose]);

    /* ── Filter + score ── */
    const filtered = useMemo<PaletteItem[]>(() => {
        if (!query.trim()) {
            // No query: surface recent pages (top 6) then all actions
            const recent = items.filter(i => i.kind === "page").slice(0, 6);
            const acts = items.filter(i => i.kind === "action");
            return [...recent, ...acts].map(i => ({ ...i, indices: [] }));
        }
        const q = query.trim();
        const scored = items
            .map(i => {
                const m = fuzzyMatch(q, i.label);
                return m ? { ...i, score: m.score + (i.kind === "page" ? 2 : 0), indices: m.indices } : null;
            })
            .filter(Boolean) as PaletteItem[];
        scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        return scored.slice(0, 30);
    }, [items, query]);

    /* ── Keep active in range ── */
    useEffect(() => { setActive(0); }, [query]);
    useEffect(() => {
        const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
        if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
    }, [active]);

    /* ── Lifecycle: focus, esc, body lock ── */
    useEffect(() => {
        setTimeout(() => inputRef.current?.focus(), 30);
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
        document.addEventListener("keydown", onKey);
        const prev = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => {
            document.removeEventListener("keydown", onKey);
            document.body.style.overflow = prev;
        };
    }, [onClose]);

    const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "ArrowDown") { e.preventDefault(); setActive(i => Math.min(i + 1, filtered.length - 1)); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setActive(i => Math.max(i - 1, 0)); }
        else if (e.key === "Enter") {
            e.preventDefault();
            const item = filtered[active];
            if (item) item.run();
        }
    };

    return createPortal(
        <div className={s.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div className={s.palette} role="dialog" aria-label="Command palette">
                <div className={s.inputWrap}>
                    <Search className={s.searchIcon} size={16} aria-hidden="true" />
                    <input
                        ref={inputRef}
                        className={s.input}
                        placeholder="Type to search pages or run an action…"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={onInputKey}
                        aria-label="Command palette input"
                    />
                    <kbd className={s.kbd}>Esc</kbd>
                </div>

                <div ref={listRef} className={s.list} role="listbox">
                    {filtered.length === 0 && (
                        <div className={s.empty}>No matches</div>
                    )}
                    {filtered.map((item, idx) => {
                        const Icon = item.icon;
                        return (
                            <button
                                key={`${item.kind}-${item.id}`}
                                data-idx={idx}
                                className={`${s.row} ${idx === active ? s.rowActive : ""}`}
                                onMouseEnter={() => setActive(idx)}
                                onClick={item.run}
                                role="option"
                                aria-selected={idx === active}
                            >
                                <span className={s.rowIcon} aria-hidden="true">
                                    {Icon ? <Icon size={15} /> : null}
                                </span>
                                <span className={s.rowLabel}>{highlight(item.label, item.indices || [])}</span>
                                <span className={s.rowMeta}>{item.meta}</span>
                                {idx === active && <span className={s.enterHint}>↵</span>}
                            </button>
                        );
                    })}
                </div>

                <div className={s.footer}>
                    <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
                    <span><kbd>↵</kbd> select</span>
                    <span><kbd>Esc</kbd> close</span>
                </div>
            </div>
        </div>,
        document.body
    );
}