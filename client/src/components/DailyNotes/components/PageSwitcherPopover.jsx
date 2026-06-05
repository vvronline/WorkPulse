/* ─────────────────────────────────────────────────────────
   PageSwitcherPopover — the single, simple place to navigate
   and organize notes. A floating panel with:
     1. Search (typing shows flat matching results)
     2. A unified, drag-friendly Folders & notes tree
     3. Footer quick actions (New note / New folder)

   Deliberately minimal: no sort dropdowns, no view toggles,
   no filter chips, no separate folder strip — the folder tree
   itself IS the structure.
   ───────────────────────────────────────────────────────── */
import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import PageItem from './PageItem';
import FolderTree from './FolderTree';
import {
    Search,
    X,
    Plus,
} from '../../../constants/icons';
import s from './PageSwitcherPopover.module.css';

export default function PageSwitcherPopover({ store, onClose }) {
    const {
        pages, folders, processedPages, activePageId,
        searchQuery, setSearchQuery,
        showArchived, setShowArchived,
        dragRef, dragOverId,
        renamingId, renameValue, setRenameValue, renameRef,
        pageMenu, setPageMenu, pageMenuRef,
        handleSelectPage,
        handleDragStart, handleDragOver, handleDrop, handleDragEnd,
        handleCommitRename, setRenamingId, handleStartRename,
        handleTogglePin, handleDuplicatePage, handleToggleArchive,
        handleMoveToFolder, handleDeletePage, setActivePageId,
        handleNewFolder, handleDeleteFolder, handleRenameFolder, handleMoveFolder,
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

    const searching = !!searchQuery.trim();

    return createPortal(
        <div className={s.overlay}>
            <div ref={panelRef} className={s.panel} role="dialog" aria-label="Notes navigator">
                {/* Header — search + close */}
                <div className={s.header}>
                    <div className={s.searchWrap}>
                        <Search className={s.searchIcon} size={16} aria-hidden="true" />
                        <input
                            ref={inputRef}
                            className={s.searchInput}
                            placeholder="Search notes…  (type # to search tags)"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            aria-label="Search notes"
                        />
                        {searchQuery && (
                            <button className={s.searchClear} onClick={() => setSearchQuery('')} aria-label="Clear">×</button>
                        )}
                    </div>
                    <button className={s.closeBtn} onClick={onClose} title="Close (Esc)" aria-label="Close">
                        <X size={14} />
                    </button>
                </div>

                {/* Body — search results OR the unified folder tree */}
                {searching ? (
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
                            <div className={s.empty}>No notes match “{searchQuery.trim()}”.</div>
                        )}
                    </div>
                ) : (
                    <div className={s.folderListWrap}>
                        <FolderTree
                            folders={folders}
                            pages={pages}
                            activePageId={activePageId}
                            onSelectPage={(id) => closeAndSelect(id)}
                            onNewFolder={(parentId, name) => handleNewFolder(parentId, name)}
                            onNewPage={(folderId, title) => { handleNewPage(folderId, title); onClose(); }}
                            onRenameFolder={handleRenameFolder}
                            onDeleteFolder={handleDeleteFolder}
                            onMovePageToFolder={handleMoveToFolder}
                            onMoveFolder={handleMoveFolder}
                        />
                    </div>
                )}

                {/* Footer actions */}
                <div className={s.footer}>
                    <button className={s.footerBtn} onClick={() => { handleNewPage(); onClose(); }}>
                        <Plus size={13} />
                        New note
                    </button>
                    <label className={s.archiveToggle}>
                        <input
                            type="checkbox"
                            checked={showArchived}
                            onChange={(e) => setShowArchived(e.target.checked)}
                        />
                        <span>Show archived</span>
                    </label>
                    <span className={s.footerHint}>Esc to close</span>
                </div>
            </div>
        </div>,
        document.body
    );
}