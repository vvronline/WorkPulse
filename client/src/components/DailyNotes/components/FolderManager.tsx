/* eslint-disable @typescript-eslint/no-explicit-any */
/* FolderManager — nested folder tree with create-subfolder + create-page actions */
import { useState } from "react";
import { Folder, FolderPlus, Plus, X, Check, ChevronDown, ChevronRight } from "../../../constants/icons";
import type { NoteFolder } from "../notesUtils";
import s from "./FolderManager.module.css";

interface FolderNodeProps {
    folder: NoteFolder & { depth?: number };
    folders: (NoteFolder & { depth?: number })[];
    onNewPageInFolder: (folderId: string, title: string) => void;
    onDeleteFolder: (folderId: string) => void;
    onNewFolder: (parentId: string | null, name?: string) => void;
}

function FolderNode({ folder, folders, onNewPageInFolder, onDeleteFolder, onNewFolder }: FolderNodeProps) {
    const [expanded, setExpanded] = useState(true);
    const [creating, setCreating] = useState<"folder" | "page" | false>(false);  // 'folder' | 'page' | false
    const [subName, setSubName] = useState("");

    const children = folders.filter(f => f.parentId === folder.id);
    const hasChildren = children.length > 0;
    const indent = { paddingLeft: `${(folder.depth || 0) * 1}rem` };

    const handleCreate = () => {
        if (!subName.trim()) { setCreating(false); return; }
        if (creating === "folder") {
            onNewFolder(folder.id, subName.trim());
        } else {
            onNewPageInFolder(folder.id, subName.trim());
        }
        setSubName("");
        setCreating(false);
    };

    return (
        <>
            <div className={s.folderItem} style={indent}>
                <button className={s.expandBtn} onClick={() => setExpanded(p => !p)} title={expanded ? "Collapse" : "Expand"} aria-label={expanded ? "Collapse" : "Expand"}>
                    {hasChildren
                        ? (expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />)
                        : <span className={s.expandDot}>·</span>}
                </button>
                <span className={s.folderItemName} onClick={() => setExpanded(p => !p)}>
                    <Folder size={13} style={{ marginRight: 5, verticalAlign: "middle" }} />{folder.name}
                </span>
                <div className={s.folderItemActions}>
                    <button className={s.folderAddBtn} onClick={() => { setCreating("folder"); setExpanded(true); }} title="New subfolder" aria-label="New subfolder">
                        <FolderPlus size={12} />
                    </button>
                    <button className={s.folderAddBtn} onClick={() => { setCreating("page"); setExpanded(true); }} title={`New page in "${folder.name}"`} aria-label="New page in folder">
                        <Plus size={12} />
                    </button>
                    <button className={s.folderDeleteBtn} onClick={() => onDeleteFolder(folder.id)} title="Delete folder" aria-label="Delete folder">
                        <X size={12} />
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
                            if (e.key === "Enter") handleCreate();
                            if (e.key === "Escape") { setCreating(false); setSubName(""); }
                        }}
                        placeholder={creating === "folder" ? "Subfolder name…" : "Page title…"}
                        autoFocus
                    />
                    <button className={s.newFolderOk} onClick={handleCreate} aria-label="Create"><Check size={12} /></button>
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

interface FolderManagerProps {
    folders: NoteFolder[];
    newFolderOpen: boolean;
    setNewFolderOpen: (open: boolean) => void;
    newFolderName: string;
    setNewFolderName: (name: string) => void;
    onNewFolder: (parentId: string | null, name?: string) => void;
    onDeleteFolder: (folderId: string) => void;
    onNewPageInFolder: (folderId: string, title: string) => void;
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
}: FolderManagerProps) {
    const rootFolders = folders
        .filter(f => !f.parentId)
        .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

    // Wrapper: onNewFolder from tree nodes passes (parentId, name)
    const handleTreeNewFolder = (parentId: string | null, name?: string) => {
        // Temporarily set the name and call with parentId
        onNewFolder(parentId, name);
    };

    // Wrapper: onNewPageInFolder from tree nodes passes (folderId, title)
    const handleTreeNewPage = (folderId: string, title: string) => {
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
                            if (e.key === "Enter") onNewFolder(null);
                            if (e.key === "Escape") setNewFolderOpen(false);
                        }}
                        placeholder="Folder name…"
                        autoFocus
                    />
                    <button className={s.newFolderOk} onClick={() => onNewFolder(null)} aria-label="Create folder"><Check size={12} /></button>
                </div>
            ) : (
                <button className={s.newFolderBtn} onClick={() => setNewFolderOpen(true)}>
                    <Plus size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />New Folder
                </button>
            )}
        </div>
    );
}