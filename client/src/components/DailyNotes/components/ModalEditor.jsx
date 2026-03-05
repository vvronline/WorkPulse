/* ModalEditor — right panel of the maximized modal */
import React from 'react';
import { formatDate } from '../notesUtils';
import QuillEditor from './QuillEditor';
import TagEditor from './TagEditor';
import s from './ModalEditor.module.css';

export default function ModalEditor({
  activePage,
  folders,
  wc,
  modalQuillRef,
  tagInput, setTagInput,
  showTagInput, setShowTagInput,
  tagInputRef,
  onTitleChange,
  onContentChange,
  onTogglePin,
  onDuplicate,
  onToggleArchive,
  onDeletePage,
  onMoveToFolder,
  onAddTag,
  onRemoveTag,
  onNewPage,
}) {
  if (!activePage) {
    return (
      <div className={s.editorArea}>
        <div className={s.empty}>
          <p>No pages yet</p>
          <button className="btn btn-primary btn-sm" onClick={onNewPage}>+ New page</button>
        </div>
      </div>
    );
  }

  return (
    <div className={s.editorArea}>
      {/* Title + action buttons */}
      <div className={s.titleRow}>
        <input
          className={s.titleInput}
          value={activePage.title}
          onChange={onTitleChange}
          placeholder="Page title…"
        />
        <div className={s.actions}>
          <button
            className={`${s.actBtn} ${activePage.pinned ? s.actBtnActive : ''}`}
            onClick={() => onTogglePin(activePage.id)}
            title={activePage.pinned ? 'Unpin' : 'Pin to top'}
          >📌</button>
          <button className={s.actBtn} onClick={() => onDuplicate(activePage.id)} title="Duplicate">📋</button>
          <button
            className={s.actBtn}
            onClick={() => onToggleArchive(activePage.id)}
            title={activePage.archived ? 'Unarchive' : 'Archive'}
          >
            {activePage.archived ? '📤' : '📦'}
          </button>
          <button className={`${s.actBtn} ${s.actBtnDanger}`} onClick={onDeletePage} title="Delete">🗑️</button>
        </div>
      </div>

      {/* Folder + tag row */}
      <div className={s.metaRow}>
        <select
          className={s.folderSelect}
          value={activePage.folderId || ''}
          onChange={e => onMoveToFolder(activePage.id, e.target.value || null)}
        >
          <option value="">No folder</option>
          {folders.map(f => <option key={f.id} value={f.id}>📁 {f.name}</option>)}
        </select>
        <TagEditor
          tags={activePage.tags || []}
          tagInput={tagInput}
          setTagInput={setTagInput}
          showTagInput={showTagInput}
          setShowTagInput={setShowTagInput}
          tagInputRef={tagInputRef}
          onAddTag={onAddTag}
          onRemoveTag={onRemoveTag}
          pageId={activePage.id}
        />
      </div>

      {/* Quill */}
      <QuillEditor
        pageId={activePage.id}
        defaultContent={activePage.content}
        quillRef={modalQuillRef}
        onChange={onContentChange}
        variant="modal"
      />

      {/* Word count */}
      <div className={s.wordCount}>
        {wc.words} words · {wc.chars} chars
        {activePage.createdAt && (
          <span className={s.wordCountMeta}> · Created {formatDate(activePage.createdAt)}</span>
        )}
      </div>
    </div>
  );
}
