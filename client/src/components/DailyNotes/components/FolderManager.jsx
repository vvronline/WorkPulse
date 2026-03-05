/* FolderManager — folder list + create-folder UI in the sidebar footer */
import React from 'react';
import s from './FolderManager.module.css';

export default function FolderManager({
  folders,
  newFolderOpen,
  setNewFolderOpen,
  newFolderName,
  setNewFolderName,
  onNewFolder,
  onDeleteFolder,
  onNewPageInFolder,
}) {
  return (
    <div className={s.sidebarFooter}>
      {folders.length > 0 && (
        <div className={s.folderList}>
          <span className={s.folderListLabel}>Folders</span>
          {folders.map(f => (
            <div key={f.id} className={s.folderItem}>
              <span className={s.folderItemName}>📁 {f.name}</span>
              <div className={s.folderItemActions}>
                <button
                  className={s.folderAddBtn}
                  onClick={() => onNewPageInFolder(f.id)}
                  title={`New page in "${f.name}"`}
                >
                  +
                </button>
                <button
                  className={s.folderDeleteBtn}
                  onClick={() => onDeleteFolder(f.id)}
                  title="Delete folder"
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {newFolderOpen ? (
        <div className={s.newFolderRow}>
          <input
            className={s.newFolderInput}
            value={newFolderName}
            onChange={e => setNewFolderName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter')  onNewFolder();
              if (e.key === 'Escape') setNewFolderOpen(false);
            }}
            placeholder="Folder name…"
            autoFocus
          />
          <button className={s.newFolderOk} onClick={onNewFolder}>✓</button>
        </div>
      ) : (
        <button className={s.newFolderBtn} onClick={() => setNewFolderOpen(true)}>
          + New Folder
        </button>
      )}
    </div>
  );
}
