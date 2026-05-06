/* ─────────────────────────────────────────────────────────
   EditorTopBar — replaces the modal sidebar.
   Holds: Home button, breadcrumbs, page-switcher trigger,
   command-palette trigger, new-page, and overflow menu.
   ───────────────────────────────────────────────────────── */
import React, { useEffect, useRef, useState } from 'react';
import { TEMPLATES } from '../templates';
import { getFolderPath } from '../notesUtils';
import s from './EditorTopBar.module.css';

export default function EditorTopBar({ store, embedded, onClose }) {
    const {
        activePage, folders, savedFlash,
        openHome,
        setSwitcherOpen,
        setPaletteOpen,
        handleNewPage,
        handleNewFromTemplate,
        handleOpenTodayJournal,
        showArchived, setShowArchived,
    } = store;

    const [overflowOpen, setOverflowOpen] = useState(false);
    const [tplOpen, setTplOpen] = useState(false);
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
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M2 7l6-5 6 5" />
                            <path d="M4 6.5V13a1 1 0 001 1h2.5v-4h1V14H11a1 1 0 001-1V6.5" />
                        </svg>
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
                                <span className={s.crumbIcon}>📁</span>
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
                        <span className={s.crumbIcon}>📄</span>
                        <span className={s.crumbText}>{activePage?.title || 'Untitled'}</span>
                        <svg className={s.chevron} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 4.5l3 3 3-3" />
                        </svg>
                    </button>
                </div>

                {savedFlash && <span className={s.savedBadge}>✓ Saved</span>}
            </div>

            {/* Right cluster — actions */}
            <div className={s.right}>
                <button
                    className={s.kbdBtn}
                    onClick={() => setPaletteOpen(true)}
                    title="Search and run commands (Ctrl+K)"
                    aria-label="Open command palette"
                >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="7" cy="7" r="5" />
                        <path d="M11 11l3 3" />
                    </svg>
                    <span className={s.kbdLabel}>Quick find</span>
                    <kbd className={s.kbd}>Ctrl K</kbd>
                </button>

                <button className={s.primaryBtn} onClick={handleNewPage} title="New page (Ctrl+N)">
                    <svg viewBox="0 0 14 14" fill="currentColor">
                        <path d="M7 1a1 1 0 011 1v4h4a1 1 0 010 2H8v4a1 1 0 01-2 0V8H2a1 1 0 010-2h4V2a1 1 0 011-1z" />
                    </svg>
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
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
                            <path d="M2.5 6h11" />
                            <path d="M6 6v7.5" />
                        </svg>
                        <span>Template</span>
                    </button>
                    {tplOpen && (
                        <div className={s.menu} role="menu">
                            <div className={s.menuLabel}>New from template</div>
                            {TEMPLATES.map(t => (
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
                                    <span className={s.menuIcon}>{t.icon}</span>
                                    <span className={s.menuText}>
                                        <span className={s.menuTitle}>{t.name}</span>
                                        <span className={s.menuDesc}>{t.description}</span>
                                    </span>
                                </button>
                            ))}
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
                        <svg viewBox="0 0 16 16" fill="currentColor">
                            <circle cx="3.5" cy="8" r="1.4" />
                            <circle cx="8" cy="8" r="1.4" />
                            <circle cx="12.5" cy="8" r="1.4" />
                        </svg>
                    </button>
                    {overflowOpen && (
                        <div className={`${s.menu} ${s.menuRight}`} role="menu">
                            <button
                                className={s.menuItem}
                                role="menuitem"
                                onClick={() => { setOverflowOpen(false); setSwitcherOpen(true); }}
                            >
                                <span className={s.menuIcon}>🗂</span>
                                <span className={s.menuText}>
                                    <span className={s.menuTitle}>Page switcher</span>
                                    <span className={s.menuDesc}>Browse and search all pages</span>
                                </span>
                                <kbd className={s.menuKbd}>Ctrl Shift O</kbd>
                            </button>
                            <button
                                className={s.menuItem}
                                role="menuitem"
                                onClick={() => { setOverflowOpen(false); setPaletteOpen(true); }}
                            >
                                <span className={s.menuIcon}>⌘</span>
                                <span className={s.menuText}>
                                    <span className={s.menuTitle}>Command palette</span>
                                    <span className={s.menuDesc}>Search pages and actions</span>
                                </span>
                                <kbd className={s.menuKbd}>Ctrl K</kbd>
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
                        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                            <path d="M2 2l10 10M12 2L2 12" />
                        </svg>
                    </button>
                )}
            </div>
        </div>
    );
}