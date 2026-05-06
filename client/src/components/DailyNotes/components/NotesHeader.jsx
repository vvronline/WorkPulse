/* NotesHeader — compact widget launcher card */
import React from 'react';
import { FileText, Check, ArrowUpRight } from '../../../constants/icons';
import s from './NotesHeader.module.css';

export default function NotesHeader({ activePage, pages = [], savedFlash, onOpen }) {
  const pageCount = pages.filter(p => !p.archived).length;

  return (
    <button className={s.header} onClick={onOpen} title="Open notes">
      {/* Icon */}
      <FileText className={s.icon} size={18} aria-hidden="true" />

      {/* Text */}
      <div className={s.text}>
        <span className={s.title}>Notes</span>
        <span className={s.subtitle}>
          {activePage ? activePage.title || 'Untitled' : 'No pages yet'}
          {pageCount > 1 && <span className={s.count}> · {pageCount} pages</span>}
        </span>
      </div>

      {savedFlash && (
        <span className={s.savedBadge}>
          <Check size={11} style={{ verticalAlign: '-2px', marginRight: 3 }} />
          Saved
        </span>
      )}

      {/* Open arrow */}
      <ArrowUpRight className={s.openIcon} size={14} aria-hidden="true" />
    </button>
  );
}
