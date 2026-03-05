/* PageContextMenu — ⋯ dropdown for a single page item in the sidebar */
import React from 'react';
import s from './PageContextMenu.module.css';

export default function PageContextMenu({
  page,
  folders,
  pageMenuRef,
  onRename,
  onTogglePin,
  onDuplicate,
  onToggleArchive,
  onMoveToFolder,
  onDelete,
  setPageMenu,
}) {
  return (
    <div className={s.ctxMenu} ref={pageMenuRef}>
      <button className={s.ctxItem} onClick={() => { onRename(page); setPageMenu(null); }}>
        ✏️ Rename
      </button>
      <button className={s.ctxItem} onClick={() => onTogglePin(page.id)}>
        {page.pinned ? '📌 Unpin' : '📌 Pin to top'}
      </button>
      <button className={s.ctxItem} onClick={() => onDuplicate(page.id)}>
        📋 Duplicate
      </button>
      <button className={s.ctxItem} onClick={() => onToggleArchive(page.id)}>
        {page.archived ? '📤 Unarchive' : '📦 Archive'}
      </button>

      {folders.length > 0 && (
        <div className={s.ctxFolder}>
          <span className={s.ctxFolderLabel}>Move to:</span>
          <button
            className={`${s.ctxItem} ${s.ctxSmall}`}
            onClick={() => onMoveToFolder(page.id, null)}
          >
            — None
          </button>
          {folders.map(f => (
            <button
              key={f.id}
              className={`${s.ctxItem} ${s.ctxSmall} ${page.folderId === f.id ? s.ctxActive : ''}`}
              onClick={() => onMoveToFolder(page.id, f.id)}
            >
              📁 {f.name}
            </button>
          ))}
        </div>
      )}

      <div className={s.ctxDivider} />
      <button
        className={`${s.ctxItem} ${s.ctxDanger}`}
        onClick={() => { setPageMenu(null); onDelete(); }}
      >
        🗑️ Delete
      </button>
    </div>
  );
}
