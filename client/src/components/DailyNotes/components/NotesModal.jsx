/* NotesModal — full-width editor with floating navigation
   (no permanent sidebar). Renders the EditorTopBar above the
   ModalEditor. PageSwitcherPopover + CommandPalette are mounted
   one level up (NotesPage) so they work on the Home view too. */
import React from 'react';
import { createPortal } from 'react-dom';
import EditorTopBar from './EditorTopBar';
import ModalEditor from './ModalEditor';
import s from './NotesModal.module.css';

export default function NotesModal({ store, embedded = false }) {
  const {
    activePage, pages, folders, wc,
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
    openEditor, setFolderFilter,
    handleSetPageIcon, handleSetPageProperties,
    handleToggleReadOnly, handleToggleReaction,
    handleNewSubPage,
    openPageLinkPicker, insertTocIntoEditor,
    drawioEditor, saveDrawioEditor, closeDrawioEditor, deleteDrawioBlock,
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
            pages={pages}
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
            onSelectPage={openEditor}
            onSelectFolder={(fid) => { setFolderFilter(fid || 'all'); }}
            onSetPageIcon={handleSetPageIcon}
            onSetPageProperties={handleSetPageProperties}
            onToggleReadOnly={handleToggleReadOnly}
            onToggleReaction={handleToggleReaction}
            onNewSubPage={handleNewSubPage}
            onPickPageLink={openPageLinkPicker}
            onInsertToc={insertTocIntoEditor}
            drawioEditor={drawioEditor}
            onDrawioSave={saveDrawioEditor}
            onDrawioCancel={closeDrawioEditor}
            onDeleteDiagram={deleteDrawioBlock}
          />
        </div>
      </div>

    </div>
  );

  if (embedded) return content;
  return createPortal(content, document.body);
}
