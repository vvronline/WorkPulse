/* ─────────────────────────────────────────────────────────
   PageSwitcherPopover — replaces the always-visible sidebar.
   A floating, modal-anchored panel containing search, sort,
   folder filter chips, archive toggle, and the page list.
   Reuses the existing PageItem + FolderManager components.
   ───────────────────────────────────────────────────────── */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { buildFolderTree } from '../notesUtils';
import { SMART_FOLDER_IDS } from '../useNotesFilters';
import PageItem from './PageItem';
import FolderManager from './FolderManager';
import PageTree from './PageTree';
import {
    Search,
    X,
    Plus,
    Folder,
    FolderPlus,
    Tag,
    CheckSquare,
    Clock,
    CalendarDays,
    ListTree,
} from '../../../constants/icons';
import s from './PageSwitcherPopover.module.css';

/* Smart-folder definitions surfaced as filter chips. */
const SMART_FOLDERS = [
    { id: SMART_FOLDER_IDS.TODAY, label: 'Today', icon: Clock, hint: 'Edited in the last 24 h' },
    { id: SMART_FOLDER_IDS.WEEK, label: 'This week', icon: CalendarDays, hint: 'Edited in the last 7 days' },
    { id: SMART_FOLDER_IDS.TODOS, label: 'Open todos', icon: CheckSquare, hint: 'Pages with checklist items' },
    { id: SMART_FOLDER_IDS.UNTAGGED, label: 'Untagged', icon: Tag, hint: 'Pages without any tags' },
];

export default function PageSwitcherPopover({ store, onClose }) {
    const {
        pages, folders, processedPages, activePageId,
        searchQuery, setSearchQuery,
        sortBy, handleSortChange,
        folderFilter, setFolderFilter,
        showArchived, setShowArchived,
        dragRef, dragOverId,
        renamingId, renameValue, setRenameValue, renameRef,
        pageMenu, setPageMenu, pageMenuRef,
        newFolderOpen, setNewFolderOpen,
        newFolderName, setNewFolderName,
        handleSelectPage,
        handleDragStart, handleDragOver, handleDrop, handleDragEnd,
        handleCommitRename, setRenamingId, handleStartRename,
        handleTogglePin, handleDuplicatePage, handleToggleArchive,
        handleMoveToFolder, handleDeletePage, setActivePageId,
        handleNewFolder, handleDeleteFolder,
        handleNewPage,
        handleNewSubPage,
    } = store;

    const inputRef = useRef(null);
    const panelRef = useRef(null);
    const [view, setView] = useState('list'); // 'list' | 'tree'

    // Auto-focus the search input on open
    useEffect(() => {
        const id = setTimeout(() => inputRef.current?.focus(), 30);
        return () => clearTimeout(id);
    }, []);

    // Esc closes; click outside closes; lock body scroll while open
    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        const onClick = (e) => {
            if (panelRef.current && !panelRef.current.contains(e.target)) onClose();
        };
        document.addEventListener('keydown', onKey);
        // mousedown so clicks inside controls aren't consumed before they fire
        document.addEventListener('mousedown', onClick);
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.removeEventListener('keydown', onKey);
            document.removeEventListener('mousedown', onClick);
            document.body.style.overflow = prev;
        };
    }, [onClose]);

    const closeAndSelect = (id) => {
        handleSelectPage(id);
        onClose();
    };

    const folderName = (fid) => {
        const f = folders.find(x => x.id === fid);
        return f ? f.name : '';
    };

    // Folder filter chips: All · Uncategorized · top-level folders
    const topFolders = buildFolderTree(folders);

    return createPortal(
        <div className={s.overlay}>
            <div ref={panelRef} className={s.panel} role="dialog" aria-label="Page switcher">
                {/* Header — search + close */}
                <div className={s.header}>
                    <div className={s.searchWrap}>
                        <Search className={s.searchIcon} size={16} aria-hidden="true" />
                        <input
                            ref={inputRef}
                            className={s.searchInput}
                            placeholder="Search pages, tags (#tag)…"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            aria-label="Search pages"
                        />
                        {searchQuery && (
                            <button className={s.searchClear} onClick={() => setSearchQuery('')} aria-label="Clear">×</button>
                        )}
                    </div>
                    <button className={s.closeBtn} onClick={onClose} title="Close (Esc)" aria-label="Close switcher">
                        <X size={14} />
                    </button>
                </div>

                {/* Filters row — sort + folder chips + archive toggle */}
                <div className={s.filters}>
                    <select
                        className={s.sortSelect}
                        value={sortBy}
                        onChange={(e) => handleSortChange(e.target.value)}
                        title="Sort by"
                    >
                        <option value="modified">Modified</option>
                        <option value="created">Created</option>
                        <option value="name">Name</option>
                        <option value="manual">Manual</option>
                    </select>
                    <div className={s.viewToggle} role="tablist" aria-label="View mode">
                        <button
                            className={`${s.viewBtn} ${view === 'list' ? s.viewBtnActive : ''}`}
                            onClick={() => setView('list')}
                            role="tab"
                            aria-selected={view === 'list'}
                            title="Flat list"
                        >List</button>
                        <button
                            className={`${s.viewBtn} ${view === 'tree' ? s.viewBtnActive : ''}`}
                            onClick={() => setView('tree')}
                            role="tab"
                            aria-selected={view === 'tree'}
                            title="Sub-page hierarchy"
                        ><ListTree size={11} style={{ verticalAlign: '-1px', marginRight: 3 }} />Tree</button>
                    </div>

                    <div className={s.chips} role="tablist" aria-label="Folder filter">
                        <button
                            className={`${s.chip} ${folderFilter === 'all' ? s.chipActive : ''}`}
                            onClick={() => setFolderFilter('all')}
                            role="tab"
                            aria-selected={folderFilter === 'all'}
                        >
                            All
                        </button>
                        {/* Smart folders — virtual filters that derive from page metadata */}
                        {SMART_FOLDERS.map(sf => {
                            const Icon = sf.icon;
                            return (
                                <button
                                    key={sf.id}
                                    className={`${s.chip} ${folderFilter === sf.id ? s.chipActive : ''}`}
                                    onClick={() => setFolderFilter(sf.id)}
                                    role="tab"
                                    aria-selected={folderFilter === sf.id}
                                    title={sf.hint}
                                >
                                    <Icon size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} />
                                    {sf.label}
                                </button>
                            );
                        })}
                        <button
                            className={`${s.chip} ${folderFilter === 'none' ? s.chipActive : ''}`}
                            onClick={() => setFolderFilter('none')}
                            role="tab"
                            aria-selected={folderFilter === 'none'}
                        >
                            Uncategorized
                        </button>
                        {topFolders.map(f => (
                            <button
                                key={f.id}
                                className={`${s.chip} ${folderFilter === f.id ? s.chipActive : ''}`}
                                onClick={() => setFolderFilter(f.id)}
                                style={{ paddingLeft: `${0.55 + f.depth * 0.4}rem` }}
                                role="tab"
                                aria-selected={folderFilter === f.id}
                                title={f.name}
                            >
                                <Folder size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} />
                                {f.name}
                            </button>
                        ))}
                    </div>

                    <label className={s.archiveToggle}>
                        <input
                            type="checkbox"
                            checked={showArchived}
                            onChange={(e) => setShowArchived(e.target.checked)}
                        />
                        <span>Archived</span>
                    </label>
                </div>

                {/* Folder management strip (collapsible) */}
                <FolderManager
                    folders={folders}
                    newFolderOpen={newFolderOpen}
                    setNewFolderOpen={setNewFolderOpen}
                    newFolderName={newFolderName}
                    setNewFolderName={setNewFolderName}
                    onNewFolder={handleNewFolder}
                    onDeleteFolder={handleDeleteFolder}
                    onNewPageInFolder={handleNewPage}
                />

                {/* Page list / tree */}
                <div className={s.list}>
                    {view === 'tree' ? (
                        <PageTree
                            pages={pages}
                            activePageId={activePageId}
                            onSelect={(id) => closeAndSelect(id)}
                            onAddChild={(pid) => { handleNewSubPage(pid); onClose(); }}
                            onAddRoot={() => { handleNewPage(); onClose(); }}
                        />
                    ) : (
                        <>
                            {(processedPages ?? []).map(page => (
                                <PageItem
                                    key={page.id}
                                    page={page}
                                    isActive={page.id === activePageId}
                                    isDragOver={dragOverId === page.id && dragRef.current !== page.id}
                                    isDragging={dragRef.current === page.id}
                                    folders={folders}
                                    folderName={folderName}
                                    renamingId={renamingId}
                                    renameValue={renameValue}
                                    setRenameValue={setRenameValue}
                                    renameRef={renameRef}
                                    pageMenu={pageMenu}
                                    setPageMenu={setPageMenu}
                                    pageMenuRef={pageMenuRef}
                                    onSelect={() => closeAndSelect(page.id)}
                                    onDragStart={handleDragStart}
                                    onDragOver={handleDragOver}
                                    onDrop={handleDrop}
                                    onDragEnd={handleDragEnd}
                                    onCommitRename={handleCommitRename}
                                    onCancelRename={() => setRenamingId(null)}
                                    onStartRename={handleStartRename}
                                    onTogglePin={handleTogglePin}
                                    onDuplicate={handleDuplicatePage}
                                    onToggleArchive={handleToggleArchive}
                                    onMoveToFolder={handleMoveToFolder}
                                    onDelete={handleDeletePage}
                                    setActivePageId={setActivePageId}
                                />
                            ))}
                            {(processedPages ?? []).length === 0 && (
                                <div className={s.empty}>
                                    {searchQuery
                                        ? 'No pages match your search'
                                        : showArchived
                                            ? 'No archived pages'
                                            : 'No pages yet'}
                                </div>
                            )}
                        </>
                    )}
                </div>

                {/* Footer actions */}
                <div className={s.footer}>
                    <button className={s.footerBtn} onClick={() => { handleNewPage(); onClose(); }}>
                        <Plus size={13} />
                        New page
                    </button>
                    <button className={`${s.footerBtn} ${s.footerBtnGhost}`} onClick={() => setNewFolderOpen(true)}>
                        <FolderPlus size={14} />
                        New folder
                    </button>
                    <span className={s.footerHint}>Esc to close · Ctrl+Shift+O to toggle</span>
                </div>
            </div>
        </div>,
        document.body
    );
}