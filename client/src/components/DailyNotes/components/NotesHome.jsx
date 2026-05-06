/* ─────────────────────────────────────────────────────────
   NotesHome — modernized landing dashboard for the /notes route.
   Layout:
     ┌─────────────────────────────────────────────────────┐
     │ Hero (greeting + meta + combined command bar)        │
     ├─────────────────────────────────────────────────────┤
     │ "Continue writing" hero card (full-width)           │
     ├─────────────────────────────────────┬───────────────┤
     │ Recent grid (3 cols)                │ Pinned        │
     ├─────────────────────────────────────┼───────────────┤
     │ Quick actions (template chips)      │ Tags / Folders│
     └─────────────────────────────────────┴───────────────┘
   ───────────────────────────────────────────────────────── */
import React, { useMemo, useState } from 'react';
import { useAuth } from '../../../AuthContext';
import { TEMPLATES } from '../templates';
import { formatDate, tagColor, stripHtml } from '../notesUtils';
import {
    Plus,
    Search,
    StickyNote,
    Pin,
    Clock,
    Tag,
    Folder,
    FolderPlus,
    ArrowUpRight,
    Sparkles,
    Command,
    FileText,
} from '../../../constants/icons';
import s from './NotesHome.module.css';

function getGreeting() {
    const h = new Date().getHours();
    if (h < 5) return 'Working late';
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    if (h < 22) return 'Good evening';
    return 'Good night';
}

function todayLong() {
    return new Date().toLocaleDateString(undefined, {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
    });
}

function snippetOf(html, max = 140) {
    const text = stripHtml(html || '').trim();
    if (!text) return '';
    return text.length > max ? text.slice(0, max).trim() + '…' : text;
}

function relativeFromNow(iso) {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    const diff = Date.now() - then;
    const min = Math.round(diff / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr} hr ago`;
    const d = Math.round(hr / 24);
    if (d < 7) return `${d}d ago`;
    return formatDate(iso);
}

export default function NotesHome({ store }) {
    const { user } = useAuth();
    const {
        pages, folders,
        handleNewPage, handleNewFromTemplate, handleOpenTodayJournal,
        openEditor,
        setSearchQuery, setFolderFilter, setShowArchived,
        setNewFolderOpen,
        setPaletteOpen,
    } = store;

    const [search, setSearch] = useState('');

    const activePages = useMemo(() => pages.filter(p => !p.archived), [pages]);

    const pinned = useMemo(
        () => activePages.filter(p => p.pinned).slice(0, 6),
        [activePages]
    );

    const recent = useMemo(
        () => [...activePages]
            .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
            .slice(0, 9),
        [activePages]
    );

    const continueWriting = recent[0] || null;
    const otherRecent = recent.slice(1, 7);

    const tagCounts = useMemo(() => {
        const counts = {};
        activePages.forEach(p => (p.tags || []).forEach(t => {
            counts[t] = (counts[t] || 0) + 1;
        }));
        return Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 14);
    }, [activePages]);

    const topFolders = useMemo(() => {
        return folders
            .filter(f => !f.parentId)
            .map(f => ({
                ...f,
                count: activePages.filter(p => p.folderId === f.id).length,
            }))
            .sort((a, b) => b.count - a.count);
    }, [folders, activePages]);

    /* Live filter for the hero command bar */
    const liveMatches = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return [];
        return activePages
            .filter(p => (p.title || '').toLowerCase().includes(q)
                || stripHtml(p.content || '').toLowerCase().includes(q))
            .slice(0, 5);
    }, [search, activePages]);

    const isEmpty = activePages.length === 0;

    const firstName = (user?.full_name || user?.username || 'there').split(' ')[0];

    const onSearchSubmit = (e) => {
        e.preventDefault();
        const q = search.trim();
        if (!q) return;
        setSearchQuery(q);
        openEditor();
    };

    const onTagClick = (tag) => {
        setSearchQuery(`#${tag}`);
        openEditor();
    };

    const onFolderClick = (folderId) => {
        setFolderFilter(folderId || 'all');
        setShowArchived(false);
        openEditor();
    };

    const onPinnedAllClick = () => {
        setFolderFilter('all');
        setShowArchived(false);
        openEditor();
    };

    return (
        <div className={s.home}>
            {/* ── Hero ────────────────────────────────────────────── */}
            <header className={s.hero}>
                <div className={s.heroGrad} aria-hidden="true" />

                <div className={s.heroTop}>
                    <div className={s.heroText}>
                        <p className={s.heroDate}>{todayLong()}</p>
                        <h1 className={s.greeting}>
                            {getGreeting()}, <span className={s.name}>{firstName}</span>
                        </h1>
                        <p className={s.meta}>
                            {activePages.length} {activePages.length === 1 ? 'page' : 'pages'}
                            {folders.length > 0 && (
                                <>
                                    <span className={s.dot}>·</span>
                                    {folders.length} {folders.length === 1 ? 'folder' : 'folders'}
                                </>
                            )}
                            {pinned.length > 0 && (
                                <>
                                    <span className={s.dot}>·</span>
                                    {pinned.length} pinned
                                </>
                            )}
                        </p>
                    </div>

                    <div className={s.heroActions}>
                        <button
                            type="button"
                            className={s.heroBtnGhost}
                            onClick={() => setPaletteOpen?.(true)}
                            title="Open command palette (Ctrl+K)"
                        >
                            <Command size={14} />
                            <span>Commands</span>
                            <kbd className={s.kbd}>⌘K</kbd>
                        </button>
                        <button
                            type="button"
                            className={s.heroBtnPrimary}
                            onClick={() => handleNewPage()}
                            title="Create a new blank page"
                        >
                            <Plus size={14} />
                            <span>New page</span>
                        </button>
                    </div>
                </div>

                <form className={s.cmdBar} onSubmit={onSearchSubmit} role="search">
                    <Search className={s.cmdIcon} size={17} aria-hidden="true" />
                    <input
                        className={s.cmdInput}
                        placeholder="Search notes, jump to a page, or type to filter…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        aria-label="Search notes"
                    />
                    {search && (
                        <button
                            type="button"
                            className={s.cmdClear}
                            onClick={() => setSearch('')}
                            aria-label="Clear search"
                        >×</button>
                    )}
                    <kbd className={s.cmdKbd}>Enter</kbd>

                    {/* Inline live results dropdown */}
                    {search.trim() && (
                        <div className={s.cmdResults} role="listbox">
                            {liveMatches.length === 0 ? (
                                <button
                                    type="button"
                                    className={s.cmdResultRow}
                                    onClick={() => { handleNewPage(search.trim()); setSearch(''); }}
                                >
                                    <span className={s.cmdResultIcon}><Plus size={14} /></span>
                                    <span className={s.cmdResultText}>
                                        Create page <strong>"{search.trim()}"</strong>
                                    </span>
                                </button>
                            ) : (
                                liveMatches.map(p => (
                                    <button
                                        type="button"
                                        key={p.id}
                                        className={s.cmdResultRow}
                                        onClick={() => { openEditor(p.id); setSearch(''); }}
                                    >
                                        <span className={s.cmdResultIcon}>
                                            {p.pinned ? <Pin size={14} /> : <FileText size={14} />}
                                        </span>
                                        <span className={s.cmdResultText}>
                                            {p.title || 'Untitled'}
                                        </span>
                                        <span className={s.cmdResultMeta}>
                                            {relativeFromNow(p.updatedAt)}
                                        </span>
                                    </button>
                                ))
                            )}
                        </div>
                    )}
                </form>
            </header>

            {/* ── Continue writing — hero card ───────────────────── */}
            {continueWriting && (
                <section className={s.continue}>
                    <button
                        className={s.continueCard}
                        onClick={() => openEditor(continueWriting.id)}
                        title="Resume editing"
                    >
                        <div className={s.continueLeft}>
                            <span className={s.continueLabel}>
                                <Sparkles size={12} />
                                Continue writing
                            </span>
                            <h2 className={s.continueTitle}>
                                {continueWriting.title || 'Untitled'}
                            </h2>
                            {snippetOf(continueWriting.content) && (
                                <p className={s.continueSnippet}>
                                    {snippetOf(continueWriting.content)}
                                </p>
                            )}
                            <p className={s.continueMeta}>
                                Edited {relativeFromNow(continueWriting.updatedAt)}
                                {continueWriting.tags?.length > 0 && (
                                    <>
                                        <span className={s.dot}>·</span>
                                        {continueWriting.tags.slice(0, 3).map(t => (
                                            <span key={t} className={s.continueTag}>#{t}</span>
                                        ))}
                                    </>
                                )}
                            </p>
                        </div>
                        <span className={s.continueCta} aria-hidden="true">
                            <ArrowUpRight size={18} />
                        </span>
                    </button>
                </section>
            )}

            {/* ── Empty state (only when literally no pages) ─────── */}
            {isEmpty && (
                <div className={s.emptyState}>
                    <div className={s.emptyIcon} aria-hidden="true">
                        <StickyNote size={44} strokeWidth={1.5} />
                    </div>
                    <h3 className={s.emptyTitle}>You don't have any notes yet</h3>
                    <p className={s.emptySub}>
                        Pick a template below, or start from a blank page.
                    </p>
                </div>
            )}

            {/* ── Bento grid ──────────────────────────────────────── */}
            <div className={s.bento}>
                {/* Recent — wide */}
                {otherRecent.length > 0 && (
                    <section className={`${s.card} ${s.colWide}`}>
                        <div className={s.cardHead}>
                            <h2 className={s.cardTitle}>
                                <Clock size={14} /> Recently edited
                            </h2>
                        </div>
                        <ul className={s.recentGrid}>
                            {otherRecent.map(p => (
                                <li key={p.id}>
                                    <button
                                        className={s.recentTile}
                                        onClick={() => openEditor(p.id)}
                                        title={p.title}
                                    >
                                        <span className={s.recentTileIcon}>
                                            <FileText size={14} />
                                        </span>
                                        <span className={s.recentTileTitle}>
                                            {p.title || 'Untitled'}
                                        </span>
                                        {snippetOf(p.content, 70) && (
                                            <span className={s.recentTileSnippet}>
                                                {snippetOf(p.content, 70)}
                                            </span>
                                        )}
                                        <span className={s.recentTileMeta}>
                                            {relativeFromNow(p.updatedAt)}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </section>
                )}

                {/* Pinned — narrow */}
                {pinned.length > 0 && (
                    <section className={`${s.card} ${s.colNarrow}`}>
                        <div className={s.cardHead}>
                            <h2 className={s.cardTitle}>
                                <Pin size={14} /> Pinned
                            </h2>
                            {pinned.length >= 5 && (
                                <button className={s.viewAll} onClick={onPinnedAllClick}>
                                    View all
                                </button>
                            )}
                        </div>
                        <ul className={s.pinList}>
                            {pinned.map(p => (
                                <li key={p.id}>
                                    <button
                                        className={s.pinRow}
                                        onClick={() => openEditor(p.id)}
                                        title={p.title}
                                    >
                                        <span
                                            className={s.pinAccent}
                                            style={{
                                                background: p.tags?.[0]
                                                    ? tagColor(p.tags[0])
                                                    : 'var(--notes-accent)',
                                            }}
                                        />
                                        <span className={s.pinTitle}>{p.title || 'Untitled'}</span>
                                        <span className={s.pinDate}>{relativeFromNow(p.updatedAt)}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </section>
                )}

                {/* Quick actions — wide */}
                <section className={`${s.card} ${s.colWide}`}>
                    <div className={s.cardHead}>
                        <h2 className={s.cardTitle}>
                            <Sparkles size={14} /> Start something new
                        </h2>
                    </div>
                    <div className={s.quickGrid}>
                        {TEMPLATES.map(tpl => {
                            const Icon = tpl.icon;
                            return (
                                <button
                                    key={tpl.id}
                                    className={s.quickTile}
                                    onClick={() =>
                                        tpl.id === 'journal'
                                            ? handleOpenTodayJournal()
                                            : tpl.id === 'blank'
                                                ? handleNewPage()
                                                : handleNewFromTemplate(tpl.id)
                                    }
                                    title={tpl.description}
                                >
                                    <span className={s.quickIcon} aria-hidden="true">
                                        {Icon ? <Icon size={18} /> : null}
                                    </span>
                                    <span className={s.quickName}>{tpl.name}</span>
                                    <span className={s.quickDesc}>{tpl.description}</span>
                                </button>
                            );
                        })}
                    </div>
                </section>

                {/* Tags — narrow */}
                {tagCounts.length > 0 && (
                    <section className={`${s.card} ${s.colNarrow}`}>
                        <div className={s.cardHead}>
                            <h2 className={s.cardTitle}>
                                <Tag size={14} /> Tags
                            </h2>
                        </div>
                        <div className={s.tagCloud}>
                            {tagCounts.map(([tag, count]) => (
                                <button
                                    key={tag}
                                    className={s.tagChip}
                                    style={{ '--tag-color': tagColor(tag) }}
                                    onClick={() => onTagClick(tag)}
                                    title={`${count} ${count === 1 ? 'page' : 'pages'} tagged #${tag}`}
                                >
                                    <span className={s.tagDot} />
                                    <span className={s.tagName}>#{tag}</span>
                                    <span className={s.tagCount}>{count}</span>
                                </button>
                            ))}
                        </div>
                    </section>
                )}

                {/* Folders — full row */}
                <section className={`${s.card} ${s.colFull}`}>
                    <div className={s.cardHead}>
                        <h2 className={s.cardTitle}>
                            <Folder size={14} /> Folders
                        </h2>
                    </div>
                    <div className={s.folderGrid}>
                        {topFolders.map(f => (
                            <button
                                key={f.id}
                                className={s.folderCard}
                                onClick={() => onFolderClick(f.id)}
                                title={`Open folder ${f.name}`}
                            >
                                <span className={s.folderIcon} aria-hidden="true">
                                    <Folder size={20} />
                                </span>
                                <span className={s.folderName}>{f.name}</span>
                                <span className={s.folderCount}>
                                    {f.count} {f.count === 1 ? 'page' : 'pages'}
                                </span>
                            </button>
                        ))}
                        <button
                            className={`${s.folderCard} ${s.newFolderCard}`}
                            onClick={() => {
                                setNewFolderOpen(true);
                                openEditor();
                            }}
                            title="Create a new folder"
                        >
                            <span className={s.folderIcon} aria-hidden="true">
                                <FolderPlus size={20} />
                            </span>
                            <span className={s.folderName}>New folder</span>
                        </button>
                    </div>
                </section>
            </div>

        </div>
    );
}
