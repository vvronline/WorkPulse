/* eslint-disable @typescript-eslint/no-explicit-any */
/* ─────────────────────────────────────────────────────────
   FolderTree — a single, unified, drag-friendly hierarchy of
   folders, subfolders, and the notes inside them.

   This replaces the old disconnected "FolderManager strip +
   flat page list" layout. Everything lives in one structured
   tree so users can SEE where notes live, CREATE subfolders /
   notes from an obvious "+" control, and MOVE notes simply by
   dragging them onto a folder.

   Drag-and-drop rules:
     • Drag a note → drop on a folder      = move note into folder
     • Drag a note → drop on "All notes"   = remove note from folder
     • Drag a folder → drop on a folder    = nest folder (re-parent)
     • Drag a folder → drop on "All notes" = move folder to top level
   Cycle prevention is handled in the store (handleMoveFolder).
   ───────────────────────────────────────────────────────── */
import { useState, useCallback, useMemo } from "react";
import {
    Folder,
    FolderOpen,
    FolderPlus,
    FilePlus,
    FileText,
    Pin,
    ChevronDown,
    ChevronRight,
    Check,
    Pencil,
    Trash2,
    MoreHorizontal,
    Inbox,
} from "../../../constants/icons";
import type { NotePage, NoteFolder } from "../notesUtils";
import s from "./FolderTree.module.css";

type DragType = "page" | "folder";
interface DragInfo { type: DragType; id: string; }

/* ── Inline create row (subfolder or note) ─────────────────── */
interface CreateRowProps {
    mode: "folder" | "page";
    depth: number;
    onSubmit: (value: string) => void;
    onCancel: () => void;
}
function CreateRow({ mode, depth, onSubmit, onCancel }: CreateRowProps) {
    const [value, setValue] = useState("");
    const submit = () => {
        const v = value.trim();
        if (!v) { onCancel(); return; }
        onSubmit(v);
        setValue("");
    };
    return (
        <div
            className={s.createRow}
            style={{ paddingLeft: `${0.5 + (depth + 1) * 0.85}rem` }}
        >
            <span className={s.createIcon}>
                {mode === "folder" ? <FolderPlus size={13} /> : <FilePlus size={13} />}
            </span>
            <input
                className={s.createInput}
                value={value}
                onChange={e => setValue(e.target.value)}
                onKeyDown={e => {
                    if (e.key === "Enter") submit();
                    if (e.key === "Escape") onCancel();
                }}
                onBlur={submit}
                placeholder={mode === "folder" ? "Subfolder name…" : "Note title…"}
                autoFocus
                aria-label={mode === "folder" ? "New subfolder name" : "New note title"}
            />
            <button className={s.createOk} onMouseDown={(e) => { e.preventDefault(); submit(); }} aria-label="Create">
                <Check size={13} />
            </button>
        </div>
    );
}

/* ── A note row (leaf) ─────────────────────────────────────── */
interface NoteRowProps {
    page: NotePage;
    depth: number;
    isActive: boolean;
    onSelect: (id: string) => void;
    onDragStart: (e: React.DragEvent, type: DragType, id: string) => void;
    onDragEnd: () => void;
    isDragging: boolean;
}
function NoteRow({ page, depth, isActive, onSelect, onDragStart, onDragEnd, isDragging }: NoteRowProps) {
    return (
        <div
            className={`${s.noteRow} ${isActive ? s.noteRowActive : ""} ${isDragging ? s.dragging : ""}`}
            style={{ paddingLeft: `${0.5 + depth * 0.85}rem` }}
            onClick={() => onSelect(page.id)}
            draggable
            onDragStart={(e) => onDragStart(e, "page", page.id)}
            onDragEnd={onDragEnd}
            title={page.title || "Untitled"}
        >
            <span className={s.noteIcon} aria-hidden="true">
                {page.icon ? <span className={s.noteEmoji}>{page.icon}</span> : <FileText size={13} />}
            </span>
            <span className={s.noteName}>{page.title || "Untitled"}</span>
            {page.pinned && <Pin size={11} className={s.notePin} aria-label="Pinned" />}
        </div>
    );
}

/* ── A folder node (recursive) ─────────────────────────────── */
interface FolderNodeProps {
    folder: NoteFolder;
    depth: number;
    folders: NoteFolder[];
    pagesByFolder: Record<string, NotePage[]>;
    activePageId: string | null | undefined;
    expanded: Record<string, boolean>;
    onToggle: (id: string, forceOpen?: boolean) => void;
    onSelectPage: (id: string) => void;
    onNewFolder: (parentId: string | null, name: string) => void;
    onNewPage: (folderId: string, title: string) => void;
    onRenameFolder: (folderId: string, name: string) => void;
    onDeleteFolder: (folderId: string) => void;
    dragInfo: DragInfo | null;
    dropTarget: string | null;
    onDragStart: (e: React.DragEvent, type: DragType, id: string) => void;
    onDragEnd: () => void;
    onDragOverFolder: (e: React.DragEvent, folderId: string) => void;
    onDragLeaveFolder: () => void;
    onDropFolder: (e: React.DragEvent, folderId: string) => void;
}
function FolderNode({
    folder,
    depth,
    folders,
    pagesByFolder,
    activePageId,
    expanded,
    onToggle,
    onSelectPage,
    onNewFolder,
    onNewPage,
    onRenameFolder,
    onDeleteFolder,
    // dnd
    dragInfo,
    dropTarget,
    onDragStart,
    onDragEnd,
    onDragOverFolder,
    onDragLeaveFolder,
    onDropFolder,
}: FolderNodeProps) {
    const [creating, setCreating] = useState<"folder" | "page" | null>(null); // 'folder' | 'page' | null
    const [renaming, setRenaming] = useState(false);
    const [renameValue, setRenameValue] = useState(folder.name);
    const [menuOpen, setMenuOpen] = useState(false);

    const isOpen = expanded[folder.id] !== false; // default expanded
    const childFolders = folders
        .filter(f => f.parentId === folder.id)
        .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    const childPages = (pagesByFolder[folder.id] || []);
    const totalCount = childPages.length;
    const hasChildren = childFolders.length > 0 || childPages.length > 0;
    const isDropTarget = dropTarget === folder.id;

    const commitRename = () => {
        const v = renameValue.trim();
        if (v && v !== folder.name) onRenameFolder(folder.id, v);
        setRenaming(false);
    };

    return (
        <div className={s.folderGroup}>
            <div
                className={`${s.folderRow} ${isDropTarget ? s.dropTarget : ""}`}
                style={{ paddingLeft: `${0.4 + depth * 0.85}rem` }}
                draggable={!renaming}
                onDragStart={(e) => onDragStart(e, "folder", folder.id)}
                onDragEnd={onDragEnd}
                onDragOver={(e) => onDragOverFolder(e, folder.id)}
                onDragLeave={onDragLeaveFolder}
                onDrop={(e) => onDropFolder(e, folder.id)}
            >
                <button
                    type="button"
                    className={s.chevron}
                    onClick={(e) => { e.stopPropagation(); onToggle(folder.id); }}
                    aria-label={isOpen ? "Collapse" : "Expand"}
                >
                    {hasChildren
                        ? (isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />)
                        : <span className={s.chevronDot} />}
                </button>

                <span className={s.folderIcon} aria-hidden="true">
                    {isOpen ? <FolderOpen size={14} /> : <Folder size={14} />}
                </span>

                {renaming ? (
                    <input
                        className={s.renameInput}
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === "Enter") commitRename();
                            if (e.key === "Escape") { setRenaming(false); setRenameValue(folder.name); }
                        }}
                        onBlur={commitRename}
                        onClick={e => e.stopPropagation()}
                        autoFocus
                        aria-label="Rename folder"
                    />
                ) : (
                    <button
                        type="button"
                        className={s.folderName}
                        onClick={() => onToggle(folder.id)}
                        onDoubleClick={(e) => { e.stopPropagation(); setRenameValue(folder.name); setRenaming(true); }}
                        title={folder.name}
                    >
                        {folder.name}
                    </button>
                )}

                {totalCount > 0 && !renaming && (
                    <span className={s.folderCount}>{totalCount}</span>
                )}

                <div className={s.folderActions}>
                    <button
                        type="button"
                        className={s.actionBtn}
                        onClick={(e) => { e.stopPropagation(); setCreating("folder"); onToggle(folder.id, true); }}
                        title="New subfolder"
                        aria-label="New subfolder"
                    >
                        <FolderPlus size={13} />
                    </button>
                    <button
                        type="button"
                        className={s.actionBtn}
                        onClick={(e) => { e.stopPropagation(); setCreating("page"); onToggle(folder.id, true); }}
                        title="New note in this folder"
                        aria-label="New note in folder"
                    >
                        <FilePlus size={13} />
                    </button>
                    <div className={s.menuWrap}>
                        <button
                            type="button"
                            className={s.actionBtn}
                            onClick={(e) => { e.stopPropagation(); setMenuOpen(o => !o); }}
                            title="More"
                            aria-label="Folder actions"
                        >
                            <MoreHorizontal size={14} />
                        </button>
                        {menuOpen && (
                            <>
                                <div className={s.menuBackdrop} onClick={(e) => { e.stopPropagation(); setMenuOpen(false); }} />
                                <div className={s.menu} onClick={e => e.stopPropagation()}>
                                    <button
                                        className={s.menuItem}
                                        onClick={() => { setRenameValue(folder.name); setRenaming(true); setMenuOpen(false); }}
                                    >
                                        <Pencil size={13} /> Rename
                                    </button>
                                    <button
                                        className={`${s.menuItem} ${s.menuDanger}`}
                                        onClick={() => { onDeleteFolder(folder.id); setMenuOpen(false); }}
                                    >
                                        <Trash2 size={13} /> Delete folder
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            </div>

            {isOpen && (
                <div className={s.folderChildren}>
                    {creating && (
                        <CreateRow
                            mode={creating}
                            depth={depth}
                            onSubmit={(v) => {
                                if (creating === "folder") onNewFolder(folder.id, v);
                                else onNewPage(folder.id, v);
                                setCreating(null);
                            }}
                            onCancel={() => setCreating(null)}
                        />
                    )}

                    {childFolders.map(cf => (
                        <FolderNode
                            key={cf.id}
                            folder={cf}
                            depth={depth + 1}
                            folders={folders}
                            pagesByFolder={pagesByFolder}
                            activePageId={activePageId}
                            expanded={expanded}
                            onToggle={onToggle}
                            onSelectPage={onSelectPage}
                            onNewFolder={onNewFolder}
                            onNewPage={onNewPage}
                            onRenameFolder={onRenameFolder}
                            onDeleteFolder={onDeleteFolder}
                            dragInfo={dragInfo}
                            dropTarget={dropTarget}
                            onDragStart={onDragStart}
                            onDragEnd={onDragEnd}
                            onDragOverFolder={onDragOverFolder}
                            onDragLeaveFolder={onDragLeaveFolder}
                            onDropFolder={onDropFolder}
                        />
                    ))}

                    {childPages.map(p => (
                        <NoteRow
                            key={p.id}
                            page={p}
                            depth={depth + 1}
                            isActive={p.id === activePageId}
                            onSelect={onSelectPage}
                            onDragStart={onDragStart}
                            onDragEnd={onDragEnd}
                            isDragging={dragInfo?.type === "page" && dragInfo?.id === p.id}
                        />
                    ))}

                    {!hasChildren && !creating && (
                        <div
                            className={s.emptyFolder}
                            style={{ paddingLeft: `${0.5 + (depth + 1) * 0.85}rem` }}
                        >
                            Empty — drag notes here or use +
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

/* ── Top-level component ────────────────────────────────────── */
interface FolderTreeProps {
    folders: NoteFolder[];
    pages: NotePage[];
    activePageId: string | null | undefined;
    onSelectPage: (id: string) => void;
    onNewFolder: (parentId: string | null, name: string) => void;
    onNewPage: (folderId: string, title: string) => void;
    onRenameFolder: (folderId: string, name: string) => void;
    onDeleteFolder: (folderId: string) => void;
    onMovePageToFolder: (pageId: string, folderId: string | null) => void;
    onMoveFolder: (folderId: string, newParentId: string | null) => void;
    variant?: "default" | "home";
}
export default function FolderTree({
    folders,
    pages,
    activePageId,
    onSelectPage,
    onNewFolder,         // (parentId, name)
    onNewPage,           // (folderId, title)
    onRenameFolder,      // (folderId, name)
    onDeleteFolder,      // (folderId)
    onMovePageToFolder,  // (pageId, folderId|null)
    onMoveFolder,        // (folderId, newParentId|null)
    variant = "default", // 'default' (panel) | 'home' (self-contained card)
}: FolderTreeProps) {
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});
    const [dragInfo, setDragInfo] = useState<DragInfo | null>(null);   // { type, id }
    const [dropTarget, setDropTarget] = useState<string | null>(null); // folderId | 'root'
    const [creatingRoot, setCreatingRoot] = useState<"folder" | null>(null); // 'folder' | null

    const onToggle = useCallback((id: string, forceOpen?: boolean) => {
        setExpanded(prev => ({
            ...prev,
            [id]: forceOpen ? true : (prev[id] === false ? true : false),
        }));
    }, []);

    // Group non-archived pages by folderId. Top-level pages only (no sub-page
    // children) so the folder view stays clean; sub-pages are reachable via the
    // page's own sub-page panel and the Tree view.
    const pagesByFolder = useMemo(() => {
        const map: Record<string, NotePage[]> = {};
        pages
            .filter(p => !p.archived)
            .sort((a, b) => {
                if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
                return (a.title || "").localeCompare(b.title || "");
            })
            .forEach(p => {
                const key = p.folderId || "__none__";
                (map[key] = map[key] || []).push(p);
            });
        return map;
    }, [pages]);

    const rootFolders = folders
        .filter(f => !f.parentId)
        .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

    const uncategorized = pagesByFolder["__none__"] || [];

    /* ── DnD handlers ─────────────────────────────────────── */
    const handleDragStart = (e: React.DragEvent, type: DragType, id: string) => {
        setDragInfo({ type, id });
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", `${type}:${id}`); } catch { /* ignore */ }
    };

    const handleDragEnd = () => {
        setDragInfo(null);
        setDropTarget(null);
    };

    const handleDragOverFolder = (e: React.DragEvent, folderId: string) => {
        if (!dragInfo) return;
        // A folder cannot be dropped onto itself.
        if (dragInfo.type === "folder" && dragInfo.id === folderId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDropTarget(folderId);
    };

    const handleDragLeaveFolder = () => {
        // Clearing is handled on the next dragover; avoid flicker by not nulling here.
    };

    const handleDropFolder = (e: React.DragEvent, folderId: string) => {
        e.preventDefault();
        e.stopPropagation();
        if (!dragInfo) return;
        if (dragInfo.type === "page") {
            onMovePageToFolder(dragInfo.id, folderId);
        } else if (dragInfo.type === "folder" && dragInfo.id !== folderId) {
            onMoveFolder(dragInfo.id, folderId);
        }
        setDragInfo(null);
        setDropTarget(null);
    };

    // Drop on the "All notes / Uncategorized" root zone.
    const handleDragOverRoot = (e: React.DragEvent) => {
        if (!dragInfo) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDropTarget("root");
    };
    const handleDropRoot = (e: React.DragEvent) => {
        e.preventDefault();
        if (!dragInfo) return;
        if (dragInfo.type === "page") onMovePageToFolder(dragInfo.id, null);
        else if (dragInfo.type === "folder") onMoveFolder(dragInfo.id, null);
        setDragInfo(null);
        setDropTarget(null);
    };

    return (
        <div className={`${s.tree} ${variant === "home" ? s.treeHome : ""}`}>
            <div className={s.treeHead}>
                <span className={s.treeTitle}>Folders &amp; notes</span>
                <button
                    type="button"
                    className={s.newRootBtn}
                    onClick={() => setCreatingRoot("folder")}
                    title="New top-level folder"
                >
                    <FolderPlus size={13} />
                    <span>New folder</span>
                </button>
            </div>

            {creatingRoot === "folder" && (
                <CreateRow
                    mode="folder"
                    depth={-1}
                    onSubmit={(v) => { onNewFolder(null, v); setCreatingRoot(null); }}
                    onCancel={() => setCreatingRoot(null)}
                />
            )}

            <div className={s.scroll}>
                {rootFolders.map(f => (
                    <FolderNode
                        key={f.id}
                        folder={f}
                        depth={0}
                        folders={folders}
                        pagesByFolder={pagesByFolder}
                        activePageId={activePageId}
                        expanded={expanded}
                        onToggle={onToggle}
                        onSelectPage={onSelectPage}
                        onNewFolder={onNewFolder}
                        onNewPage={onNewPage}
                        onRenameFolder={onRenameFolder}
                        onDeleteFolder={onDeleteFolder}
                        dragInfo={dragInfo}
                        dropTarget={dropTarget}
                        onDragStart={handleDragStart}
                        onDragEnd={handleDragEnd}
                        onDragOverFolder={handleDragOverFolder}
                        onDragLeaveFolder={handleDragLeaveFolder}
                        onDropFolder={handleDropFolder}
                    />
                ))}

                {/* Uncategorized / drop-to-remove zone — always present */}
                <div className={s.folderGroup}>
                    <div
                        className={`${s.folderRow} ${s.rootRow} ${dropTarget === "root" ? s.dropTarget : ""}`}
                        onDragOver={handleDragOverRoot}
                        onDrop={handleDropRoot}
                    >
                        <button
                            type="button"
                            className={s.chevron}
                            onClick={() => onToggle("__none__")}
                            aria-label="Toggle uncategorized"
                        >
                            {uncategorized.length > 0
                                ? (expanded["__none__"] !== false ? <ChevronDown size={12} /> : <ChevronRight size={12} />)
                                : <span className={s.chevronDot} />}
                        </button>
                        <span className={s.folderIcon} aria-hidden="true"><Inbox size={14} /></span>
                        <button type="button" className={s.folderName} onClick={() => onToggle("__none__")}>
                            Uncategorized
                        </button>
                        {uncategorized.length > 0 && (
                            <span className={s.folderCount}>{uncategorized.length}</span>
                        )}
                    </div>
                    {expanded["__none__"] !== false && (
                        <div className={s.folderChildren}>
                            {uncategorized.map(p => (
                                <NoteRow
                                    key={p.id}
                                    page={p}
                                    depth={1}
                                    isActive={p.id === activePageId}
                                    onSelect={onSelectPage}
                                    onDragStart={handleDragStart}
                                    onDragEnd={handleDragEnd}
                                    isDragging={dragInfo?.type === "page" && dragInfo?.id === p.id}
                                />
                            ))}
                            {uncategorized.length === 0 && (
                                <div className={s.emptyFolder} style={{ paddingLeft: "1.35rem" }}>
                                    Drag a note here to remove it from its folder
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {rootFolders.length === 0 && uncategorized.length === 0 && (
                    <div className={s.treeEmpty}>
                        No folders yet. Click <strong>New folder</strong> to get organized.
                    </div>
                )}
            </div>

            {dragInfo && (
                <div className={s.dragHint}>
                    {dragInfo.type === "page"
                        ? "Drop on a folder to move · drop on Uncategorized to remove"
                        : "Drop on a folder to nest · drop on Uncategorized for top level"}
                </div>
            )}
        </div>
    );
}