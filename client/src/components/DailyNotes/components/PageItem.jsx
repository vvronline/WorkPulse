/* PageItem — a single row in the modal sidebar page list */
import React from 'react';
import { formatDate } from '../notesUtils';
import TagDots from './TagDots';
import PageContextMenu from './PageContextMenu';
import s from './PageItem.module.css';

export default function PageItem({
  page,
  isActive,
  isDragOver,
  isDragging,
  folders,
  folderName,
  renamingId,
  renameValue,
  setRenameValue,
  renameRef,
  pageMenu,
  setPageMenu,
  pageMenuRef,
  onSelect,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onCommitRename,
  onCancelRename,
  onStartRename,
  onTogglePin,
  onDuplicate,
  onToggleArchive,
  onMoveToFolder,
  onDelete,
  setActivePageId,
}) {
  return (
    <div
      className={[
        s.pageItem,
        isActive     ? s.pageItemActive    : '',
        page.archived ? s.pageItemArchived  : '',
        isDragOver   ? s.dragOver           : '',
        isDragging   ? s.dragging           : '',
      ].join(' ')}
      onClick={() => onSelect(page.id)}
      draggable
      onDragStart={e => onDragStart(e, page.id)}
      onDragOver={e => onDragOver(e, page.id)}
      onDrop={e => onDrop(e, page.id)}
      onDragEnd={onDragEnd}
    >
      <div className={s.pageRow}>
        {page.pinned && <span className={s.pinIcon} title="Pinned">📌</span>}
        <svg className={s.pageIcon} viewBox="0 0 14 14" fill="currentColor">
          <path d="M3 2a1 1 0 011-1h4.586a1 1 0 01.707.293l2.414 2.414A1 1 0 0112 4.414V12a1 1 0 01-1 1H4a1 1 0 01-1-1V2zm2 5a.5.5 0 000 1h4a.5.5 0 000-1H5zm0 2a.5.5 0 000 1h4a.5.5 0 000-1H5z"/>
        </svg>

        <div className={s.pageInfo}>
          {renamingId === page.id ? (
            <input
              ref={renameRef}
              className={s.renameInput}
              value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              onBlur={onCommitRename}
              onKeyDown={e => {
                if (e.key === 'Enter') onCommitRename();
                if (e.key === 'Escape') onCancelRename();
              }}
              onClick={e => e.stopPropagation()}
            />
          ) : (
            <span
              className={s.pageName}
              onDoubleClick={e => { e.stopPropagation(); onStartRename(page); }}
              title="Double-click to rename"
            >
              {page.title}
            </span>
          )}
          <div className={s.pageMeta}>
            <span className={s.pageDate}>{formatDate(page.updatedAt)}</span>
            {page.folderId && (
              <span className={s.pageFolder}>📁 {folderName(page.folderId)}</span>
            )}
            <TagDots tags={page.tags} />
          </div>
        </div>

        <button
          className={s.menuBtn}
          onClick={e => { e.stopPropagation(); setPageMenu(pageMenu === page.id ? null : page.id); }}
          title="More actions"
        >
          ⋯
        </button>
      </div>

      {pageMenu === page.id && (
        <PageContextMenu
          page={page}
          folders={folders}
          pageMenuRef={pageMenuRef}
          onRename={onStartRename}
          onTogglePin={onTogglePin}
          onDuplicate={onDuplicate}
          onToggleArchive={onToggleArchive}
          onMoveToFolder={onMoveToFolder}
          onDelete={() => { setActivePageId(page.id); onDelete(); }}
          setPageMenu={setPageMenu}
        />
      )}
    </div>
  );
}
