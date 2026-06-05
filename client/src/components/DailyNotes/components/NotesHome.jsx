/* ─────────────────────────────────────────────────────────
   NotesHome — redesigned landing for the /notes route.
   Two-pane layout matching the dashboard mockup:
     • Left sidebar: user header, New Notebook CTA, primary nav,
       workspace folder tree, footer (settings / log out).
     • Main canvas: sticky blurred header (date + greeting +
       search), "Jump back in" resume card, templates, and the
       supporting recent / pinned / liked / tag sections.
   Styling lives in NotesHome.module.css and is driven by the
   themeable --notes-* tokens (notesTokens.css).
   ───────────────────────────────────────────────────────── */
import React, { useMemo, useRef, useState } from 'react';
import { useAuth } from '../../../AuthContext';
import { TEMPLATES } from '../templates';
import { formatDate, tagColor, stripHtml } from '../notesUtils';
import FolderTree from './FolderTree';
import {
    Plus,
    Search,
    StickyNote,
    Pin,
    Clock,
    Tag,
    ArrowUpRight,
    FileText,
    Heart,
    Home,
    History,
    LayoutTemplate,
    Archive,
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
        handleNewFolder, handleRenameFolder, handleDeleteFolder,
        handleMoveToFolder, handleMoveFolder,
    } = store;

    const [search, setSearch] = useState('');
    const [notebookInput, setNotebookInput] = useState(false);
    const [notebookName, setNotebookName] = useState('');
    const mainRef = useRef(null);
    const recentRef = useRef(null);
    const templatesRef = useRef(null);

    const activePages = useMemo(() => pages.filter(p => !p.archived), [pages]);

    const pinned = useMemo(
        () => activePages.filter(p => p.pinned).slice(0, 6),
        [activePages]
    );

    // Pages the current user has reacted to (any emoji).
    const liked = useMemo(() => {
        const uid = user?.id;
        if (!uid) return [];
        return activePages
            .filter(p => {
                const reactions = p.reactions || {};
                return Object.values(reactions).some(
                    list => Array.isArray(list) && list.includes(uid)
                );
            })
            .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
            .slice(0, 8);
    }, [activePages, user]);

    const recent = useMemo(
        () => [...activePages]
            .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
            .slice(0, 9),
        [activePages]
    );

    const lastEdited = recent[0] || null;
    const otherRecent = recent.slice(1, 7);

    const folderNameById = useMemo(() => {
        const map = {};
        (folders || []).forEach(f => { map[f.id] = f.name; });
        return map;
    }, [folders]);

    const lastEditedFolder = lastEdited
        ? folderNameById[lastEdited.folderId]
        : null;

    const tagCounts = useMemo(() => {
        const counts = {};
        activePages.forEach(p => (p.tags || []).forEach(t => {
            counts[t] = (counts[t] || 0) + 1;
        }));
        return Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 14);
    }, [activePages]);

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

    const fullName = user?.full_name || user?.username || 'there';
    const firstName = fullName.split(' ')[0];
    const avatarInitial = fullName.charAt(0).toUpperCase();

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

    const onPinnedAllClick = () => {
        setFolderFilter('all');
        setShowArchived(false);
        openEditor();
    };

    /* ── Sidebar nav actions ─────────────────────────────── */
    const scrollMainTop = () => {
        mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    };
    const goHome = () => scrollMainTop();
    const goRecent = () => {
        if (recentRef.current) {
            recentRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else {
            scrollMainTop();
        }
    };
    const goTemplates = () => {
        templatesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    const goArchive = () => {
        setFolderFilter('all');
        setShowArchived(true);
        openEditor();
    };
    const submitNotebook = () => {
        const name = notebookName.trim();
        if (name) handleNewFolder(null, name);
        setNotebookName('');
        setNotebookInput(false);
    };

    return (
        <div className={s.home}>
            {/* ── Sidebar ──────────────────────────────────────────── */}
            <aside className={s.sidebar}>
                <div className={s.sideUser}>
                    <div className={s.avatar}>
                        {user?.avatar
                            ? <img src={user.avatar} alt={fullName} />
                            : <span>{avatarInitial}</span>}
                    </div>
                    <div className={s.sideUserText}>
                        <span className={s.sideUserName}>{firstName}</span>
                        <span className={s.sideUserPlan}>Notes</span>
                    </div>
                </div>

                <div className={s.sideCta}>
                    {notebookInput ? (
                        <input
                            className={s.notebookInput}
                            value={notebookName}
                            onChange={(e) => setNotebookName(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') submitNotebook();
                                if (e.key === 'Escape') { setNotebookName(''); setNotebookInput(false); }
                            }}
                            onBlur={submitNotebook}
                            placeholder="Notebook name…"
                            autoFocus
                            aria-label="New notebook name"
                        />
                    ) : (
                        <button
                            type="button"
                            className={s.notebookBtn}
                            onClick={() => { setNotebookName(''); setNotebookInput(true); }}
                        >
                            <Plus size={18} />
                            <span>New Notebook</span>
                        </button>
                    )}
                </div>

                <nav className={s.sideNav}>
                    <button type="button" className={`${s.navLink} ${s.navLinkActive}`} onClick={goHome}>
                        <Home size={18} />
                        <span>Home</span>
                    </button>
                    <button type="button" className={s.navLink} onClick={goRecent}>
                        <History size={18} />
                        <span>Recent</span>
                    </button>
                    <button type="button" className={s.navLink} onClick={goTemplates}>
                        <LayoutTemplate size={18} />
                        <span>Templates</span>
                    </button>
                    <button type="button" className={s.navLink} onClick={goArchive}>
                        <Archive size={18} />
                        <span>Archive</span>
                    </button>

                    <div className={s.sideTree}>
                        <FolderTree
                            variant="home"
                            folders={folders}
                            pages={pages}
                            activePageId={null}
                            onSelectPage={(id) => openEditor(id)}
                            onNewFolder={handleNewFolder}
                            onNewPage={(folderId, title) => handleNewPage(folderId, title)}
                            onRenameFolder={handleRenameFolder}
                            onDeleteFolder={handleDeleteFolder}
                            onMovePageToFolder={handleMoveToFolder}
                            onMoveFolder={handleMoveFolder}
                        />
                    </div>
                </nav>
            </aside>

            {/* ── Main canvas ──────────────────────────────────────── */}
            <main className={s.main} ref={mainRef}>
                {/* ── Sticky header ───────────────────────────────── */}
                <header className={s.header}>
                    <div className={s.headerInner}>
                        <div className={s.headerTop}>
                            <div className={s.headerText}>
                                <p className={s.headerDate}>{todayLong()}</p>
                                <h1 className={s.greeting}>
                                    {getGreeting()}, <span className={s.name}>{firstName}</span>
                                </h1>
                                <p className={s.meta}>
                                    <span>{activePages.length} {activePages.length === 1 ? 'note' : 'notes'}</span>
                                    {folders.length > 0 && (
                                        <>
                                            <span className={s.dot}>•</span>
                                            <span>{folders.length} {folders.length === 1 ? 'folder' : 'folders'}</span>
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
                                <Plus size={18} />
                                <span>New note</span>
                            </button>
                        </div>

                        {/* ── Search bar ───────────────────────────── */}
                        <form className={s.searchBar} onSubmit={onSearchSubmit} role="search">
                            <Search className={s.searchIcon} size={18} aria-hidden="true" />
                            <input
                                className={s.searchInput}
                                placeholder="Search your notes, folders, and tags…"
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
                    </div>
                </header>

                {/* ── Scrollable content ──────────────────────────── */}
                <div className={s.content}>
                    {/* ── Empty state ─────────────────────────────── */}
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
                            {/* ── Jump back in ────────────────────── */}
                            {lastEdited && (
                                <section className={s.section}>
                                    <h2 className={s.sectionTitle}>
                                        <Clock size={16} /> Jump back in
                                    </h2>
                                    <button
                                        className={s.resumeCard}
                                        onClick={() => openEditor(lastEdited.id)}
                                        title="Resume editing"
                                    >
                                        <span className={s.resumeLeft}>
                                            <span className={s.resumeIcon} aria-hidden="true">
                                                {lastEdited.icon || <FileText size={20} />}
                                            </span>
                                            <span className={s.resumeBody}>
                                                <span className={s.resumeTitle}>
                                                    {lastEdited.title || 'Untitled'}
                                                </span>
                                                <span className={s.resumeMeta}>
                                                    Edited {relativeFromNow(lastEdited.updatedAt)}
                                                    {lastEditedFolder && (
                                                        <> • in {lastEditedFolder}</>
                                                    )}
                                                </span>
                                            </span>
                                        </span>
                                        <span className={s.resumeCta} aria-hidden="true">
                                            <ArrowUpRight size={20} />
                                        </span>
                                    </button>
                                </section>
                            )}

                            {/* ── Recent + Pinned ─────────────────── */}
                            <div className={s.twoCol} ref={recentRef}>
                                {otherRecent.length > 0 && (
                                    <section className={s.section}>
                                        <h2 className={s.sectionTitle}>
                                            <FileText size={16} /> Recent notes
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
                                                            {p.icon || <FileText size={16} />}
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
                                                <Pin size={16} /> Pinned
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

                            {/* ── Liked notes ─────────────────────── */}
                            {liked.length > 0 && (
                                <section className={s.section}>
                                    <h2 className={s.sectionTitle}>
                                        <Heart size={16} /> Liked
                                    </h2>
                                    <div className={s.likedGrid}>
                                        {liked.map(p => (
                                            <button
                                                key={p.id}
                                                className={s.likedCard}
                                                onClick={() => openEditor(p.id)}
                                                title={p.title}
                                            >
                                                <span className={s.likedIcon} aria-hidden="true">
                                                    {p.icon || <FileText size={16} />}
                                                </span>
                                                <span className={s.likedMain}>
                                                    <span className={s.likedTitle}>
                                                        {p.title || 'Untitled'}
                                                    </span>
                                                    <span className={s.likedMeta}>
                                                        {relativeFromNow(p.updatedAt)}
                                                    </span>
                                                </span>
                                                <span className={s.likedHeart} aria-hidden="true">
                                                    <Heart size={13} />
                                                </span>
                                            </button>
                                        ))}
                                    </div>
                                </section>
                            )}
                        </>
                    )}

                    {/* ── Templates (always shown) ───────────────── */}
                    <section className={s.section} ref={templatesRef}>
                        <h2 className={s.sectionTitle}>
                            <Plus size={16} /> Start from a template
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

                    {/* ── Tags ─────────────────────────────────────── */}
                    {tagCounts.length > 0 && (
                        <section className={s.section}>
                            <h2 className={s.sectionTitle}>
                                <Tag size={16} /> Tags
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
            </main>
        </div>
    );
}
