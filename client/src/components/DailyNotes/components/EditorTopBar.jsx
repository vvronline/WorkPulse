/* ─────────────────────────────────────────────────────────
   EditorTopBar — replaces the modal sidebar.
   Holds: Home button, breadcrumbs, page-switcher trigger,
   command-palette trigger, new-page, and overflow menu.
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
    Search,
    Plus,
    LayoutTemplate,
    MoreHorizontal,
    X,
    Inbox,
    Command,
} from '../../../constants/icons';
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
                <button
                    className={s.kbdBtn}
                    onClick={() => setPaletteOpen(true)}
                    title="Search and run commands (Ctrl+K)"
                    aria-label="Open command palette"
                >
                    <Search size={13} />
                    <span className={s.kbdLabel}>Quick find</span>
                    <kbd className={s.kbd}>Ctrl K</kbd>
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
                                onClick={() => { setOverflowOpen(false); setPaletteOpen(true); }}
                            >
                                <span className={s.menuIcon}><Command size={15} /></span>
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
                        <X size={14} />
                    </button>
                )}
            </div>
        </div>
    );
}