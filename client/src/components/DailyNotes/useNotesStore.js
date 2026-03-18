/* ─────────────────────────────────────────────────────────
   useNotesStore – central state + business logic hook.
   Owns: pages, folders, UI state, persistence, all handlers.
   Returns a single "store" object consumed by index.jsx and
   passed down as props to child components.
   ───────────────────────────────────────────────────────── */
import { useState, useEffect, useRef, useCallback } from 'react';
import { newPage, newFolder, getDescendantFolderIds } from './notesUtils';
import { useNotesPersistence } from './useNotesPersistence';
import { useNotesFilters } from './useNotesFilters';
import { useClickOutside } from '../../hooks/useClickOutside';

export function useNotesStore(userId) {
    const {
        pages, setPages, folders, setFolders,
        activePageId, setActivePageId,
        sortBy, setSortBy,
        savedFlash, setSavedFlash,
        saveTimerRef, persist, scheduleAutoSave,
    } = useNotesPersistence(userId);

    /* ── UI flags ──────────────────────────────────────────── */
    const [expanded, setExpanded] = useState(false);
    const [maximized, setMaximized] = useState(false);
    const [embedded, setEmbedded] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [showArchived, setShowArchived] = useState(false);
    const [folderFilter, setFolderFilter] = useState('all');
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [pageMenu, setPageMenu] = useState(null);
    const [dropdownSearch, setDropdownSearch] = useState('');

    /* ── Rename ─────────────────────────────────────────────── */
    const [renamingId, setRenamingId] = useState(null);
    const [renameValue, setRenameValue] = useState('');

    /* ── Tags ───────────────────────────────────────────────── */
    const [tagInput, setTagInput] = useState('');
    const [showTagInput, setShowTagInput] = useState(false);

    /* ── Folders ────────────────────────────────────────────── */
    const [newFolderOpen, setNewFolderOpen] = useState(false);
    const [newFolderName, setNewFolderName] = useState('');

    /* ── Drag-and-drop ──────────────────────────────────────── */
    const [dragOverId, setDragOverId] = useState(null);

    /* ── Refs ───────────────────────────────────────────────── */
    const renameRef = useRef(null);
    const menuRef = useRef(null);
    const quillRef = useRef(null);
    const modalQuillRef = useRef(null);
    const searchRef = useRef(null);
    const tagInputRef = useRef(null);
    const pageMenuRef = useRef(null);
    const dragRef = useRef(null);

    /* ── Derived values ─────────────────────────────────────── */
    const { activePage, wc, processedPages, dropdownPages } = useNotesFilters({
        pages, activePageId, sortBy, showArchived, folderFilter, searchQuery, dropdownSearch,
    });

    /* ── Focus rename input when it mounts ──────────────────── */
    useEffect(() => {
        if (renamingId && renameRef.current) {
            renameRef.current.focus();
            renameRef.current.select();
        }
    }, [renamingId]);

    useClickOutside(menuRef, () => setMenuOpen(false), menuOpen);
    useClickOutside(pageMenuRef, () => setPageMenu(null), !!pageMenu);

    /* ── Escape closes maximized modal ─────────────────────── */
    useEffect(() => {
        if (!maximized) return;
        const h = (e) => { if (e.key === 'Escape') setMaximized(false); };
        document.addEventListener('keydown', h);
        return () => document.removeEventListener('keydown', h);
    }, [maximized]);

    /* ── Prevent body scroll when modal open ─────────────────── */
    useEffect(() => {
        document.body.style.overflow = maximized ? 'hidden' : '';
        return () => { document.body.style.overflow = ''; };
    }, [maximized]);

    /* ── Keyboard shortcuts ─────────────────────────────────── */
    useEffect(() => {
        const h = (e) => {
            const ctrl = e.ctrlKey || e.metaKey;
            const active = expanded || maximized || embedded;
            if (!active) return;

            if (ctrl && e.key === 'n' && !e.shiftKey) {
                e.preventDefault(); handleNewPage();
            }
            if (ctrl && e.key === 's' && !e.shiftKey) {
                e.preventDefault();
                clearTimeout(saveTimerRef.current);
                persist(pages, folders, activePageId, sortBy);
                setSavedFlash(true); setTimeout(() => setSavedFlash(false), 2000);
            }
            if (ctrl && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
                e.preventDefault();
                setTimeout(() => searchRef.current?.focus(), 50);
            }
            if (ctrl && e.key === 'p' && !e.shiftKey && activePageId) {
                if (!['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
                    e.preventDefault(); handleTogglePin(activePageId);
                }
            }
            if (ctrl && e.key === 'd' && !e.shiftKey && activePageId) {
                e.preventDefault(); handleDuplicatePage(activePageId);
            }
            if (ctrl && e.shiftKey && (e.key === 'A' || e.key === 'a') && activePageId) {
                e.preventDefault(); handleToggleArchive(activePageId);
            }
        };
        document.addEventListener('keydown', h);
        return () => document.removeEventListener('keydown', h);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [expanded, maximized, embedded, pages, folders, activePageId, sortBy, persist]);

    /* ══════════════════════════ Handlers ═══════════════════════ */

    const handleContentChange = (content) => {
        const updated = pages.map(p =>
            p.id === activePageId ? { ...p, content, updatedAt: new Date().toISOString() } : p,
        );
        setPages(updated);
        scheduleAutoSave(updated, folders, activePageId);
    };

    const handleTitleChange = (e) => {
        const title = e.target.value;
        const updated = pages.map(p => p.id === activePageId ? { ...p, title } : p);
        setPages(updated);
        scheduleAutoSave(updated, folders, activePageId);
    };

    const handleNewPage = (explicitFolderId, inlineTitle) => {
        // Guard: if called as an onClick handler, explicitFolderId will be a synthetic
        // event or DOM element — treat it as "no explicit folder" in that case.
        const validFolder = (typeof explicitFolderId === 'string' || explicitFolderId === null)
            ? explicitFolderId
            : undefined;
        const folderId = validFolder !== undefined
            ? validFolder
            : (folderFilter !== 'all' && folderFilter !== 'none' ? folderFilter : null);
        const title = (typeof inlineTitle === 'string' && inlineTitle.trim()) ? inlineTitle.trim() : 'Untitled';
        const page = newPage(title, folderId);
        const updated = [...pages, page];
        setPages(updated);
        setActivePageId(page.id);
        persist(updated, folders, page.id);
        setMenuOpen(false);
        if (!inlineTitle) {
            setTimeout(() => { setRenamingId(page.id); setRenameValue(title); }, 50);
        }
    };

    const handleSelectPage = (id) => {
        setActivePageId(id);
        persist(pages, folders, id);
        setMenuOpen(false);
    };

    const handleDeletePage = () => setConfirmDelete(true);

    const handleConfirmDelete = () => {
        setConfirmDelete(false);
        if (pages.filter(p => !p.archived).length <= 1 && !activePage?.archived) {
            const fresh = newPage('My Notes');
            setPages([fresh]);
            setActivePageId(fresh.id);
            persist([fresh], folders, fresh.id);
            return;
        }
        const updated = pages.filter(p => p.id !== activePageId);
        const remaining = updated.filter(p => !p.archived);
        const newActive = remaining[0]?.id || updated[0]?.id;
        setPages(updated);
        setActivePageId(newActive);
        persist(updated, folders, newActive);
    };

    const handleStartRename = (page) => {
        setRenamingId(page.id);
        setRenameValue(page.title);
        setMenuOpen(false);
    };

    const handleCommitRename = () => {
        if (!renamingId) return;
        const title = renameValue.trim() || 'Untitled';
        const updated = pages.map(p => p.id === renamingId ? { ...p, title } : p);
        setPages(updated);
        persist(updated, folders, activePageId);
        setRenamingId(null);
    };

    const handleTogglePin = (pageId) => {
        const updated = pages.map(p => p.id === pageId ? { ...p, pinned: !p.pinned } : p);
        setPages(updated);
        persist(updated, folders, activePageId);
    };

    const handleToggleArchive = (pageId) => {
        const updated = pages.map(p =>
            p.id === pageId ? { ...p, archived: !p.archived, updatedAt: new Date().toISOString() } : p,
        );
        setPages(updated);
        if (pageId === activePageId) {
            const remaining = updated.filter(p => !p.archived);
            const newActive = remaining[0]?.id || updated[0]?.id;
            setActivePageId(newActive);
            persist(updated, folders, newActive);
        } else {
            persist(updated, folders, activePageId);
        }
        setPageMenu(null);
    };

    const handleDuplicatePage = (pageId) => {
        const source = pages.find(p => p.id === pageId);
        if (!source) return;
        const dup = {
            ...newPage('Copy of ' + source.title, source.folderId),
            content: source.content,
            tags: [...(source.tags || [])],
        };
        const updated = [...pages, dup];
        setPages(updated);
        setActivePageId(dup.id);
        persist(updated, folders, dup.id);
        setPageMenu(null);
    };

    const handleMoveToFolder = (pageId, folderId) => {
        const updated = pages.map(p => p.id === pageId ? { ...p, folderId: folderId || null } : p);
        setPages(updated);
        persist(updated, folders, activePageId);
        setPageMenu(null);
    };

    const handleAddTag = (pageId, tag) => {
        const t = tag.trim().toLowerCase();
        if (!t) return;
        const updated = pages.map(p => {
            if (p.id !== pageId) return p;
            if ((p.tags || []).includes(t)) return p;
            return { ...p, tags: [...(p.tags || []), t] };
        });
        setPages(updated);
        persist(updated, folders, activePageId);
    };

    const handleRemoveTag = (pageId, tag) => {
        const updated = pages.map(p =>
            p.id === pageId ? { ...p, tags: (p.tags || []).filter(t => t !== tag) } : p,
        );
        setPages(updated);
        persist(updated, folders, activePageId);
    };

    const handleNewFolder = (parentId = null, inlineName) => {
        const name = (inlineName || newFolderName).trim();
        if (!name) return;
        const f = newFolder(name, parentId);
        const updated = [...folders, f];
        setFolders(updated);
        persist(pages, updated, activePageId);
        if (!inlineName) {
            setNewFolderOpen(false);
            setNewFolderName('');
        }
    };

    const handleDeleteFolder = (folderId) => {
        const descendantIds = getDescendantFolderIds(folderId, folders);
        const allRemovedIds = [folderId, ...descendantIds];
        const updatedPages = pages.map(p => allRemovedIds.includes(p.folderId) ? { ...p, folderId: null } : p);
        const updatedFolders = folders.filter(f => !allRemovedIds.includes(f.id));
        setPages(updatedPages);
        setFolders(updatedFolders);
        if (allRemovedIds.includes(folderFilter)) setFolderFilter('all');
        persist(updatedPages, updatedFolders, activePageId);
    };

    const handleSortChange = (val) => {
        setSortBy(val);
        persist(pages, folders, activePageId, val);
    };

    /* ── Drag-and-drop ────────────────────────────────────── */
    const handleDragStart = (e, pageId) => {
        dragRef.current = pageId;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', pageId);
    };

    const handleDragOver = (e, pageId) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (pageId !== undefined) setDragOverId(pageId);
    };

    const handleDrop = (e, targetId) => {
        e.preventDefault();
        const draggedId = dragRef.current;
        if (!draggedId || draggedId === targetId) return;
        const items = [...processedPages];
        const dragIdx = items.findIndex(p => p.id === draggedId);
        const dropIdx = items.findIndex(p => p.id === targetId);
        if (dragIdx === -1 || dropIdx === -1) return;
        const existingOrders = items.map(p => p.sortOrder ?? 0);
        const [moved] = items.splice(dragIdx, 1);
        items.splice(dropIdx, 0, moved);
        const orderMap = {};
        items.forEach((p, i) => { orderMap[p.id] = existingOrders[i]; });
        const updated = pages.map(p => orderMap[p.id] !== undefined ? { ...p, sortOrder: orderMap[p.id] } : p);
        setPages(updated);
        setSortBy('manual');
        persist(updated, folders, activePageId, 'manual');
        dragRef.current = null;
        setDragOverId(null);
    };

    const handleDragEnd = () => { dragRef.current = null; setDragOverId(null); };

    const handleRestoreSnapshot = (content, title) => {
        const now = new Date().toISOString();
        const updated = pages.map(p =>
            p.id === activePageId
                ? { ...p, content, title: title || p.title, updatedAt: now }
                : p,
        );
        setPages(updated);
        persist(updated, folders, activePageId);
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 2000);
    };

    /* ── Return everything consumers need ─────────────────── */
    return {
        // data
        pages, folders, activePage, activePageId, setActivePageId, processedPages, dropdownPages, wc,
        // ui state
        savedFlash, expanded, setExpanded, maximized, setMaximized, embedded, setEmbedded,
        menuOpen, setMenuOpen, searchQuery, setSearchQuery,
        sortBy, showArchived, setShowArchived,
        folderFilter, setFolderFilter,
        confirmDelete, setConfirmDelete,
        pageMenu, setPageMenu,
        dropdownSearch, setDropdownSearch,
        dragRef, dragOverId,
        // rename
        renamingId, setRenamingId, renameValue, setRenameValue,
        // tags
        tagInput, setTagInput, showTagInput, setShowTagInput,
        // folders
        newFolderOpen, setNewFolderOpen, newFolderName, setNewFolderName,
        // refs
        saveTimerRef, renameRef, menuRef, quillRef, modalQuillRef, searchRef, tagInputRef, pageMenuRef,
        // handlers
        handleContentChange, handleTitleChange,
        handleNewPage, handleSelectPage,
        handleDeletePage, handleConfirmDelete,
        handleStartRename, handleCommitRename,
        handleTogglePin, handleToggleArchive, handleDuplicatePage,
        handleMoveToFolder,
        handleAddTag, handleRemoveTag,
        handleNewFolder, handleDeleteFolder,
        handleSortChange,
        handleRestoreSnapshot,
        handleDragStart, handleDragOver, handleDrop, handleDragEnd,
        persist,
    };
}
