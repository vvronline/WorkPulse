/* ModalEditor — right panel of the maximized modal */
import React, { useState } from 'react';
import { formatDate } from '../notesUtils';
import QuillEditor from './QuillEditor';
import TagEditor from './TagEditor';
import VersionHistory from './VersionHistory';
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
  onRestoreSnapshot,
}) {
  const [showHistory, setShowHistory] = useState(false);
  const [editorResetKey, setEditorResetKey] = useState(0);
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
          <button
            className={`${s.actBtn} ${showHistory ? s.actBtnActive : ''}`}
            onClick={() => setShowHistory(h => !h)}
            title="Version history"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" style={{width:13,height:13}}>
              <path d="M8 1a7 7 0 100 14A7 7 0 008 1zM0 8a8 8 0 1116 0A8 8 0 010 8zm8-4a.75.75 0 01.75.75v3.69l2.28 1.32a.75.75 0 01-.75 1.3l-2.5-1.44A.75.75 0 017.25 9V4.75A.75.75 0 018 4z"/>
            </svg>
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

      {/* Version history panel (replaces editor when open) */}
      {showHistory ? (
        <VersionHistory
          pageId={activePage.id}
          pageTitle={activePage.title}
          onRestore={(content, title) => {
            onRestoreSnapshot(content, title);
            setEditorResetKey(k => k + 1);
            setShowHistory(false);
          }}
          onClose={() => setShowHistory(false)}
        />
      ) : (
        <QuillEditor
          pageId={activePage.id}
          defaultContent={activePage.content}
          quillRef={modalQuillRef}
          onChange={onContentChange}
          variant="modal"
          resetKey={editorResetKey}
        />
      )}

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
