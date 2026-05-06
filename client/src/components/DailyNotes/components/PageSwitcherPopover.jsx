/* ─────────────────────────────────────────────────────────
   PageSwitcherPopover — replaces the always-visible sidebar.
   A floating, modal-anchored panel containing search, sort,
   folder filter chips, archive toggle, and the page list.
   Reuses the existing PageItem + FolderManager components.
   ───────────────────────────────────────────────────────── */
import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { buildFolderTree } from '../notesUtils';
import PageItem from './PageItem';
import FolderManager from './FolderManager';
import s from './PageSwitcherPopover.module.css';

export default function PageSwitcherPopover({ store, onClose }) {
    const {
        folders, processedPages, activePageId,
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
    } = store;

    const inputRef = useRef(null);
    const panelRef = useRef(null);

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
                        <svg className={s.searchIcon} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <circle cx="7" cy="7" r="5" />
                            <path d="M11 11l3 3" />
                        </svg>
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
                        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                            <path d="M2 2l10 10M12 2L2 12" />
                        </svg>
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

                    <div className={s.chips} role="tablist" aria-label="Folder filter">
                        <button
                            className={`${s.chip} ${folderFilter === 'all' ? s.chipActive : ''}`}
                            onClick={() => setFolderFilter('all')}
                            role="tab"
                            aria-selected={folderFilter === 'all'}
                        >
                            All
                        </button>
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
                                📁 {f.name}
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

                {/* Page list */}
                <div className={s.list}>
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
                </div>

                {/* Footer actions */}
                <div className={s.footer}>
                    <button className={s.footerBtn} onClick={() => { handleNewPage(); onClose(); }}>
                        <svg viewBox="0 0 14 14" fill="currentColor"><path d="M7 1a1 1 0 011 1v4h4a1 1 0 010 2H8v4a1 1 0 01-2 0V8H2a1 1 0 010-2h4V2a1 1 0 011-1z" /></svg>
                        New page
                    </button>
                    <button className={`${s.footerBtn} ${s.footerBtnGhost}`} onClick={() => setNewFolderOpen(true)}>
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M2 5h5l1.5-2H14a1 1 0 011 1v7a1 1 0 01-1 1H2a1 1 0 01-1-1V4" />
                            <path d="M8 7v4M6 9h4" />
                        </svg>
                        New folder
                    </button>
                    <span className={s.footerHint}>Esc to close · Ctrl+Shift+O to toggle</span>
                </div>
            </div>
        </div>,
        document.body
    );
}