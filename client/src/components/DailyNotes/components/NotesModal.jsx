/* NotesModal — full-width editor with floating navigation
   (no permanent sidebar). Renders the EditorTopBar above the
   ModalEditor and mounts the PageSwitcherPopover + CommandPalette
   as portal-based overlays. */
import React from 'react';
import { createPortal } from 'react-dom';
import EditorTopBar from './EditorTopBar';
import ModalEditor from './ModalEditor';
import PageSwitcherPopover from './PageSwitcherPopover';
import CommandPalette from './CommandPalette';
import s from './NotesModal.module.css';

export default function NotesModal({ store, embedded = false }) {
  const {
    activePage, folders, wc,
    modalQuillRef,
    tagInput, setTagInput, showTagInput, setShowTagInput, tagInputRef,
    setMaximized,
    handleNewPage,
    handleDeletePage,
    handleTogglePin, handleToggleArchive, handleDuplicatePage,
    handleMoveToFolder,
    handleAddTag, handleRemoveTag,
    handleContentChange, handleTitleChange,
    handleRestoreSnapshot,
    switcherOpen, setSwitcherOpen,
    paletteOpen, setPaletteOpen,
  } = store;

  const onClose = () => setMaximized(false);

  const content = (
    <div
      className={embedded ? s.embeddedWrap : s.overlay}
      onClick={!embedded ? (e => { if (e.target === e.currentTarget) onClose(); }) : undefined}
    >
      <div className={`${s.modal} ${embedded ? s.modalEmbedded : ''}`}>
        <EditorTopBar
          store={store}
          embedded={embedded}
          onClose={!embedded ? onClose : undefined}
        />

        <div className={s.body}>
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

      {switcherOpen && (
        <PageSwitcherPopover
          store={store}
          onClose={() => setSwitcherOpen(false)}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          store={store}
          onClose={() => setPaletteOpen(false)}
        />
      )}
    </div>
  );

  if (embedded) return content;
  return createPortal(content, document.body);
}