/* ModalEditor — right panel of the maximized modal */
import React, { useState } from 'react';
import { formatDate, buildFolderTree } from '../notesUtils';
import QuillEditor from './QuillEditor';
import TagEditor from './TagEditor';
import VersionHistory from './VersionHistory';
import { Pin, Copy, ArchiveRestore, Archive, Trash2, History } from '../../../constants/icons';
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
          ><Pin size={13} /></button>
          <button className={s.actBtn} onClick={() => onDuplicate(activePage.id)} title="Duplicate"><Copy size={13} /></button>
          <button
            className={s.actBtn}
            onClick={() => onToggleArchive(activePage.id)}
            title={activePage.archived ? 'Unarchive' : 'Archive'}
          >
            {activePage.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
          </button>
          <button
            className={`${s.actBtn} ${showHistory ? s.actBtnActive : ''}`}
            onClick={() => setShowHistory(h => !h)}
            title="Version history"
            aria-label="Version history"
          >
            <History size={13} />
          </button>
          <button className={`${s.actBtn} ${s.actBtnDanger}`} onClick={onDeletePage} title="Delete"><Trash2 size={13} /></button>
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
          {buildFolderTree(folders).map(f => (
            <option key={f.id} value={f.id}>{'\u00A0\u00A0'.repeat(f.depth)}{f.name}</option>
          ))}
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

      {/* Editor / version-history scroll area */}
      <div className={s.editorScroll}>
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
      </div>

      {/* Word count footer */}
      <div className={s.wordCount}>
        <div className={s.wordCountInner}>
          <span>{wc.words} words · {wc.chars} chars</span>
          {activePage.createdAt && (
            <span className={s.wordCountMeta}>· Created {formatDate(activePage.createdAt)}</span>
          )}
          {activePage.updatedAt && (
            <span className={s.wordCountMeta}>· Edited {formatDate(activePage.updatedAt)}</span>
          )}
        </div>
      </div>
    </div>
  );
}
