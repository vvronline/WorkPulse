/* NotesHeader — compact widget launcher card */
import React from 'react';
import s from './NotesHeader.module.css';

export default function NotesHeader({ activePage, pages = [], savedFlash, onOpen }) {
  const pageCount = pages.filter(p => !p.archived).length;

  return (
    <button className={s.header} onClick={onOpen} title="Open notes">
      {/* Icon */}
      <svg className={s.icon} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clipRule="evenodd" />
      </svg>

      {/* Text */}
      <div className={s.text}>
        <span className={s.title}>Notes</span>
        <span className={s.subtitle}>
          {activePage ? activePage.title || 'Untitled' : 'No pages yet'}
          {pageCount > 1 && <span className={s.count}> · {pageCount} pages</span>}
        </span>
      </div>

      {savedFlash && <span className={s.savedBadge}>✓ Saved</span>}

      {/* Open arrow */}
      <svg className={s.openIcon} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M5 2h7v7M12 2L2 12"/>
      </svg>
    </button>
  );
}
