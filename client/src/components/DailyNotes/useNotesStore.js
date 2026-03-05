/* ─────────────────────────────────────────────────────────
   useNotesStore – central state + business logic hook.
   Owns: pages, folders, UI state, persistence, all handlers.
   Returns a single "store" object consumed by index.jsx and
   passed down as props to child components.
   ───────────────────────────────────────────────────────── */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { getNotes, saveNotes } from '../../api';
import { newPage, newFolder, migratePageModel, getWordCount, stripHtml } from './notesUtils';

export function useNotesStore(userId) {
    /* ── Pages / folders ───────────────────────────────────── */
    const [pages, setPages] = useState([]);
    const [folders, setFolders] = useState([]);

    /* ── Active selection ──────────────────────────────────── */
    const [activePageId, setActivePageId] = useState(null);

    /* ── UI flags ──────────────────────────────────────────── */
    const [savedFlash, setSavedFlash] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const [maximized, setMaximized] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [sortBy, setSortBy] = useState('modified');
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
    const saveTimerRef = useRef(null);
    const renameRef = useRef(null);
    const menuRef = useRef(null);
    const quillRef = useRef(null);
    const modalQuillRef = useRef(null);
    const searchRef = useRef(null);
    const tagInputRef = useRef(null);
    const pageMenuRef = useRef(null);
    const dragRef = useRef(null);

    // Snapshot refs – used in async callbacks / unmount flush
    const latestPages = useRef([]);
    const latestFolders = useRef([]);
    const latestActiveId = useRef(null);
    const latestSortBy = useRef('modified');
    const userIdRef = useRef(userId);

    /* ── Keep snapshot refs in sync ─────────────────────────── */
    useEffect(() => { latestPages.current = pages; }, [pages]);
    useEffect(() => { latestFolders.current = folders; }, [folders]);
    useEffect(() => { latestActiveId.current = activePageId; }, [activePageId]);
    useEffect(() => { latestSortBy.current = sortBy; }, [sortBy]);
    useEffect(() => { userIdRef.current = userId; }, [userId]);

    /* ── Derived values ─────────────────────────────────────── */
    const activePage = pages.find(p => p.id === activePageId) || null;

    const wc = useMemo(
        () => activePage ? getWordCount(activePage.content) : { words: 0, chars: 0 },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [activePage?.content],
    );

    const processedPages = useMemo(() => {
        let list = pages.filter(p => showArchived ? p.archived : !p.archived);
        if (folderFilter !== 'all') {
            list = folderFilter === 'none'
                ? list.filter(p => !p.folderId)
                : list.filter(p => p.folderId === folderFilter);
        }
        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase();
            list = list.filter(p =>
                p.title.toLowerCase().includes(q) ||
                stripHtml(p.content).toLowerCase().includes(q) ||
                (p.tags || []).some(t => t.toLowerCase().includes(q)),
            );
        }
        return [...list].sort((a, b) => {
            if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
            switch (sortBy) {
                case 'name': return a.title.localeCompare(b.title);
                case 'created': return new Date(b.createdAt) - new Date(a.createdAt);
                case 'manual': return (a.sortOrder || 0) - (b.sortOrder || 0);
                default: return new Date(b.updatedAt) - new Date(a.updatedAt);
            }
        });
    }, [pages, showArchived, folderFilter, searchQuery, sortBy]);

    const dropdownPages = useMemo(() => {
        let list = pages.filter(p => !p.archived);
        if (dropdownSearch.trim()) {
            const q = dropdownSearch.toLowerCase();
            list = list.filter(p => p.title.toLowerCase().includes(q));
        }
        return [...list].sort((a, b) => {
            if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
            return new Date(b.updatedAt) - new Date(a.updatedAt);
        });
    }, [pages, dropdownSearch]);

    /* ── Server persistence ─────────────────────────────────── */
    const saveToServer = useCallback(async (data) => {
        try {
            await saveNotes(data);
        } catch (e) {
            console.error('Failed to save notes:', e);
            if (userIdRef.current)
                localStorage.setItem('workpulse-notes-' + userIdRef.current, JSON.stringify(data));
        }
    }, []);

    const persist = useCallback((pgs, flds, aid, sort) => {
        saveToServer({
            pages: pgs ?? latestPages.current,
            folders: flds ?? latestFolders.current,
            activePageId: aid ?? latestActiveId.current,
            sortBy: sort ?? latestSortBy.current,
        });
    }, [saveToServer]);

    const scheduleAutoSave = useCallback((pgs, flds, aid) => {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
            persist(pgs, flds, aid);
            setSavedFlash(true);
            setTimeout(() => setSavedFlash(false), 2000);
        }, 10000);
    }, [persist]);

    /* ── Load on mount ──────────────────────────────────────── */
    useEffect(() => {
        if (!userId) return;
        let cancelled = false;
        (async () => {
            try {
                const res = await getNotes();
                if (cancelled) return;
                if (res.data?.data) {
                    const nb = res.data.data;
                    const pgs = (nb.pages || []).map(migratePageModel);
                    const flds = nb.folders || [];
                    if (pgs.length > 0) {
                        setPages(pgs);
                        setFolders(flds);
                        setActivePageId(nb.activePageId || pgs[0]?.id);
                        setSortBy(nb.sortBy || 'modified');
                        return;
                    }
                }
            } catch (e) {
                console.warn('Could not load from server, checking localStorage:', e.message);
            }
            try {
                const raw = localStorage.getItem('workpulse-notes-' + userId);
                if (raw) {
                    const nb = JSON.parse(raw);
                    if (nb.pages?.length > 0) {
                        const pgs = nb.pages.map(migratePageModel);
                        const flds = nb.folders || [];
                        if (!cancelled) {
                            setPages(pgs);
                            setFolders(flds);
                            setActivePageId(nb.activePageId || pgs[0]?.id);
                            setSortBy(nb.sortBy || 'modified');
                            saveToServer({ pages: pgs, folders: flds, activePageId: nb.activePageId || pgs[0]?.id, sortBy: nb.sortBy || 'modified' });
                        }
                        return;
                    }
                }
            } catch { /* ignore */ }
            if (!cancelled) {
                const first = newPage('My Notes');
                setPages([first]);
                setActivePageId(first.id);
            }
        })();
        return () => { cancelled = true; };
    }, [userId, saveToServer]);

    /* ── Flush on unmount / page unload ─────────────────────── */
    useEffect(() => {
        const flush = () => {
            clearTimeout(saveTimerRef.current);
            if (userIdRef.current && latestPages.current.length > 0) {
                const data = {
                    pages: latestPages.current, folders: latestFolders.current,
                    activePageId: latestActiveId.current, sortBy: latestSortBy.current,
                };
                localStorage.setItem('workpulse-notes-' + userIdRef.current, JSON.stringify(data));
                saveToServer(data).catch(() => { });
            }
        };
        window.addEventListener('beforeunload', flush);
        return () => { window.removeEventListener('beforeunload', flush); flush(); };
    }, [saveToServer]);

    /* ── Focus rename input when it mounts ──────────────────── */
    useEffect(() => {
        if (renamingId && renameRef.current) {
            renameRef.current.focus();
            renameRef.current.select();
        }
    }, [renamingId]);

    /* ── Close page-switcher dropdown on outside click ──────── */
    useEffect(() => {
        if (!menuOpen) return;
        const h = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
        document.addEventListener('mousedown', h);
        return () => document.removeEventListener('mousedown', h);
    }, [menuOpen]);

    /* ── Close page context menu on outside click ───────────── */
    useEffect(() => {
        if (!pageMenu) return;
        const h = (e) => { if (pageMenuRef.current && !pageMenuRef.current.contains(e.target)) setPageMenu(null); };
        document.addEventListener('mousedown', h);
        return () => document.removeEventListener('mousedown', h);
    }, [pageMenu]);

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
            const active = expanded || maximized;
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
    }, [expanded, maximized, pages, folders, activePageId, sortBy, persist]);

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

    const handleNewPage = (explicitFolderId) => {
        // Guard: if called as an onClick handler, explicitFolderId will be a synthetic
        // event or DOM element — treat it as "no explicit folder" in that case.
        const validFolder = (typeof explicitFolderId === 'string' || explicitFolderId === null)
            ? explicitFolderId
            : undefined;
        const folderId = validFolder !== undefined
            ? validFolder
            : (folderFilter !== 'all' && folderFilter !== 'none' ? folderFilter : null);
        const page = newPage('Untitled', folderId);
        const updated = [...pages, page];
        setPages(updated);
        setActivePageId(page.id);
        persist(updated, folders, page.id);
        setMenuOpen(false);
        setTimeout(() => { setRenamingId(page.id); setRenameValue('Untitled'); }, 50);
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

    const handleNewFolder = () => {
        const name = newFolderName.trim();
        if (!name) return;
        const f = newFolder(name);
        const updated = [...folders, f];
        setFolders(updated);
        persist(pages, updated, activePageId);
        setNewFolderOpen(false);
        setNewFolderName('');
    };

    const handleDeleteFolder = (folderId) => {
        const updatedPages = pages.map(p => p.folderId === folderId ? { ...p, folderId: null } : p);
        const updatedFolders = folders.filter(f => f.id !== folderId);
        setPages(updatedPages);
        setFolders(updatedFolders);
        if (folderFilter === folderId) setFolderFilter('all');
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
        savedFlash, expanded, setExpanded, maximized, setMaximized,
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
