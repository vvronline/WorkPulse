/* eslint-disable @typescript-eslint/no-explicit-any */
/* PageContextMenu — ⋯ dropdown for a single page item in the sidebar */
import React from "react";
import { Pin, Copy, Archive, ArchiveRestore, FolderOpen, Trash2, Pencil } from "../../../constants/icons";
import { buildFolderTree } from "../notesUtils";
import s from "./PageContextMenu.module.css";
import type { NoteFolder } from "../notesUtils";

interface PageContextMenuProps {
    page: any;
    folders: NoteFolder[];
    pageMenuRef: React.RefObject<any>;
    onRename: (page: any) => void;
    onTogglePin: (id: any) => void;
    onDuplicate: (id: any) => void;
    onToggleArchive: (id: any) => void;
    onMoveToFolder: (id: any, folderId: string | null) => void;
    onDelete: () => void;
    setPageMenu: (v: any) => void;
}

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
}: PageContextMenuProps) {
    return (
        <div className={s.ctxMenu} ref={pageMenuRef}>
            <button className={s.ctxItem} onClick={() => { onRename(page); setPageMenu(null); }}>
                <Pencil size={13} style={{ marginRight: 6 }} />Rename
            </button>
            <button className={s.ctxItem} onClick={() => onTogglePin(page.id)}>
                {page.pinned ? <><Pin size={13} style={{ marginRight: 6 }} />Unpin</> : <><Pin size={13} style={{ marginRight: 6 }} />Pin to top</>}
            </button>
            <button className={s.ctxItem} onClick={() => onDuplicate(page.id)}>
                <Copy size={13} style={{ marginRight: 6 }} />Duplicate
            </button>
            <button className={s.ctxItem} onClick={() => onToggleArchive(page.id)}>
                {page.archived ? <><ArchiveRestore size={13} style={{ marginRight: 6 }} />Unarchive</> : <><Archive size={13} style={{ marginRight: 6 }} />Archive</>}
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
                    {buildFolderTree(folders).map((f: any) => (
                        <button
                            key={f.id}
                            className={`${s.ctxItem} ${s.ctxSmall} ${page.folderId === f.id ? s.ctxActive : ""}`}
                            onClick={() => onMoveToFolder(page.id, f.id)}
                            style={{ paddingLeft: `${1.5 + f.depth * 0.75}rem` }}
                        >
                            <FolderOpen size={12} style={{ marginRight: 5 }} />{f.name}
                        </button>
                    ))}
                </div>
            )}

            <div className={s.ctxDivider} />
            <button
                className={`${s.ctxItem} ${s.ctxDanger}`}
                onClick={() => { setPageMenu(null); onDelete(); }}
            >
                <Trash2 size={13} style={{ marginRight: 6 }} />Delete
            </button>
        </div>
    );
}