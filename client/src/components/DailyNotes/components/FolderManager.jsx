/* FolderManager — nested folder tree with create-subfolder + create-page actions */
import React, { useState } from 'react';
import { Folder } from 'lucide-react';
import { buildFolderTree } from '../notesUtils';
import s from './FolderManager.module.css';

function FolderNode({ folder, folders, onNewPageInFolder, onDeleteFolder, onNewFolder }) {
  const [expanded, setExpanded] = useState(true);
  const [creating, setCreating] = useState(false);  // 'folder' | 'page' | false
  const [subName, setSubName] = useState('');

  const children = folders.filter(f => f.parentId === folder.id);
  const hasChildren = children.length > 0;
  const indent = { paddingLeft: `${(folder.depth || 0) * 1}rem` };

  const handleCreate = () => {
    if (!subName.trim()) { setCreating(false); return; }
    if (creating === 'folder') {
      onNewFolder(folder.id, subName.trim());
    } else {
      onNewPageInFolder(folder.id, subName.trim());
    }
    setSubName('');
    setCreating(false);
  };

  return (
    <>
      <div className={s.folderItem} style={indent}>
        <button className={s.expandBtn} onClick={() => setExpanded(p => !p)} title={expanded ? 'Collapse' : 'Expand'}>
          {hasChildren ? (expanded ? '▾' : '▸') : '·'}
        </button>
        <span className={s.folderItemName} onClick={() => setExpanded(p => !p)}><Folder size={13} style={{marginRight:5,verticalAlign:'middle'}} />{folder.name}</span>
        <div className={s.folderItemActions}>
          <button className={s.folderAddBtn} onClick={() => { setCreating('folder'); setExpanded(true); }} title="New subfolder">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M2 5h5l1.5-2H14a1 1 0 011 1v8a1 1 0 01-1 1H2a1 1 0 01-1-1V4"/>
              <path d="M8 7v4M6 9h4"/>
            </svg>
          </button>
          <button className={s.folderAddBtn} onClick={() => { setCreating('page'); setExpanded(true); }} title={`New page in "${folder.name}"`}>
            +
          </button>
          <button className={s.folderDeleteBtn} onClick={() => onDeleteFolder(folder.id)} title="Delete folder">
            ×
          </button>
        </div>
      </div>

      {expanded && creating && (
        <div className={s.newSubRow} style={{ paddingLeft: `${((folder.depth || 0) + 1) * 1 + 0.25}rem` }}>
          <input
            className={s.newFolderInput}
            value={subName}
            onChange={e => setSubName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter')  handleCreate();
              if (e.key === 'Escape') { setCreating(false); setSubName(''); }
            }}
            placeholder={creating === 'folder' ? 'Subfolder name…' : 'Page title…'}
            autoFocus
          />
          <button className={s.newFolderOk} onClick={handleCreate}>✓</button>
        </div>
      )}

      {expanded && children
        .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
        .map(child => (
          <FolderNode
            key={child.id}
            folder={{ ...child, depth: (folder.depth || 0) + 1 }}
            folders={folders}
            onNewPageInFolder={onNewPageInFolder}
            onDeleteFolder={onDeleteFolder}
            onNewFolder={onNewFolder}
          />
        ))
      }
    </>
  );
}

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
  const rootFolders = folders
    .filter(f => !f.parentId)
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

  // Wrapper: onNewFolder from tree nodes passes (parentId, name)
  const handleTreeNewFolder = (parentId, name) => {
    // Temporarily set the name and call with parentId
    onNewFolder(parentId, name);
  };

  // Wrapper: onNewPageInFolder from tree nodes passes (folderId, title)
  const handleTreeNewPage = (folderId, title) => {
    onNewPageInFolder(folderId, title);
  };

  return (
    <div className={s.sidebarFooter}>
      {folders.length > 0 && (
        <div className={s.folderList}>
          <span className={s.folderListLabel}>Folders</span>
          {rootFolders.map(f => (
            <FolderNode
              key={f.id}
              folder={{ ...f, depth: 0 }}
              folders={folders}
              onNewPageInFolder={handleTreeNewPage}
              onDeleteFolder={onDeleteFolder}
              onNewFolder={handleTreeNewFolder}
            />
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
              if (e.key === 'Enter')  onNewFolder(null);
              if (e.key === 'Escape') setNewFolderOpen(false);
            }}
            placeholder="Folder name…"
            autoFocus
          />
          <button className={s.newFolderOk} onClick={() => onNewFolder(null)}>✓</button>
        </div>
      ) : (
        <button className={s.newFolderBtn} onClick={() => setNewFolderOpen(true)}>
          + New Folder
        </button>
      )}
    </div>
  );
}
