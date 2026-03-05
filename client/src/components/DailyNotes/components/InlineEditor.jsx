/* InlineEditor — expanded editor shown beneath the widget header */
import React from 'react';
import QuillEditor from './QuillEditor';
import s from './InlineEditor.module.css';

export default function InlineEditor({
  activePage,
  quillRef,
  folders,
  wc,
  onTitleChange,
  onContentChange,
  onMoveToFolder,
  onNewPage,
}) {
  if (!activePage) {
    return (
      <div className={s.empty}>
        <p>No pages yet</p>
        <button className="btn btn-primary btn-sm" onClick={onNewPage}>+ New page</button>
      </div>
    );
  }

  return (
    <div className={s.editor}>
      <input
        className={s.titleInput}
        value={activePage.title}
        onChange={onTitleChange}
        placeholder="Page title…"
      />

      {folders.length > 0 && (
        <div className={s.metaRow}>
          <select
            className={s.folderSelect}
            value={activePage.folderId || ''}
            onChange={e => onMoveToFolder(activePage.id, e.target.value || null)}
          >
            <option value="">No folder</option>
            {folders.map(f => <option key={f.id} value={f.id}>📁 {f.name}</option>)}
          </select>
        </div>
      )}

      <QuillEditor
        pageId={activePage.id}
        defaultContent={activePage.content}
        quillRef={quillRef}
        onChange={onContentChange}
        variant="inline"
      />

      <div className={s.wordCount}>
        {wc.words} words · {wc.chars} chars
      </div>
    </div>
  );
}
