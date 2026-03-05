/* ModalSidebar — left panel of the maximized modal */
import React from 'react';
import PageItem from './PageItem';
import FolderManager from './FolderManager';
import s from './ModalSidebar.module.css';

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
}) {
  const handleSelectPage = (page) => {
    onSelectPage(page);
    if (onMobileClose) onMobileClose();
  };

  return (
    <div className={`${s.sidebar} ${mobileOpen ? s.sidebarMobileOpen : ''}`}>
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
          <button className={s.searchClear} onClick={() => setSearchQuery('')}>×</button>
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
          {folders.map(f => <option key={f.id} value={f.id}>📁 {f.name}</option>)}
        </select>
      </div>

      {/* Archive toggle */}
      <label className={s.archiveToggle}>
        <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
        <span>Show archived</span>
      </label>

      {/* Page list */}
      <div className={s.list}>
        {processedPages.map(page => (
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
        {processedPages.length === 0 && (
          <div className={s.empty}>
            {searchQuery ? 'No pages match your search'
              : showArchived ? 'No archived pages'
              : 'No pages yet'}
          </div>
        )}
      </div>

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
    </div>
  );
}
