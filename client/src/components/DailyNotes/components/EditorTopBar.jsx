/* ─────────────────────────────────────────────────────────
   EditorTopBar — replaces the modal sidebar.
   Holds: Home button, breadcrumbs, page-switcher trigger,
   new-page button, templates dropdown, and overflow menu.
   ───────────────────────────────────────────────────────── */
import React, { useEffect, useRef, useState } from 'react';
import { TEMPLATES } from '../templates';
import { getFolderPath } from '../notesUtils';
import {
    Home,
    Folder,
    FileText,
    ChevronDown,
    Check,
    Plus,
    LayoutTemplate,
    MoreHorizontal,
    X,
    Inbox,
    Download,
    Zap,
    Sparkles,
    Clock,
    Upload,
    Link2,
} from '../../../constants/icons';
import ShareNoteModal from './ShareNoteModal';
import s from './EditorTopBar.module.css';

export default function EditorTopBar({ store, embedded, onClose }) {
    const {
        activePage, folders, savedFlash,
        openHome,
        setSwitcherOpen,
        setQuickCaptureOpen,
        handleNewPage,
        handleNewFromTemplate,
        handleOpenTodayJournal,
        handleExportPdf,
        handleExportMarkdown,
        handleExportHtml,
        handleExportAllMarkdown,
        handleImportMarkdownFiles,
        toggleAiPanel,
        toggleSuggestionsPanel,
        toggleActivityFeed,
        aiPanelOpen,
        suggestionsPanelOpen,
        activityFeedOpen,
        showArchived, setShowArchived,
    } = store;

    const importInputRef = useRef(null);

    const [overflowOpen, setOverflowOpen] = useState(false);
    const [tplOpen, setTplOpen] = useState(false);
    const [shareOpen, setShareOpen] = useState(false);
    const overflowRef = useRef(null);
    const tplRef = useRef(null);

    useEffect(() => {
        const onClick = (e) => {
            if (overflowRef.current && !overflowRef.current.contains(e.target)) setOverflowOpen(false);
            if (tplRef.current && !tplRef.current.contains(e.target)) setTplOpen(false);
        };
        document.addEventListener('mousedown', onClick);
        return () => document.removeEventListener('mousedown', onClick);
    }, []);

    const folderPath = activePage?.folderId ? getFolderPath(activePage.folderId, folders) : '';

    return (
        <div className={s.bar}>
            {/* Left cluster — Home + breadcrumbs */}
            <div className={s.left}>
                {embedded && (
                    <button
                        className={s.iconBtn}
                        onClick={openHome}
                        title="Back to home (Ctrl+H)"
                        aria-label="Back to notes home"
                    >
                        <Home size={13} />
                        <span>Home</span>
                    </button>
                )}

                <div className={s.crumbs} aria-label="Breadcrumbs">
                    {folderPath && (
                        <>
                            <button
                                className={s.crumb}
                                onClick={() => setSwitcherOpen(true)}
                                title={`Open switcher for ${folderPath}`}
                            >
                                <Folder size={13} className={s.crumbIcon} />
                                <span className={s.crumbText}>{folderPath}</span>
                            </button>
                            <span className={s.crumbSep}>›</span>
                        </>
                    )}
                    <button
                        className={`${s.crumb} ${s.crumbActive}`}
                        onClick={() => setSwitcherOpen(true)}
                        title="Switch page (Ctrl+Shift+O)"
                    >
                        <FileText size={13} className={s.crumbIcon} />
                        <span className={s.crumbText}>{activePage?.title || 'Untitled'}</span>
                        <ChevronDown size={11} className={s.chevron} />
                    </button>
                </div>

                {savedFlash && (
                    <span className={s.savedBadge}>
                        <Check size={11} style={{ verticalAlign: '-2px', marginRight: 3 }} />
                        Saved
                    </span>
                )}
            </div>

            {/* Right cluster — actions */}
            <div className={s.right}>
                {/* Hidden file input for Markdown import */}
                <input
                    ref={importInputRef}
                    type="file"
                    accept=".md,.markdown,.txt"
                    multiple
                    style={{ display: 'none' }}
                    onChange={(e) => {
                        handleImportMarkdownFiles?.(e.target.files);
                        e.target.value = '';
                    }}
                />

                {/* Tier 4 quick toggles */}
                <button
                    className={`${s.iconBtnSquare} ${aiPanelOpen ? s.iconBtnSquareActive : ''}`}
                    onClick={() => toggleAiPanel?.()}
                    title="AI assist"
                    aria-label="AI assist"
                >
                    <Sparkles size={14} />
                </button>
                <button
                    className={`${s.iconBtnSquare} ${suggestionsPanelOpen ? s.iconBtnSquareActive : ''}`}
                    onClick={() => toggleSuggestionsPanel?.()}
                    title="Smart suggestions"
                    aria-label="Smart suggestions"
                >
                    <Inbox size={14} />
                </button>
                <button
                    className={`${s.iconBtnSquare} ${activityFeedOpen ? s.iconBtnSquareActive : ''}`}
                    onClick={() => toggleActivityFeed?.()}
                    title="Activity feed"
                    aria-label="Activity feed"
                >
                    <Clock size={14} />
                </button>

                <button className={s.primaryBtn} onClick={handleNewPage} title="New page (Ctrl+N)">
                    <Plus size={13} />
                    <span>New page</span>
                </button>

                {/* Templates dropdown */}
                <div ref={tplRef} className={s.menuWrap}>
                    <button
                        className={s.iconBtn}
                        onClick={() => setTplOpen(p => !p)}
                        title="New from template"
                        aria-haspopup="menu"
                        aria-expanded={tplOpen}
                    >
                        <LayoutTemplate size={13} />
                        <span>Template</span>
                    </button>
                    {tplOpen && (
                        <div className={`${s.menu} ${s.menuRight}`} role="menu">
                            <div className={s.menuLabel}>New from template</div>
                            {TEMPLATES.map(t => {
                                const Icon = t.icon;
                                return (
                                    <button
                                        key={t.id}
                                        className={s.menuItem}
                                        role="menuitem"
                                        onClick={() => {
                                            setTplOpen(false);
                                            if (t.id === 'journal') handleOpenTodayJournal();
                                            else if (t.id === 'blank') handleNewPage();
                                            else handleNewFromTemplate(t.id);
                                        }}
                                    >
                                        <span className={s.menuIcon}>
                                            {Icon ? <Icon size={15} /> : null}
                                        </span>
                                        <span className={s.menuText}>
                                            <span className={s.menuTitle}>{t.name}</span>
                                            <span className={s.menuDesc}>{t.description}</span>
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>

                {/* Overflow menu */}
                <div ref={overflowRef} className={s.menuWrap}>
                    <button
                        className={s.iconBtnSquare}
                        onClick={() => setOverflowOpen(p => !p)}
                        title="More options"
                        aria-haspopup="menu"
                        aria-expanded={overflowOpen}
                    >
                        <MoreHorizontal size={15} />
                    </button>
                    {overflowOpen && (
                        <div className={`${s.menu} ${s.menuRight}`} role="menu">
                            <button
                                className={s.menuItem}
                                role="menuitem"
                                onClick={() => { setOverflowOpen(false); setSwitcherOpen(true); }}
                            >
                                <span className={s.menuIcon}><Inbox size={15} /></span>
                                <span className={s.menuText}>
                                    <span className={s.menuTitle}>Page switcher</span>
                                    <span className={s.menuDesc}>Browse and search all pages</span>
                                </span>
                                <kbd className={s.menuKbd}>Ctrl Shift O</kbd>
                            </button>
                            <button
                                className={s.menuItem}
                                role="menuitem"
                                onClick={() => { setOverflowOpen(false); setQuickCaptureOpen?.(true); }}
                            >
                                <span className={s.menuIcon}><Zap size={15} /></span>
                                <span className={s.menuText}>
                                    <span className={s.menuTitle}>Quick capture</span>
                                    <span className={s.menuDesc}>Append a note to your Inbox</span>
                                </span>
                                <kbd className={s.menuKbd}>Ctrl Shift N</kbd>
                            </button>
                            <div className={s.menuSep} />
                            <button
                                className={s.menuItem}
                                role="menuitem"
                                onClick={() => { setOverflowOpen(false); setShareOpen(true); }}
                                disabled={!activePage}
                            >
                                <span className={s.menuIcon}><Link2 size={15} /></span>
                                <span className={s.menuText}>
                                    <span className={s.menuTitle}>Share page…</span>
                                    <span className={s.menuDesc}>Create a public read-only link</span>
                                </span>
                            </button>
                            <div className={s.menuSep} />
                            <button
                                className={s.menuItem}
                                role="menuitem"
                                onClick={() => { setOverflowOpen(false); handleExportPdf?.(); }}
                                disabled={!activePage}
                            >
                                <span className={s.menuIcon}><Download size={15} /></span>
                                <span className={s.menuText}>
                                    <span className={s.menuTitle}>Download as PDF</span>
                                    <span className={s.menuDesc}>Save this page as a <code>.pdf</code> file</span>
                                </span>
                            </button>
                            <button
                                className={s.menuItem}
                                role="menuitem"
                                onClick={() => { setOverflowOpen(false); handleExportMarkdown?.(); }}
                                disabled={!activePage}
                            >
                                <span className={s.menuIcon}><Download size={15} /></span>
                                <span className={s.menuText}>
                                    <span className={s.menuTitle}>Download as Markdown</span>
                                    <span className={s.menuDesc}>Save this page as a <code>.md</code> file</span>
                                </span>
                            </button>
                            <button
                                className={s.menuItem}
                                role="menuitem"
                                onClick={() => { setOverflowOpen(false); handleExportHtml?.(); }}
                                disabled={!activePage}
                            >
                                <span className={s.menuIcon}><Download size={15} /></span>
                                <span className={s.menuText}>
                                    <span className={s.menuTitle}>Download as HTML</span>
                                    <span className={s.menuDesc}>Save this page as a self-contained <code>.html</code></span>
                                </span>
                            </button>
                            <button
                                className={s.menuItem}
                                role="menuitem"
                                onClick={() => { setOverflowOpen(false); handleExportAllMarkdown?.(); }}
                            >
                                <span className={s.menuIcon}><Download size={15} /></span>
                                <span className={s.menuText}>
                                    <span className={s.menuTitle}>Export all pages</span>
                                    <span className={s.menuDesc}>Bundle every page into one <code>.md</code></span>
                                </span>
                            </button>
                            <button
                                className={s.menuItem}
                                role="menuitem"
                                onClick={() => { setOverflowOpen(false); importInputRef.current?.click(); }}
                            >
                                <span className={s.menuIcon}><Upload size={15} /></span>
                                <span className={s.menuText}>
                                    <span className={s.menuTitle}>Import Markdown</span>
                                    <span className={s.menuDesc}>Create new pages from <code>.md</code> files</span>
                                </span>
                            </button>
                            <div className={s.menuSep} />
                            <label className={s.menuToggle}>
                                <input
                                    type="checkbox"
                                    checked={showArchived}
                                    onChange={(e) => setShowArchived(e.target.checked)}
                                />
                                <span>Show archived in switcher</span>
                            </label>
                        </div>
                    )}
                </div>

                {!embedded && onClose && (
                    <button className={s.iconBtnSquare} onClick={onClose} title="Close (Esc)" aria-label="Close">
                        <X size={14} />
                    </button>
                )}
            </div>

            <ShareNoteModal
                page={activePage}
                isOpen={shareOpen}
                onClose={() => setShareOpen(false)}
            />
        </div>
    );
}
