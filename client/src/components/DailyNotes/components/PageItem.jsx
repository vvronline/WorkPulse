/* PageItem — a single row in the modal sidebar page list */
import React from 'react';
import { Pin, FolderOpen, FileText, MoreHorizontal } from '../../../constants/icons';
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
        {page.pinned && <span className={s.pinIcon} title="Pinned"><Pin size={12} /></span>}
        <FileText className={s.pageIcon} size={13} aria-hidden="true" />

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
              <span className={s.pageFolder}><FolderOpen size={11} style={{marginRight:3,verticalAlign:'middle'}} />{folderName(page.folderId)}</span>
            )}
            <TagDots tags={page.tags} />
          </div>
        </div>

        <button
          className={s.menuBtn}
          onClick={e => { e.stopPropagation(); setPageMenu(pageMenu === page.id ? null : page.id); }}
          title="More actions"
          aria-label="More actions"
        >
          <MoreHorizontal size={14} />
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
