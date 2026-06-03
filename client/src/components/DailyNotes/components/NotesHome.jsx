/* ─────────────────────────────────────────────────────────
   NotesHome — clean, simple landing for the /notes route.
   Layout (top → bottom, single readable column flow):
     ┌─────────────────────────────────────────────────────┐
     │ Header (greeting + New page) + search bar            │
     ├─────────────────────────────────────────────────────┤
     │ Jump back in (last edited page)                      │
     ├──────────────────────────────┬──────────────────────┤
     │ Recent pages                 │ Pinned               │
     ├──────────────────────────────┴──────────────────────┤
     │ Start from a template                               │
     ├──────────────────────────────┬──────────────────────┤
     │ Folders                      │ Tags                 │
     └──────────────────────────────┴──────────────────────┘
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

    const lastEdited = recent[0] || null;
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

    /* Live filter for the search bar */
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
            {/* ── Header ───────────────────────────────────────────── */}
            <header className={s.header}>
                <div className={s.headerText}>
                    <p className={s.headerDate}>{todayLong()}</p>
                    <h1 className={s.greeting}>
                        {getGreeting()}, <span className={s.name}>{firstName}</span>
                    </h1>
                    <p className={s.meta}>
                        {activePages.length} {activePages.length === 1 ? 'note' : 'notes'}
                        {folders.length > 0 && (
                            <>
                                <span className={s.dot}>·</span>
                                {folders.length} {folders.length === 1 ? 'folder' : 'folders'}
                            </>
                        )}
                    </p>
                </div>

                <button
                    type="button"
                    className={s.newBtn}
                    onClick={() => handleNewPage()}
                    title="Create a new note"
                >
                    <Plus size={16} />
                    <span>New note</span>
                </button>
            </header>

            {/* ── Search bar ───────────────────────────────────────── */}
            <form className={s.searchBar} onSubmit={onSearchSubmit} role="search">
                <Search className={s.searchIcon} size={18} aria-hidden="true" />
                <input
                    className={s.searchInput}
                    placeholder="Search your notes…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    aria-label="Search notes"
                />
                {search && (
                    <button
                        type="button"
                        className={s.searchClear}
                        onClick={() => setSearch('')}
                        aria-label="Clear search"
                    >×</button>
                )}

                {/* Inline live results dropdown */}
                {search.trim() && (
                    <div className={s.searchResults} role="listbox">
                        {liveMatches.length === 0 ? (
                            <button
                                type="button"
                                className={s.searchResultRow}
                                onClick={() => { handleNewPage(search.trim()); setSearch(''); }}
                            >
                                <span className={s.searchResultIcon}><Plus size={15} /></span>
                                <span className={s.searchResultText}>
                                    Create note <strong>"{search.trim()}"</strong>
                                </span>
                            </button>
                        ) : (
                            liveMatches.map(p => (
                                <button
                                    type="button"
                                    key={p.id}
                                    className={s.searchResultRow}
                                    onClick={() => { openEditor(p.id); setSearch(''); }}
                                >
                                    <span className={s.searchResultIcon}>
                                        {p.pinned ? <Pin size={15} /> : <FileText size={15} />}
                                    </span>
                                    <span className={s.searchResultText}>
                                        {p.title || 'Untitled'}
                                    </span>
                                    <span className={s.searchResultMeta}>
                                        {relativeFromNow(p.updatedAt)}
                                    </span>
                                </button>
                            ))
                        )}
                    </div>
                )}
            </form>

            {/* ── Empty state ──────────────────────────────────────── */}
            {isEmpty ? (
                <div className={s.emptyState}>
                    <div className={s.emptyIcon} aria-hidden="true">
                        <StickyNote size={44} strokeWidth={1.5} />
                    </div>
                    <h3 className={s.emptyTitle}>No notes yet</h3>
                    <p className={s.emptySub}>
                        Create your first note, or start from a template below.
                    </p>
                    <button
                        type="button"
                        className={s.emptyBtn}
                        onClick={() => handleNewPage()}
                    >
                        <Plus size={15} />
                        <span>New note</span>
                    </button>
                </div>
            ) : (
                <>
                    {/* ── Jump back in ─────────────────────────────── */}
                    {lastEdited && (
                        <section className={s.section}>
                            <h2 className={s.sectionTitle}>
                                <Clock size={15} /> Jump back in
                            </h2>
                            <button
                                className={s.resumeCard}
                                onClick={() => openEditor(lastEdited.id)}
                                title="Resume editing"
                            >
                                <span className={s.resumeIcon} aria-hidden="true">
                                    {lastEdited.icon || '📝'}
                                </span>
                                <span className={s.resumeBody}>
                                    <span className={s.resumeTitle}>
                                        {lastEdited.title || 'Untitled'}
                                    </span>
                                    {snippetOf(lastEdited.content) && (
                                        <span className={s.resumeSnippet}>
                                            {snippetOf(lastEdited.content)}
                                        </span>
                                    )}
                                    <span className={s.resumeMeta}>
                                        Edited {relativeFromNow(lastEdited.updatedAt)}
                                    </span>
                                </span>
                                <span className={s.resumeCta} aria-hidden="true">
                                    <ArrowUpRight size={18} />
                                </span>
                            </button>
                        </section>
                    )}

                    {/* ── Recent + Pinned ──────────────────────────── */}
                    <div className={s.twoCol}>
                        {otherRecent.length > 0 && (
                            <section className={s.section}>
                                <h2 className={s.sectionTitle}>
                                    <FileText size={15} /> Recent notes
                                </h2>
                                <ul className={s.recentList}>
                                    {otherRecent.map(p => (
                                        <li key={p.id}>
                                            <button
                                                className={s.recentRow}
                                                onClick={() => openEditor(p.id)}
                                                title={p.title}
                                            >
                                                <span className={s.recentRowIcon} aria-hidden="true">
                                                    {p.icon || <FileText size={15} />}
                                                </span>
                                                <span className={s.recentRowMain}>
                                                    <span className={s.recentRowTitle}>
                                                        {p.title || 'Untitled'}
                                                    </span>
                                                    {snippetOf(p.content, 64) && (
                                                        <span className={s.recentRowSnippet}>
                                                            {snippetOf(p.content, 64)}
                                                        </span>
                                                    )}
                                                </span>
                                                <span className={s.recentRowMeta}>
                                                    {relativeFromNow(p.updatedAt)}
                                                </span>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        )}

                        {pinned.length > 0 && (
                            <section className={s.section}>
                                <div className={s.sectionHead}>
                                    <h2 className={s.sectionTitle}>
                                        <Pin size={15} /> Pinned
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
                    </div>
                </>
            )}

            {/* ── Templates (always shown) ─────────────────────────── */}
            <section className={s.section}>
                <h2 className={s.sectionTitle}>
                    <Plus size={15} /> Start from a template
                </h2>
                <div className={s.templateGrid}>
                    {TEMPLATES.map(tpl => {
                        const Icon = tpl.icon;
                        return (
                            <button
                                key={tpl.id}
                                className={s.templateTile}
                                onClick={() =>
                                    tpl.id === 'journal'
                                        ? handleOpenTodayJournal()
                                        : tpl.id === 'blank'
                                            ? handleNewPage()
                                            : handleNewFromTemplate(tpl.id)
                                }
                                title={tpl.description}
                            >
                                <span className={s.templateIcon} aria-hidden="true">
                                    {Icon ? <Icon size={18} /> : null}
                                </span>
                                <span className={s.templateName}>{tpl.name}</span>
                                <span className={s.templateDesc}>{tpl.description}</span>
                            </button>
                        );
                    })}
                </div>
            </section>

            {/* ── Folders + Tags ───────────────────────────────────── */}
            <div className={s.twoCol}>
                <section className={s.section}>
                    <h2 className={s.sectionTitle}>
                        <Folder size={15} /> Folders
                    </h2>
                    <div className={s.folderGrid}>
                        {topFolders.map(f => (
                            <button
                                key={f.id}
                                className={s.folderCard}
                                onClick={() => onFolderClick(f.id)}
                                title={`Open folder ${f.name}`}
                            >
                                <span className={s.folderIcon} aria-hidden="true">
                                    <Folder size={18} />
                                </span>
                                <span className={s.folderName}>{f.name}</span>
                                <span className={s.folderCount}>
                                    {f.count} {f.count === 1 ? 'note' : 'notes'}
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
                                <FolderPlus size={18} />
                            </span>
                            <span className={s.folderName}>New folder</span>
                        </button>
                    </div>
                </section>

                {tagCounts.length > 0 && (
                    <section className={s.section}>
                        <h2 className={s.sectionTitle}>
                            <Tag size={15} /> Tags
                        </h2>
                        <div className={s.tagCloud}>
                            {tagCounts.map(([tag, count]) => (
                                <button
                                    key={tag}
                                    className={s.tagChip}
                                    style={{ '--tag-color': tagColor(tag) }}
                                    onClick={() => onTagClick(tag)}
                                    title={`${count} ${count === 1 ? 'note' : 'notes'} tagged #${tag}`}
                                >
                                    <span className={s.tagDot} />
                                    <span className={s.tagName}>#{tag}</span>
                                    <span className={s.tagCount}>{count}</span>
                                </button>
                            ))}
                        </div>
                    </section>
                )}
            </div>
        </div>
    );
}