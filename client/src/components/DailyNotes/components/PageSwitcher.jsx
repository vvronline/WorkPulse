/* PageSwitcher — inline header dropdown for picking/renaming pages */
import React from 'react';
import { formatDate } from '../notesUtils';
import s from './PageSwitcher.module.css';

export default function PageSwitcher({
  activePage,
  menuOpen, setMenuOpen,
  menuRef,
  dropdownPages,
  dropdownSearch, setDropdownSearch,
  activePageId,
  renamingId, renameValue, setRenameValue, renameRef,
  onSelectPage,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onNewPage,
}) {
  return (
    <div className={s.switcher} ref={menuRef}>
      <button
        className={s.switcherBtn}
        onClick={() => setMenuOpen(o => !o)}
        title="Switch page"
      >
        {activePage?.pinned && <span className={s.pinSmall}>📌</span>}
        <span className={s.switcherName}>{activePage?.title || 'Untitled'}</span>
        <svg
          className={`${s.switcherChevron} ${menuOpen ? s.switcherChevronOpen : ''}`}
          viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"
        >
          <path d="M2 3.5l3 3 3-3"/>
        </svg>
      </button>

      {menuOpen && (
        <div className={s.menu}>
          {/* Search */}
          <div className={s.menuSearchWrap}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5l3 3"/>
            </svg>
            <input
              className={s.menuSearchInput}
              placeholder="Search pages…"
              value={dropdownSearch}
              onChange={e => setDropdownSearch(e.target.value)}
              autoFocus
            />
          </div>

          {/* Page list */}
          <div className={s.menuList}>
            {dropdownPages.length === 0 && (
              <div className={s.menuEmpty}>No pages found</div>
            )}
            {dropdownPages.map(page => (
              <div
                key={page.id}
                className={`${s.menuItem} ${page.id === activePageId ? s.menuItemActive : ''}`}
              >
                {renamingId === page.id ? (
                  <input
                    ref={renameRef}
                    className={s.renameInput}
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') onCommitRename(page.id);
                      if (e.key === 'Escape') onCancelRename();
                    }}
                    onBlur={() => onCommitRename(page.id)}
                    onClick={e => e.stopPropagation()}
                  />
                ) : (
                  <button
                    className={s.menuItemBtn}
                    onClick={() => { onSelectPage(page.id); setMenuOpen(false); }}
                  >
                    {page.pinned && <span className={s.pinSmall}>📌</span>}
                    <span className={s.menuItemName}>{page.title || 'Untitled'}</span>
                    <span className={s.menuItemDate}>{formatDate(page.updatedAt)}</span>
                  </button>
                )}
                {renamingId !== page.id && (
                  <button
                    className={s.menuItemRename}
                    onClick={e => { e.stopPropagation(); onStartRename(page.id, page.title); }}
                    title="Rename"
                  >
                    <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9.5 2.5l2 2L4 12H2v-2L9.5 2.5z"/>
                    </svg>
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* New page */}
          <button className={s.menuNewBtn} onClick={() => { onNewPage(); setMenuOpen(false); }}>
            <svg viewBox="0 0 14 14" fill="currentColor">
              <path d="M7 2a.75.75 0 01.75.75v3.5h3.5a.75.75 0 010 1.5h-3.5v3.5a.75.75 0 01-1.5 0v-3.5h-3.5a.75.75 0 010-1.5h3.5v-3.5A.75.75 0 017 2z"/>
            </svg>
            New page
          </button>
        </div>
      )}
    </div>
  );
}
