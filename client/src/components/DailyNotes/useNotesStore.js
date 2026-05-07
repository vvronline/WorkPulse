/* ─────────────────────────────────────────────────────────
   useNotesStore – central state + business logic hook.
   Owns: pages, folders, UI state, persistence, all handlers.
   Returns a single "store" object consumed by index.jsx and
   passed down as props to child components.
   ───────────────────────────────────────────────────────── */
import { useState, useEffect, useRef, useCallback } from 'react';
import { newPage, newFolder, getDescendantFolderIds, getDescendantPageIds, extractHeadings } from './notesUtils';
import { useNotesPersistence } from './useNotesPersistence';
import { useNotesFilters } from './useNotesFilters';
import { useClickOutside } from '../../hooks/useClickOutside';
import { getTemplate } from './templates';
import { savePageAsPdf } from './notesExport';

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
    // 'home' = dashboard landing view, 'editor' = page editing view.
    // Only meaningful when embedded (full /notes route). Defaults to 'home'.
    const [view, setView] = useState('home');
    // Floating popovers / palettes (replace the always-visible sidebar)
    const [switcherOpen, setSwitcherOpen] = useState(false);
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [showArchived, setShowArchived] = useState(false);
    const [folderFilter, setFolderFilter] = useState('all');
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [pageMenu, setPageMenu] = useState(null);
    const [dropdownSearch, setDropdownSearch] = useState('');
    const [quickCaptureOpen, setQuickCaptureOpen] = useState(false);
    /* Floating page-link picker (slash-menu → /pagelink) */
    const [pageLinkPicker, setPageLinkPicker] = useState(null); // { quill, range, position }
    /* Draw.io diagram editor (full-screen modal). When non-null,
       NotesPage renders <DrawioEditor> with this state. */
    const [drawioEditor, setDrawioEditor] = useState(null); // { node, initialXml }

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
            if (ctrl && (e.key === 'h' || e.key === 'H') && !e.shiftKey && embedded) {
                e.preventDefault(); openHome();
            }
            // Ctrl+K → command palette (works in editor view, embedded or modal)
            if (ctrl && (e.key === 'k' || e.key === 'K') && !e.shiftKey) {
                e.preventDefault();
                setPaletteOpen(p => !p);
            }
            // Ctrl+Shift+N → quick capture into Inbox page
            if (ctrl && e.shiftKey && (e.key === 'N' || e.key === 'n')) {
                e.preventDefault();
                setQuickCaptureOpen(p => !p);
            }
            // Ctrl+P (without other meta) → page switcher (when not in INPUT/TEXTAREA)
            if (ctrl && e.shiftKey && (e.key === 'O' || e.key === 'o')) {
                // Ctrl+Shift+O → page switcher (avoids conflict with browser print)
                if (!['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
                    e.preventDefault();
                    setSwitcherOpen(p => !p);
                }
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
        setView('editor');
        if (!inlineTitle) {
            setTimeout(() => { setRenamingId(page.id); setRenameValue(title); }, 50);
        }
    };

    const handleSelectPage = (id) => {
        setActivePageId(id);
        persist(pages, folders, id);
        setMenuOpen(false);
        setView('editor');
    };

    /* ── Home / Editor view switching ────────────────────────── */
    const openHome = () => {
        setView('home');
        setMenuOpen(false);
    };

    const openEditor = (id) => {
        if (id) {
            setActivePageId(id);
            persist(pages, folders, id);
        }
        setView('editor');
        setMenuOpen(false);
    };

    /* ── Create page from a template (used by Home quick actions) ── */
    const handleNewFromTemplate = (templateId) => {
        const tpl = getTemplate(templateId);
        const title = (typeof tpl.title === 'function' ? tpl.title() : tpl.title) || 'Untitled';
        const html = (typeof tpl.html === 'function' ? tpl.html() : tpl.html) || '';

        // If template specifies a folder name, find or create it.
        let folderId = null;
        if (tpl.folderName) {
            const existing = folders.find(f => f.name.toLowerCase() === tpl.folderName.toLowerCase() && !f.parentId);
            if (existing) {
                folderId = existing.id;
            } else {
                const f = newFolder(tpl.folderName, null);
                const updatedFolders = [...folders, f];
                setFolders(updatedFolders);
                folderId = f.id;
                // Note: we'll persist together with the new page below.
            }
        }

        const page = { ...newPage(title, folderId), content: html };
        const updatedPages = [...pages, page];
        const finalFolders = tpl.folderName && !folders.some(f => f.id === folderId)
            ? [...folders, { id: folderId, name: tpl.folderName, parentId: null, sortOrder: Date.now() }]
            : folders.some(f => f.id === folderId) || !folderId
                ? folders
                : folders;
        setPages(updatedPages);
        setActivePageId(page.id);
        persist(updatedPages, finalFolders, page.id);
        setView('editor');
        setMenuOpen(false);

        // Only blank pages get auto-rename — others have meaningful titles.
        if (templateId === 'blank') {
            setTimeout(() => { setRenamingId(page.id); setRenameValue(title); }, 50);
        }
    };

    /* ── Open or create today's journal entry ───────────────── */
    const handleOpenTodayJournal = () => {
        const tpl = getTemplate('journal');
        const title = tpl.title();
        const existing = pages.find(p => p.title === title && !p.archived);
        if (existing) {
            openEditor(existing.id);
            return;
        }
        handleNewFromTemplate('journal');
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
        // Cascade: also delete descendant pages so the tree stays consistent.
        const descendantIds = getDescendantPageIds(activePageId, pages);
        const removeIds = new Set([activePageId, ...descendantIds]);
        const updated = pages.filter(p => !removeIds.has(p.id));
        const remaining = updated.filter(p => !p.archived);
        const newActive = remaining[0]?.id || updated[0]?.id;
        setPages(updated);
        setActivePageId(newActive);
        persist(updated, folders, newActive);
    };

    /* ── Update page metadata (icon, cover, readOnly, properties, parentPageId) ── */
    const updatePageMeta = (pageId, patch) => {
        const updated = pages.map(p =>
            p.id === pageId
                ? { ...p, ...patch, updatedAt: new Date().toISOString() }
                : p,
        );
        setPages(updated);
        persist(updated, folders, activePageId);
    };

    const handleSetPageIcon = (pageId, icon, coverColor) => {
        updatePageMeta(pageId, {
            ...(icon !== undefined ? { icon } : {}),
            ...(coverColor !== undefined ? { coverColor } : {}),
        });
    };

    const handleSetPageProperties = (pageId, properties) => {
        updatePageMeta(pageId, { properties });
    };

    const handleToggleReadOnly = (pageId) => {
        const p = pages.find(x => x.id === pageId);
        if (!p) return;
        updatePageMeta(pageId, { readOnly: !p.readOnly });
    };

    const handleToggleReaction = (pageId, emoji, userId) => {
        if (!pageId || !emoji || !userId) return;
        const updated = pages.map(p => {
            if (p.id !== pageId) return p;
            const reactions = { ...(p.reactions || {}) };
            const list = reactions[emoji] ? [...reactions[emoji]] : [];
            const idx = list.indexOf(userId);
            if (idx >= 0) list.splice(idx, 1);
            else list.push(userId);
            if (list.length === 0) delete reactions[emoji];
            else reactions[emoji] = list;
            return { ...p, reactions };
        });
        setPages(updated);
        persist(updated, folders, activePageId);
    };

    /* ── Sub-pages ───────────────────────────────────────── */
    const handleNewSubPage = (parentPageId, title = 'Untitled') => {
        const parent = pages.find(p => p.id === parentPageId);
        const folderId = parent?.folderId || null;
        const child = newPage(title, folderId, parentPageId);
        const updated = [...pages, child];
        setPages(updated);
        setActivePageId(child.id);
        persist(updated, folders, child.id);
        setView('editor');
        setTimeout(() => { setRenamingId(child.id); setRenameValue(title); }, 50);
    };

    const handleMovePageToParent = (pageId, parentPageId) => {
        // Prevent cycles: a page cannot be a descendant of itself.
        if (pageId === parentPageId) return;
        const descendants = getDescendantPageIds(pageId, pages);
        if (parentPageId && descendants.includes(parentPageId)) return;
        updatePageMeta(pageId, { parentPageId: parentPageId || null });
    };

    /* ── Page-link picker (slash-menu helper) ───────────── */
    const openPageLinkPicker = (quill, range) => {
        if (!quill) return;
        let position = null;
        try {
            const bounds = quill.getBounds(range?.index ?? quill.getLength());
            const editorRect = quill.root.getBoundingClientRect();
            position = {
                top: editorRect.top + bounds.bottom + 6,
                left: editorRect.left + bounds.left,
            };
        } catch { /* ignore */ }
        setPageLinkPicker({ quill, range, position });
    };

    const closePageLinkPicker = () => setPageLinkPicker(null);

    const insertPageLink = (target) => {
        const ctx = pageLinkPicker;
        if (!ctx || !ctx.quill || !target) { closePageLinkPicker(); return; }
        const q = ctx.quill;
        const idx = ctx.range?.index ?? q.getLength();
        const title = target.title || 'Untitled';
        q.insertText(idx, title, 'user');
        q.formatText(idx, title.length, 'pagelink', { id: target.id, title }, 'user');
        q.insertText(idx + title.length, ' ', 'user');
        q.setSelection(idx + title.length + 1, 'silent');
        closePageLinkPicker();
    };

    const insertPageLinkForNew = (title) => {
        const ctx = pageLinkPicker;
        if (!ctx || !ctx.quill || !title) { closePageLinkPicker(); return; }
        // Create the new page first, then insert the link to it. Stay on the
        // current page (don't switch the active page) so the link operation
        // feels uninterrupted.
        const created = newPage(title, activePage?.folderId || null);
        const updated = [...pages, created];
        setPages(updated);
        persist(updated, folders, activePageId);
        // Wait one tick so React flushes; then insert.
        setTimeout(() => {
            insertPageLink(created);
        }, 0);
    };

    /* ── Draw.io diagram editor ─────────────────────────────
       The DrawioBlot dispatches a 'notes:drawio-edit' custom
       event when its block is clicked. We listen for it on the
       document and open the modal with the XML pre-loaded. */
    useEffect(() => {
        const onEdit = (e) => {
            const node = e?.detail?.node;
            if (!node || !(node instanceof Element)) return;
            const enc = node.getAttribute('data-xml') || '';
            let xml = '';
            try { xml = decodeURIComponent(enc); } catch { xml = enc; }
            setDrawioEditor({ node, initialXml: xml });
        };
        document.addEventListener('notes:drawio-edit', onEdit);
        return () => document.removeEventListener('notes:drawio-edit', onEdit);
    }, []);

    const closeDrawioEditor = () => setDrawioEditor(null);

    const deleteDrawioBlock = () => {
        const ctx = drawioEditor;
        if (!ctx?.node) { closeDrawioEditor(); return; }
        const q = modalQuillRef?.current?.getEditor
            ? modalQuillRef.current.getEditor()
            : modalQuillRef?.current;
        if (q && q.scroll && typeof q.scroll.find === 'function') {
            try {
                const blot = q.scroll.find(ctx.node);
                if (blot) {
                    const idx = q.getIndex(blot);
                    q.deleteText(idx, blot.length(), 'user');
                }
            } catch { /* ignore */ }
        } else if (ctx.node.parentNode) {
            // Fallback: yank from DOM and re-read HTML
            ctx.node.parentNode.removeChild(ctx.node);
        }
        if (q && q.root) {
            const html = q.root.innerHTML;
            const updated = pages.map(p =>
                p.id === activePageId
                    ? { ...p, content: html, updatedAt: new Date().toISOString() }
                    : p,
            );
            setPages(updated);
            persist(updated, folders, activePageId);
        }
        closeDrawioEditor();
    };

    const saveDrawioEditor = ({ xml, svg }) => {
        const ctx = drawioEditor;
        if (!ctx?.node) { closeDrawioEditor(); return; }
        const node = ctx.node;
        // Update DOM in-place so changes are visible immediately.
        if (xml != null) node.setAttribute('data-xml', encodeURIComponent(xml));
        if (svg) {
            node.innerHTML = svg + '<div class="ql-drawio-overlay">Click to edit</div>';
        } else if (xml) {
            node.innerHTML = '<div class="ql-drawio-empty">📐 Draw.io diagram — click to edit</div>';
        }
        // Persist by reading the active page's content out of Quill (which
        // owns the DOM that the blot lives in).
        const q = modalQuillRef?.current?.getEditor
            ? modalQuillRef.current.getEditor()
            : modalQuillRef?.current;
        if (q && q.root) {
            const html = q.root.innerHTML;
            const updated = pages.map(p =>
                p.id === activePageId
                    ? { ...p, content: html, updatedAt: new Date().toISOString() }
                    : p,
            );
            setPages(updated);
            persist(updated, folders, activePageId);
        }
        closeDrawioEditor();
    };

    /* ── Insert TOC into the current editor ─────────────── */
    const insertTocIntoEditor = (quill) => {
        if (!quill) return;
        const html = quill.root?.innerHTML || '';
        const headings = extractHeadings(html);
        if (headings.length === 0) {
            if (typeof window !== 'undefined') window.alert('Add some H1 / H2 / H3 headings first.');
            return;
        }
        const range = quill.getSelection(true) || { index: 0 };
        // Insert a "Table of contents" heading then a bulleted list of headings.
        let pos = range.index;
        quill.insertText(pos, 'Table of contents\n', 'user');
        quill.formatLine(pos, 1, 'header', 3, 'user');
        pos += 'Table of contents\n'.length;
        headings.forEach(h => {
            const indent = '  '.repeat(Math.max(0, h.level - 1));
            const line = `${indent}${h.text}\n`;
            quill.insertText(pos, line, 'user');
            quill.formatLine(pos, 1, 'list', 'bullet', 'user');
            pos += line.length;
        });
        quill.setSelection(pos, 'silent');
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

    /* ── Quick capture ───────────────────────────────────────
       Append a snippet to (or create) the user's "Inbox" page.
       Each capture becomes a timestamped block so the inbox
       stays chronological and easy to triage. */
    const appendToInbox = (text) => {
        const value = (text || '').trim();
        if (!value) return;
        const inboxName = 'Inbox';
        let inbox = pages.find(p => !p.archived && p.title.toLowerCase() === inboxName.toLowerCase());
        let updatedPages = pages;
        if (!inbox) {
            inbox = { ...newPage(inboxName), pinned: true };
            updatedPages = [...pages, inbox];
        }
        const ts = new Date().toLocaleString(undefined, {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        });
        // Convert plain newlines to <br> so multi-line captures keep shape.
        const safe = value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n/g, '<br>');
        const block =
            `<p><strong>${ts}</strong></p>` +
            `<p>${safe}</p>` +
            `<p><br></p>`;
        const now = new Date().toISOString();
        updatedPages = updatedPages.map(p =>
            p.id === inbox.id
                ? { ...p, content: (p.content || '') + block, updatedAt: now }
                : p,
        );
        setPages(updatedPages);
        persist(updatedPages, folders, activePageId);
    };

    /* ── Export the active page as a downloadable PDF ───── */
    const handleExportPdf = (page) => {
        savePageAsPdf(page || activePage);
    };

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
        view, setView,
        menuOpen, setMenuOpen, searchQuery, setSearchQuery,
        sortBy, showArchived, setShowArchived,
        folderFilter, setFolderFilter,
        confirmDelete, setConfirmDelete,
        pageMenu, setPageMenu,
        dropdownSearch, setDropdownSearch,
        quickCaptureOpen, setQuickCaptureOpen,
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
        // home / editor view switching
        openHome, openEditor,
        handleNewFromTemplate, handleOpenTodayJournal,
        // quick capture + export
        appendToInbox,
        handleExportPdf,
        // floating navigation
        switcherOpen, setSwitcherOpen,
        paletteOpen, setPaletteOpen,
        // page metadata + new features
        handleSetPageIcon,
        handleSetPageProperties,
        handleToggleReadOnly,
        handleToggleReaction,
        handleNewSubPage,
        handleMovePageToParent,
        // page-link picker (slash-menu → /link)
        pageLinkPicker, openPageLinkPicker, closePageLinkPicker,
        insertPageLink, insertPageLinkForNew,
        insertTocIntoEditor,
        // draw.io diagram editor (slash-menu → /drawio)
        drawioEditor, closeDrawioEditor, saveDrawioEditor, deleteDrawioBlock,
        persist,
    };
}
