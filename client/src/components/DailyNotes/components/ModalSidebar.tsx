/* eslint-disable @typescript-eslint/no-explicit-any */
/* ModalSidebar — left panel of the maximized modal */
import React from "react";
import PageItem from "./PageItem";
import FolderManager from "./FolderManager";
import { buildFolderTree } from "../notesUtils";
import s from "./ModalSidebar.module.css";
import type { NoteFolder } from "../notesUtils";

interface ModalSidebarProps {
    searchRef: React.RefObject<any>;
    searchQuery: string;
    setSearchQuery: (v: string) => void;
    sortBy: string;
    onSortChange: (v: string) => void;
    folderFilter: string;
    setFolderFilter: (v: string) => void;
    showArchived: boolean;
    setShowArchived: (v: boolean) => void;
    folders: NoteFolder[];
    processedPages?: any[];
    activePageId: any;
    dragRef: React.MutableRefObject<any>;
    dragOverId: any;
    renamingId: any;
    renameValue: string;
    setRenameValue: (v: string) => void;
    renameRef: React.RefObject<any>;
    pageMenu: any;
    setPageMenu: (v: any) => void;
    pageMenuRef: React.RefObject<any>;
    newFolderOpen: boolean;
    setNewFolderOpen: (v: boolean) => void;
    newFolderName: string;
    setNewFolderName: (v: string) => void;
    onSelectPage: (page: any) => void;
    onDragStart: (...args: any[]) => void;
    onDragOver: (...args: any[]) => void;
    onDrop: (...args: any[]) => void;
    onDragEnd: (...args: any[]) => void;
    onCommitRename: (...args: any[]) => void;
    onCancelRename: (...args: any[]) => void;
    onStartRename: (...args: any[]) => void;
    onTogglePin: (...args: any[]) => void;
    onDuplicate: (...args: any[]) => void;
    onToggleArchive: (...args: any[]) => void;
    onMoveToFolder: (...args: any[]) => void;
    onDeletePage: (...args: any[]) => void;
    setActivePageId: (...args: any[]) => void;
    onNewFolder: (...args: any[]) => void;
    onDeleteFolder: (...args: any[]) => void;
    onNewPageInFolder: (...args: any[]) => void;
    folderName: any;
    mobileOpen?: boolean;
    onMobileClose?: () => void;
}

export default function ModalSidebar({
    searchRef,
    searchQuery, setSearchQuery,
    sortBy, onSortChange,
    folderFilter, setFolderFilter,
    showArchived, setShowArchived,
    folders,
    processedPages,
    activePageId,
    dragRef,
    dragOverId,
    renamingId, renameValue, setRenameValue, renameRef,
    pageMenu, setPageMenu, pageMenuRef,
    newFolderOpen, setNewFolderOpen,
    newFolderName, setNewFolderName,
    onSelectPage,
    onDragStart, onDragOver, onDrop, onDragEnd,
    onCommitRename,
    onCancelRename,
    onStartRename,
    onTogglePin,
    onDuplicate,
    onToggleArchive,
    onMoveToFolder,
    onDeletePage,
    setActivePageId,
    onNewFolder,
    onDeleteFolder,
    onNewPageInFolder,
    folderName,
    mobileOpen,
    onMobileClose,
}: ModalSidebarProps) {
    const handleSelectPage = (page: any) => {
        onSelectPage(page);
        if (onMobileClose) onMobileClose();
    };

    return (
        <div className={`${s.sidebar} ${mobileOpen ? s.sidebarMobileOpen : ""}`}>
            {/* Search */}
            <div className={s.searchWrap}>
                <input
                    ref={searchRef}
                    className={s.searchInput}
                    placeholder="Search…"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                />
                {searchQuery && (
                    <button className={s.searchClear} onClick={() => setSearchQuery("")}>×</button>
                )}
            </div>

            {/* Sort + folder filter */}
            <div className={s.controls}>
                <select className={s.select} value={sortBy} onChange={e => onSortChange(e.target.value)} title="Sort by">
                    <option value="modified">Modified</option>
                    <option value="created">Created</option>
                    <option value="name">Name</option>
                    <option value="manual">Manual</option>
                </select>
                <select className={s.select} value={folderFilter} onChange={e => setFolderFilter(e.target.value)} title="Filter folder">
                    <option value="all">All folders</option>
                    <option value="none">Uncategorized</option>
                    {buildFolderTree(folders).map((f: any) => (
                        <option key={f.id} value={f.id}>{"\u00A0\u00A0".repeat(f.depth)}{f.name}</option>
                    ))}
                </select>
            </div>

            {/* Archive toggle */}
            <label className={s.archiveToggle}>
                <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
                <span>Show archived</span>
            </label>

            {/* Folder management */}
            <FolderManager
                folders={folders}
                newFolderOpen={newFolderOpen}
                setNewFolderOpen={setNewFolderOpen}
                newFolderName={newFolderName}
                setNewFolderName={setNewFolderName}
                onNewFolder={onNewFolder}
                onDeleteFolder={onDeleteFolder}
                onNewPageInFolder={onNewPageInFolder}
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
                        onSelect={handleSelectPage}
                        onDragStart={onDragStart}
                        onDragOver={onDragOver}
                        onDrop={onDrop}
                        onDragEnd={onDragEnd}
                        onCommitRename={onCommitRename}
                        onCancelRename={onCancelRename}
                        onStartRename={onStartRename}
                        onTogglePin={onTogglePin}
                        onDuplicate={onDuplicate}
                        onToggleArchive={onToggleArchive}
                        onMoveToFolder={onMoveToFolder}
                        onDelete={onDeletePage}
                        setActivePageId={setActivePageId}
                    />
                ))}
                {(processedPages ?? []).length === 0 && (
                    <div className={s.empty}>
                        {searchQuery ? "No pages match your search"
                            : showArchived ? "No archived pages"
                                : "No pages yet"}
                    </div>
                )}
            </div>
        </div>
    );
}