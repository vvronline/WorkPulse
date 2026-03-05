/* NotesModal — full-screen portal overlay with sidebar + editor */
import React from 'react';
import { createPortal } from 'react-dom';
import ModalSidebar from './ModalSidebar';
import ModalEditor from './ModalEditor';
import s from './NotesModal.module.css';

export default function NotesModal({ store }) {
  const {
    activePage, activePageId, processedPages, folders, wc,
    savedFlash,
    searchRef, searchQuery, setSearchQuery,
    sortBy, handleSortChange,
    folderFilter, setFolderFilter,
    showArchived, setShowArchived,
    dragRef, dragOverId,
    renamingId, renameValue, setRenameValue, renameRef,
    pageMenu, setPageMenu, pageMenuRef,
    newFolderOpen, setNewFolderOpen,
    newFolderName, setNewFolderName,
    modalQuillRef,
    tagInput, setTagInput, showTagInput, setShowTagInput, tagInputRef,
    setMaximized, setActivePageId,
    handleNewPage, handleSelectPage,
    handleDeletePage,
    handleStartRename, handleCommitRename, setRenamingId,
    handleTogglePin, handleToggleArchive, handleDuplicatePage,
    handleMoveToFolder,
    handleAddTag, handleRemoveTag,
    handleNewFolder, handleDeleteFolder,
    handleDragStart, handleDragOver, handleDrop, handleDragEnd,
    handleContentChange, handleTitleChange,
    handleRestoreSnapshot,
    persist, pages,
  } = store;

  const folderName = (fid) => folders.find(f => f.id === fid)?.name || '';

  return createPortal(
    <div className={s.overlay} onClick={e => { if (e.target === e.currentTarget) setMaximized(false); }}>
      <div className={s.modal}>
        {/* Header */}
        <div className={s.header}>
          <div className={s.headerLeft}>
            <svg className={s.icon} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clipRule="evenodd"/>
            </svg>
            <span className={s.title}>Notes</span>
            {savedFlash && <span className={s.savedBadge}>✓ Saved</span>}
          </div>
          <div className={s.headerRight}>
            <span className={s.shortcutHint}>
              Ctrl+N new · Ctrl+S save · Ctrl+Shift+F search · Ctrl+D duplicate · Ctrl+P pin
            </span>
            <button className={s.newBtn} onClick={handleNewPage}>
              <svg viewBox="0 0 14 14" fill="currentColor">
                <path d="M7 1a1 1 0 011 1v4h4a1 1 0 010 2H8v4a1 1 0 01-2 0V8H2a1 1 0 010-2h4V2a1 1 0 011-1z"/>
              </svg>
              New page
            </button>
            <button className={s.closeBtn} onClick={() => setMaximized(false)} title="Close (Esc)">
              <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M2 2l10 10M12 2L2 12"/>
              </svg>
            </button>
          </div>
        </div>

        {/* Body */}
        <div className={s.body}>
          <ModalSidebar
            searchRef={searchRef}
            searchQuery={searchQuery} setSearchQuery={setSearchQuery}
            sortBy={sortBy} onSortChange={handleSortChange}
            folderFilter={folderFilter} setFolderFilter={setFolderFilter}
            showArchived={showArchived} setShowArchived={setShowArchived}
            folders={folders}
            processedPages={processedPages}
            activePageId={activePageId}
            dragRef={dragRef} dragOverId={dragOverId}
            renamingId={renamingId} renameValue={renameValue}
            setRenameValue={setRenameValue} renameRef={renameRef}
            pageMenu={pageMenu} setPageMenu={setPageMenu} pageMenuRef={pageMenuRef}
            newFolderOpen={newFolderOpen} setNewFolderOpen={setNewFolderOpen}
            newFolderName={newFolderName} setNewFolderName={setNewFolderName}
            onSelectPage={handleSelectPage}
            onDragStart={handleDragStart} onDragOver={handleDragOver}
            onDrop={handleDrop} onDragEnd={handleDragEnd}
            onCommitRename={handleCommitRename}
            onCancelRename={() => setRenamingId(null)}
            onStartRename={handleStartRename}
            onTogglePin={handleTogglePin}
            onDuplicate={handleDuplicatePage}
            onToggleArchive={handleToggleArchive}
            onMoveToFolder={handleMoveToFolder}
            onDeletePage={handleDeletePage}
            setActivePageId={setActivePageId}
            onNewFolder={handleNewFolder}
            onDeleteFolder={handleDeleteFolder}
            onNewPageInFolder={handleNewPage}
            folderName={folderName}
          />
          <ModalEditor
            activePage={activePage}
            folders={folders}
            wc={wc}
            modalQuillRef={modalQuillRef}
            tagInput={tagInput} setTagInput={setTagInput}
            showTagInput={showTagInput} setShowTagInput={setShowTagInput}
            tagInputRef={tagInputRef}
            onTitleChange={handleTitleChange}
            onContentChange={handleContentChange}
            onTogglePin={handleTogglePin}
            onDuplicate={handleDuplicatePage}
            onToggleArchive={handleToggleArchive}
            onDeletePage={handleDeletePage}
            onMoveToFolder={handleMoveToFolder}
            onAddTag={handleAddTag}
            onRemoveTag={handleRemoveTag}
            onNewPage={handleNewPage}
            onRestoreSnapshot={handleRestoreSnapshot}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
