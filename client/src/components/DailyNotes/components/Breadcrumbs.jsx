/* ─────────────────────────────────────────────────────────
   Breadcrumbs — page hierarchy trail for the editor header.
   Shows: [Folder path] › Parent › Parent › Current page
   Each crumb is clickable to jump to that ancestor.
   ───────────────────────────────────────────────────────── */
import React from 'react';
import { ChevronRight, Folder, FileText } from '../../../constants/icons';
import { getFolderPath, getPageAncestors } from '../notesUtils';
import s from './Breadcrumbs.module.css';

export default function Breadcrumbs({ activePage, pages, folders, onSelectPage, onSelectFolder }) {
    if (!activePage) return null;
    const ancestors = getPageAncestors(activePage.id, pages);
    const folderPath = activePage.folderId ? getFolderPath(activePage.folderId, folders) : '';

    return (
        <nav className={s.crumbs} aria-label="Breadcrumbs">
            {folderPath && (
                <>
                    <button
                        className={s.crumb}
                        onClick={() => onSelectFolder?.(activePage.folderId)}
                        title={`Filter by folder ${folderPath}`}
                    >
                        <Folder size={12} className={s.icon} />
                        <span className={s.text}>{folderPath}</span>
                    </button>
                    <ChevronRight size={11} className={s.sep} aria-hidden="true" />
                </>
            )}
            {ancestors.map(a => (
                <React.Fragment key={a.id}>
                    <button
                        className={s.crumb}
                        onClick={() => onSelectPage?.(a.id)}
                        title={`Go to ${a.title}`}
                    >
                        {a.icon
                            ? <span className={s.icon}>{a.icon}</span>
                            : <FileText size={12} className={s.icon} />}
                        <span className={s.text}>{a.title || 'Untitled'}</span>
                    </button>
                    <ChevronRight size={11} className={s.sep} aria-hidden="true" />
                </React.Fragment>
            ))}
            <span className={`${s.crumb} ${s.crumbActive}`} title={activePage.title}>
                {activePage.icon
                    ? <span className={s.icon}>{activePage.icon}</span>
                    : <FileText size={12} className={s.icon} />}
                <span className={s.text}>{activePage.title || 'Untitled'}</span>
            </span>
        </nav>
    );
}