/* ─────────────────────────────────────────────────────────
   NotesHome — landing dashboard for the /notes route.
   Shows greeting, quick-action templates, pinned, recent,
   tags, folders. Switches to the editor view on selection.
   ───────────────────────────────────────────────────────── */
import React, { useMemo, useState } from 'react';
import { useAuth } from '../../../AuthContext';
import { TEMPLATES } from '../templates';
import { formatDate, tagColor, stripHtml } from '../notesUtils';
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

function snippetOf(html, max = 110) {
    const text = stripHtml(html || '').trim();
    if (!text) return '';
    return text.length > max ? text.slice(0, max).trim() + '…' : text;
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
        () => activePages.filter(p => p.pinned).slice(0, 5),
        [activePages]
    );

    const recent = useMemo(
        () => [...activePages]
            .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
            .slice(0, 6),
        [activePages]
    );

    const tagCounts = useMemo(() => {
        const counts = {};
        activePages.forEach(p => (p.tags || []).forEach(t => {
            counts[t] = (counts[t] || 0) + 1;
        }));
        return Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 12);
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

    const isEmpty = activePages.length === 0;

    const firstName = (user?.full_name || user?.username || 'there').split(' ')[0];

    const onSearchSubmit = (e) => {
        e.preventDefault();
        const q = search.trim();
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
            {/* ── Header ─────────────────────────────────────────── */}
            <header className={s.header}>
                <div>
                    <h1 className={s.greeting}>
                        {getGreeting()}, <span className={s.name}>{firstName}</span>
                    </h1>
                    <p className={s.meta}>
                        {todayLong()}
                        <span className={s.dot}>·</span>
                        {activePages.length} {activePages.length === 1 ? 'page' : 'pages'}
                        {folders.length > 0 && (
                            <>
                                <span className={s.dot}>·</span>
                                {folders.length} {folders.length === 1 ? 'folder' : 'folders'}
                            </>
                        )}
                    </p>
                </div>
                <div className={s.headerActions}>
                    <button
                        className={s.newPageBtn}
                        onClick={() => handleNewPage()}
                        title="Create a new blank page"
                    >
                        <svg viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
                            <path d="M7 1a1 1 0 011 1v4h4a1 1 0 010 2H8v4a1 1 0 01-2 0V8H2a1 1 0 010-2h4V2a1 1 0 011-1z" />
                        </svg>
                        New page
                    </button>
                </div>
            </header>

            {/* ── Search ─────────────────────────────────────────── */}
            <form className={s.searchWrap} onSubmit={onSearchSubmit} role="search">
                <svg className={s.searchIcon} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="7" cy="7" r="5" />
                    <path d="M11 11l3 3" />
                </svg>
                <input
                    className={s.searchInput}
                    placeholder="Search all notes…"
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
                    >
                        ×
                    </button>
                )}
            </form>

            {/* ── Quick actions (templates) ─────────────────────── */}
            <section className={s.section}>
                <h2 className={s.sectionTitle}>Quick actions</h2>
                <div className={s.quickGrid}>
                    {TEMPLATES.map(tpl => (
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
                            <span className={s.quickIcon} aria-hidden="true">{tpl.icon}</span>
                            <span className={s.quickName}>{tpl.name}</span>
                            <span className={s.quickDesc}>{tpl.description}</span>
                        </button>
                    ))}
                </div>
            </section>

            {/* ── Empty state ────────────────────────────────────── */}
            {isEmpty && (
                <div className={s.emptyState}>
                    <div className={s.emptyIcon} aria-hidden="true">📝</div>
                    <h3 className={s.emptyTitle}>You don't have any notes yet</h3>
                    <p className={s.emptySub}>
                        Pick a template above, or start from a blank page.
                    </p>
                </div>
            )}

            {/* ── Pinned ─────────────────────────────────────────── */}
            {pinned.length > 0 && (
                <section className={s.section}>
                    <div className={s.sectionHeadRow}>
                        <h2 className={s.sectionTitle}>
                            <span className={s.sectionEmoji}>📌</span> Pinned
                        </h2>
                        {pinned.length >= 5 && (
                            <button className={s.viewAll} onClick={onPinnedAllClick}>
                                View all
                            </button>
                        )}
                    </div>
                    <ul className={s.list}>
                        {pinned.map(p => (
                            <li key={p.id}>
                                <button
                                    className={s.listRow}
                                    onClick={() => openEditor(p.id)}
                                    title={p.title}
                                >
                                    <span className={s.listTitle}>{p.title || 'Untitled'}</span>
                                    <span className={s.listDate}>{formatDate(p.updatedAt)}</span>
                                </button>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {/* ── Recent + Tags two-column row ───────────────────── */}
            {(recent.length > 0 || tagCounts.length > 0) && (
                <div className={s.twoCol}>
                    {/* Recent */}
                    {recent.length > 0 && (
                        <section className={`${s.section} ${s.col}`}>
                            <h2 className={s.sectionTitle}>
                                <span className={s.sectionEmoji}>🕒</span> Recent
                            </h2>
                            <ul className={s.recentList}>
                                {recent.map(p => (
                                    <li key={p.id}>
                                        <button
                                            className={s.recentRow}
                                            onClick={() => openEditor(p.id)}
                                            title={p.title}
                                        >
                                            <div className={s.recentMain}>
                                                <span className={s.recentTitle}>
                                                    {p.title || 'Untitled'}
                                                </span>
                                                <span className={s.recentDate}>
                                                    {formatDate(p.updatedAt)}
                                                </span>
                                            </div>
                                            {snippetOf(p.content) && (
                                                <span className={s.recentSnippet}>
                                                    {snippetOf(p.content)}
                                                </span>
                                            )}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}

                    {/* Tags */}
                    {tagCounts.length > 0 && (
                        <section className={`${s.section} ${s.col}`}>
                            <h2 className={s.sectionTitle}>
                                <span className={s.sectionEmoji}>🏷</span> Tags
                            </h2>
                            <div className={s.tagCloud}>
                                {tagCounts.map(([tag, count]) => (
                                    <button
                                        key={tag}
                                        className={s.tagChip}
                                        style={{
                                            '--tag-color': tagColor(tag),
                                        }}
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
                </div>
            )}

            {/* ── Folders ────────────────────────────────────────── */}
            <section className={s.section}>
                <h2 className={s.sectionTitle}>
                    <span className={s.sectionEmoji}>📁</span> Folders
                </h2>
                <div className={s.folderGrid}>
                    {topFolders.map(f => (
                        <button
                            key={f.id}
                            className={s.folderCard}
                            onClick={() => onFolderClick(f.id)}
                            title={`Open folder ${f.name}`}
                        >
                            <span className={s.folderIcon} aria-hidden="true">📁</span>
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
                        <span className={s.folderIcon} aria-hidden="true">＋</span>
                        <span className={s.folderName}>New folder</span>
                    </button>
                </div>
            </section>

            <footer className={s.footer}>
                <span className={s.footerHint}>
                    Ctrl+N new page · Ctrl+Shift+F search · Ctrl+H back to home
                </span>
            </footer>
        </div>
    );
}