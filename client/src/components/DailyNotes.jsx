import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import ReactQuill from 'react-quill-new';
import 'react-quill-new/dist/quill.snow.css';
import { getNotes, saveNotes } from '../api';
import ConfirmDialog from './ConfirmDialog';
import ImageResizer from './ImageResizer';
import s from './DailyNotes.module.css';

/* ── Register custom Quill blot: horizontal rule (#3) ── */
const Quill = ReactQuill.Quill;
const BlockEmbed = Quill.import('blots/block/embed');

class DividerBlot extends BlockEmbed {
  static create() {
    const node = super.create();
    return node;
  }
}
DividerBlot.blotName = 'divider';
DividerBlot.tagName = 'hr';
Quill.register(DividerBlot, true);

/* ── Quill toolbar config ── */
const QUILL_MODULES = {
  toolbar: {
    container: [
      [{ header: [1, 2, 3, false] }],
      ['bold', 'italic', 'underline'],
      [{ color: [] }, { background: [] }],
      [{ list: 'ordered' }, { list: 'bullet' }, { list: 'check' }],
      ['blockquote', 'link', 'image'],
      ['divider', 'timestamp'],
      ['clean'],
    ],
    handlers: {
      divider() {
        const q = this.quill;
        const range = q.getSelection(true);
        q.insertText(range.index, '\n', Quill.sources.USER);
        q.insertEmbed(range.index + 1, 'divider', true, Quill.sources.USER);
        q.setSelection(range.index + 2, Quill.sources.SILENT);
      },
      timestamp() {
        const q = this.quill;
        const range = q.getSelection(true);
        const str = new Date().toLocaleString(undefined, {
          year: 'numeric', month: 'short', day: 'numeric',
          hour: '2-digit', minute: '2-digit',
        });
        q.insertText(range.index, str, Quill.sources.USER);
        q.setSelection(range.index + str.length, Quill.sources.SILENT);
      },
    },
  },
  history: { delay: 1000, maxStack: 100, userOnly: false },
};

/* ── Constants ── */
const TAG_COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ef4444', '#14b8a6'];

/* ── Helpers ── */
function newPage(title = 'Untitled', folderId = null) {
  return {
    id: crypto.randomUUID(), title, content: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pinned: false, tags: [], folderId,
    archived: false, sortOrder: Date.now(),
  };
}

function newFolder(name) {
  return { id: crypto.randomUUID(), name, sortOrder: Date.now() };
}

function formatDate(iso) {
  const d = new Date(iso);
  const diff = Math.floor((Date.now() - d) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function stripHtml(html) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  return doc.body.textContent || '';
}

function getWordCount(html) {
  const text = stripHtml(html).trim();
  if (!text) return { words: 0, chars: 0 };
  return { words: text.split(/\s+/).length, chars: text.length };
}

function tagColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return TAG_COLORS[Math.abs(h) % TAG_COLORS.length];
}

function migratePageModel(page) {
  return {
    id: page.id,
    title: page.title || 'Untitled',
    content: page.content || '',
    createdAt: page.createdAt || page.updatedAt || new Date().toISOString(),
    updatedAt: page.updatedAt || new Date().toISOString(),
    pinned: !!page.pinned,
    tags: page.tags || [],
    folderId: page.folderId || null,
    archived: !!page.archived,
    sortOrder: page.sortOrder ?? Date.now(),
  };
}

/* ================================================================ */
export default function DailyNotes({ userId }) {
  /* ── State ── */
  const [pages, setPages]               = useState([]);
  const [folders, setFolders]           = useState([]);
  const [activePageId, setActivePageId] = useState(null);
  const [savedFlash, setSavedFlash]     = useState(false);
  const [menuOpen, setMenuOpen]         = useState(false);
  const [renamingId, setRenamingId]     = useState(null);
  const [renameValue, setRenameValue]   = useState('');
  const [expanded, setExpanded]         = useState(false);
  const [maximized, setMaximized]       = useState(false);
  const [searchQuery, setSearchQuery]   = useState('');
  const [searchOpen, setSearchOpen]     = useState(false);
  const [sortBy, setSortBy]             = useState('modified');
  const [showArchived, setShowArchived] = useState(false);
  const [folderFilter, setFolderFilter] = useState('all');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tagInput, setTagInput]         = useState('');
  const [showTagInput, setShowTagInput] = useState(false);
  const [pageMenu, setPageMenu]         = useState(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [dropdownSearch, setDropdownSearch] = useState('');
  const [dragOverId, setDragOverId]         = useState(null);

  /* ── Refs ── */
  const saveTimerRef   = useRef(null);
  const renameRef      = useRef(null);
  const menuRef        = useRef(null);
  const quillRef       = useRef(null);
  const modalQuillRef  = useRef(null);
  const latestPages    = useRef([]);
  const latestFolders  = useRef([]);
  const latestActiveId = useRef(null);
  const latestSortBy   = useRef('modified');
  const userIdRef      = useRef(userId);
  const dragRef        = useRef(null);
  const searchRef      = useRef(null);
  const tagInputRef    = useRef(null);
  const pageMenuRef    = useRef(null);

  /* ── Sync refs ── */
  useEffect(() => { latestPages.current = pages; }, [pages]);
  useEffect(() => { latestFolders.current = folders; }, [folders]);
  useEffect(() => { latestActiveId.current = activePageId; }, [activePageId]);
  useEffect(() => { latestSortBy.current = sortBy; }, [sortBy]);
  useEffect(() => { userIdRef.current = userId; }, [userId]);

  /* ── Computed ── */
  const activePage = pages.find(p => p.id === activePageId) || null;

  const allTags = useMemo(() => {
    const set = new Set();
    pages.forEach(p => (p.tags || []).forEach(t => set.add(t)));
    return [...set].sort();
  }, [pages]);

  const wc = useMemo(
    () => activePage ? getWordCount(activePage.content) : { words: 0, chars: 0 },
    [activePage?.content]
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
        (p.tags || []).some(t => t.toLowerCase().includes(q))
      );
    }
    const sorter = (a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      switch (sortBy) {
        case 'name': return a.title.localeCompare(b.title);
        case 'created': return new Date(b.createdAt) - new Date(a.createdAt);
        case 'manual': return (a.sortOrder || 0) - (b.sortOrder || 0);
        default: return new Date(b.updatedAt) - new Date(a.updatedAt);
      }
    };
    return [...list].sort(sorter);
  }, [pages, showArchived, folderFilter, searchQuery, sortBy]);

  /* Dropdown pages (for inline switcher) */
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

  /* ── Server persistence ── */
  const saveToServer = useCallback(async (data) => {
    try { await saveNotes(data); }
    catch (e) {
      console.error('Failed to save notes to server:', e);
      if (userIdRef.current)
        localStorage.setItem('workpulse-notes-' + userIdRef.current, JSON.stringify(data));
    }
  }, []);

  const buildData = useCallback((pgs, flds, aid, sort) => ({
    pages: pgs, folders: flds, activePageId: aid, sortBy: sort,
  }), []);

  const persist = useCallback((pgs, flds, aid, sort) => {
    const data = buildData(
      pgs ?? latestPages.current,
      flds ?? latestFolders.current,
      aid ?? latestActiveId.current,
      sort ?? latestSortBy.current,
    );
    saveToServer(data);
  }, [saveToServer, buildData]);

  const scheduleAutoSave = useCallback((pgs, flds, aid) => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      persist(pgs, flds, aid);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    }, 400);
  }, [persist]);

  /* ── Load data on mount ── */
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
      // Fallback: localStorage (migration from old storage)
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

  /* ── Flush on unmount / beforeunload ── */
  useEffect(() => {
    const flush = () => {
      clearTimeout(saveTimerRef.current);
      if (userIdRef.current && latestPages.current.length > 0) {
        const data = {
          pages: latestPages.current, folders: latestFolders.current,
          activePageId: latestActiveId.current, sortBy: latestSortBy.current,
        };
        localStorage.setItem('workpulse-notes-' + userIdRef.current, JSON.stringify(data));
        saveToServer(data).catch(() => {});
      }
    };
    window.addEventListener('beforeunload', flush);
    return () => { window.removeEventListener('beforeunload', flush); flush(); };
  }, [saveToServer]);

  /* ── Focus rename ── */
  useEffect(() => {
    if (renamingId && renameRef.current) { renameRef.current.focus(); renameRef.current.select(); }
  }, [renamingId]);

  /* ── Close menus on outside click ── */
  useEffect(() => {
    if (!menuOpen) return;
    const h = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [menuOpen]);

  useEffect(() => {
    if (!pageMenu) return;
    const h = (e) => { if (pageMenuRef.current && !pageMenuRef.current.contains(e.target)) setPageMenu(null); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [pageMenu]);

  /* ── Escape closes maximized ── */
  useEffect(() => {
    if (!maximized) return;
    const h = (e) => { if (e.key === 'Escape') setMaximized(false); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [maximized]);

  /* ── Prevent body scroll when maximized ── */
  useEffect(() => {
    document.body.style.overflow = maximized ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [maximized]);

  /* ── Keyboard shortcuts (#21) ── */
  useEffect(() => {
    const h = (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const active = expanded || maximized;
      if (!active) return;

      // Ctrl+N — new page
      if (ctrl && e.key === 'n' && !e.shiftKey) {
        e.preventDefault(); handleNewPage();
      }
      // Ctrl+S — save now
      if (ctrl && e.key === 's' && !e.shiftKey) {
        e.preventDefault();
        clearTimeout(saveTimerRef.current);
        persist(pages, folders, activePageId, sortBy);
        setSavedFlash(true); setTimeout(() => setSavedFlash(false), 2000);
      }
      // Ctrl+Shift+F — focus search (works in both expanded & maximized)
      if (ctrl && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
        e.preventDefault();
        setTimeout(() => searchRef.current?.focus(), 50);
      }
      // Ctrl+P — pin / unpin active page
      if (ctrl && e.key === 'p' && !e.shiftKey && activePageId) {
        // Only intercept when not inside an input/textarea to avoid blocking browser print
        if (!['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
          e.preventDefault(); togglePin(activePageId);
        }
      }
      // Ctrl+D — duplicate active page
      if (ctrl && e.key === 'd' && !e.shiftKey && activePageId) {
        e.preventDefault(); duplicatePage(activePageId);
      }
      // Ctrl+Shift+A — archive / unarchive active page
      if (ctrl && e.shiftKey && (e.key === 'A' || e.key === 'a') && activePageId) {
        e.preventDefault(); toggleArchive(activePageId);
      }
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [expanded, maximized, pages, folders, activePageId, sortBy, persist]);

  /* ══════════════════════════ Handlers ══════════════════════════ */

  const handleContentChange = (content) => {
    const updated = pages.map(p =>
      p.id === activePageId ? { ...p, content, updatedAt: new Date().toISOString() } : p
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
    // Auto-assign to the active folder filter if no explicit folder given
    const folderId = explicitFolderId !== undefined
      ? explicitFolderId
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

  /* Delete with confirmation (#20) */
  const handleDeletePage = () => setConfirmDelete(true);

  const confirmDeletePage = () => {
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

  const startRename = (page) => {
    setRenamingId(page.id);
    setRenameValue(page.title);
    setMenuOpen(false);
  };

  const commitRename = () => {
    if (!renamingId) return;
    const title = renameValue.trim() || 'Untitled';
    const updated = pages.map(p => p.id === renamingId ? { ...p, title } : p);
    setPages(updated);
    persist(updated, folders, activePageId);
    setRenamingId(null);
  };

  /* Pin (#7) */
  const togglePin = (pageId) => {
    const updated = pages.map(p => p.id === pageId ? { ...p, pinned: !p.pinned } : p);
    setPages(updated);
    persist(updated, folders, activePageId);
  };

  /* Archive (#14) */
  const toggleArchive = (pageId) => {
    const updated = pages.map(p =>
      p.id === pageId ? { ...p, archived: !p.archived, updatedAt: new Date().toISOString() } : p
    );
    setPages(updated);
    if (pageId === activePageId) {
      const remaining = updated.filter(p => !p.archived);
      const newActive = remaining.length > 0 ? remaining[0].id : updated[0]?.id;
      setActivePageId(newActive);
      persist(updated, folders, newActive);
    } else {
      persist(updated, folders, activePageId);
    }
    setPageMenu(null);
  };

  /* Duplicate (#13) */
  const duplicatePage = (pageId) => {
    const source = pages.find(p => p.id === pageId);
    if (!source) return;
    const dup = { ...newPage('Copy of ' + source.title), content: source.content, tags: [...(source.tags || [])], folderId: source.folderId };
    const updated = [...pages, dup];
    setPages(updated);
    setActivePageId(dup.id);
    persist(updated, folders, dup.id);
    setPageMenu(null);
  };

  /* Move to folder (#12) */
  const moveToFolder = (pageId, folderId) => {
    const updated = pages.map(p => p.id === pageId ? { ...p, folderId: folderId || null } : p);
    setPages(updated);
    persist(updated, folders, activePageId);
    setPageMenu(null);
  };

  /* Tags (#8) */
  const addTag = (pageId, tag) => {
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

  const removeTag = (pageId, tag) => {
    const updated = pages.map(p => p.id === pageId ? { ...p, tags: (p.tags || []).filter(t => t !== tag) } : p);
    setPages(updated);
    persist(updated, folders, activePageId);
  };

  /* Folders (#12) */
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

  const deleteFolder = (folderId) => {
    const updatedPages = pages.map(p => p.folderId === folderId ? { ...p, folderId: null } : p);
    const updatedFolders = folders.filter(f => f.id !== folderId);
    setPages(updatedPages);
    setFolders(updatedFolders);
    if (folderFilter === folderId) setFolderFilter('all');
    persist(updatedPages, updatedFolders, activePageId);
  };

  /* Sort (#15) */
  const handleSortChange = (val) => {
    setSortBy(val);
    persist(pages, folders, activePageId, val);
  };

  /* Drag-and-drop (#11) */
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
    // Snapshot existing sortOrders before reordering so we reuse those values
    // rather than assigning 0-based indices (which would collide with non-visible pages)
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

  if (!userId) return null;

  /* ═══════════════════════ Render helpers ═══════════════════════ */
  const folderName = (fid) => folders.find(f => f.id === fid)?.name || '';

  const renderTagDots = (page) => {
    if (!(page.tags || []).length) return null;
    return (
      <span className={s.tagDots}>
        {page.tags.slice(0, 4).map(t => (
          <span key={t} className={s.tagDot} style={{ background: tagColor(t) }} title={t} />
        ))}
      </span>
    );
  };

  /* Tag editor (modal editor area) */
  const renderTagEditor = () => {
    if (!activePage) return null;
    return (
      <div className={s.tagRow}>
        {(activePage.tags || []).map(tag => (
          <span key={tag} className={s.tagPill} style={{ '--tag-color': tagColor(tag) }}>
            {tag}
            <button className={s.tagRemove} onClick={() => removeTag(activePage.id, tag)}>×</button>
          </span>
        ))}
        {showTagInput ? (
          <input
            ref={tagInputRef}
            className={s.tagAddInput}
            value={tagInput}
            onChange={e => setTagInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && tagInput.trim()) { addTag(activePage.id, tagInput); setTagInput(''); }
              if (e.key === 'Escape') { setShowTagInput(false); setTagInput(''); }
            }}
            onBlur={() => { if (tagInput.trim()) addTag(activePage.id, tagInput); setShowTagInput(false); setTagInput(''); }}
            placeholder="Tag name…"
            autoFocus
          />
        ) : (
          <button className={s.tagAddBtn} onClick={() => { setShowTagInput(true); setTagInput(''); }}>+ tag</button>
        )}
      </div>
    );
  };

  /* Page context menu (modal sidebar) */
  const renderPageMenu = (page) => {
    if (pageMenu !== page.id) return null;
    return (
      <div className={s.ctxMenu} ref={pageMenuRef}>
        <button className={s.ctxItem} onClick={() => { startRename(page); setPageMenu(null); }}>
          ✏️ Rename
        </button>
        <button className={s.ctxItem} onClick={() => togglePin(page.id)}>
          {page.pinned ? '📌 Unpin' : '📌 Pin to top'}
        </button>
        <button className={s.ctxItem} onClick={() => duplicatePage(page.id)}>
          📋 Duplicate
        </button>
        <button className={s.ctxItem} onClick={() => toggleArchive(page.id)}>
          {page.archived ? '📤 Unarchive' : '📦 Archive'}
        </button>
        {folders.length > 0 && (
          <div className={s.ctxFolder}>
            <span className={s.ctxFolderLabel}>Move to:</span>
            <button className={`${s.ctxItem} ${s.ctxSmall}`} onClick={() => moveToFolder(page.id, null)}>
              — None
            </button>
            {folders.map(f => (
              <button key={f.id} className={`${s.ctxItem} ${s.ctxSmall} ${page.folderId === f.id ? s.ctxActive : ''}`}
                onClick={() => moveToFolder(page.id, f.id)}>
                📁 {f.name}
              </button>
            ))}
          </div>
        )}
        <div className={s.ctxDivider} />
        <button className={`${s.ctxItem} ${s.ctxDanger}`} onClick={() => { setPageMenu(null); setActivePageId(page.id); handleDeletePage(); }}>
          🗑️ Delete
        </button>
      </div>
    );
  };

  /* ═══════════════════════════ JSX ═══════════════════════════════ */
  return (
    <>
    <div className={`${s.root} ${expanded ? s.rootExpanded : ''}`}>
      {/* Header */}
      <div className={s.header}>
        <button className={s.headerLeft} onClick={() => setExpanded(o => !o)}
          aria-expanded={expanded} title={expanded ? 'Collapse notes' : 'Expand notes'}>
          <svg className={s.notesIcon} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clipRule="evenodd"/>
          </svg>
          <span className={s.headerTitle}>Notes</span>
          {savedFlash && <span className={s.savedBadge}>✓ Saved</span>}
          <svg className={`${s.expandChevron} ${expanded ? s.expandChevronOpen : ''}`}
            viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M2 4l4 4 4-4"/>
          </svg>
        </button>

        {expanded && (
          <div className={s.headerRight}>
            {/* Page switcher */}
            <div className={s.switcher} ref={menuRef}>
              <button className={s.switcherBtn} onClick={() => { setMenuOpen(o => !o); setDropdownSearch(''); }} title="Switch page">
                {activePage?.pinned && <span className={s.pinSmall}>📌</span>}
                <span className={s.switcherName}>{activePage?.title || '—'}</span>
                <svg className={s.switcherChevron} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M2 4l4 4 4-4"/>
                </svg>
              </button>

              {menuOpen && (
                <div className={s.menu}>
                  {/* Search in dropdown (#6) */}
                  <div className={s.menuSearchWrap}>
                    <input className={s.menuSearchInput} placeholder="Search pages…" value={dropdownSearch}
                      onChange={e => setDropdownSearch(e.target.value)} autoFocus />
                  </div>
                  <div className={s.menuLabel}>Pages ({dropdownPages.length})</div>
                  <div className={s.menuList}>
                    {dropdownPages.map(page => (
                      <div key={page.id} className={`${s.menuItem} ${page.id === activePageId ? s.menuItemActive : ''}`}>
                        {renamingId === page.id ? (
                          <input ref={renameRef} className={s.renameInput} value={renameValue}
                            onChange={e => setRenameValue(e.target.value)}
                            onBlur={commitRename}
                            onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenamingId(null); }}
                            onClick={e => e.stopPropagation()} />
                        ) : (
                          <>
                            <button className={s.menuItemBtn} onClick={() => handleSelectPage(page.id)}>
                              {page.pinned && <span className={s.pinSmall}>📌</span>}
                              <span className={s.menuItemName}>{page.title}</span>
                              {renderTagDots(page)}
                              <span className={s.menuItemDate}>{formatDate(page.updatedAt)}</span>
                            </button>
                            <button className={s.menuItemRename} onClick={() => startRename(page)} title="Rename">
                              <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M9.5 2.5l2 2L4 12H2v-2L9.5 2.5z"/>
                              </svg>
                            </button>
                          </>
                        )}
                      </div>
                    ))}
                    {dropdownPages.length === 0 && <div className={s.menuEmpty}>No pages found</div>}
                  </div>
                  <button className={s.menuNewBtn} onClick={handleNewPage}>
                    <svg viewBox="0 0 14 14" fill="currentColor"><path d="M7 1a1 1 0 011 1v4h4a1 1 0 010 2H8v4a1 1 0 01-2 0V8H2a1 1 0 010-2h4V2a1 1 0 011-1z"/></svg>
                    New page
                  </button>
                </div>
              )}
            </div>

            {/* Maximize */}
            <button className={s.maximizeBtn} onClick={() => setMaximized(true)} title="Maximize notes">
              <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 5V2h3M9 2h3v3M12 9v3H9M5 12H2V9"/>
              </svg>
            </button>

            {/* Delete */}
            <button className={s.deleteBtn} onClick={handleDeletePage} title="Delete page">
              <svg viewBox="0 0 14 14" fill="currentColor">
                <path d="M5 1h4a1 1 0 010 2H5a1 1 0 010-2zM2 4h10l-.9 8.1A1 1 0 0110.1 13H3.9a1 1 0 01-1-.9L2 4zm3 2a.5.5 0 00-.5.5v4a.5.5 0 001 0v-4A.5.5 0 005 6zm4 0a.5.5 0 00-.5.5v4a.5.5 0 001 0v-4A.5.5 0 009 6z"/>
              </svg>
            </button>
          </div>
        )}
      </div>

      {/* Inline editor */}
      {expanded && (activePage ? (
        <div className={s.editor}>
          <input className={s.titleInput} value={activePage.title} onChange={handleTitleChange} placeholder="Page title…" />
          {/* Inline folder assignment */}
          {folders.length > 0 && (
            <div className={s.inlineMeta}>
              <select className={s.inlineFolderSelect} value={activePage.folderId || ''}
                onChange={e => moveToFolder(activePage.id, e.target.value || null)}>
                <option value="">No folder</option>
                {folders.map(f => <option key={f.id} value={f.id}>📁 {f.name}</option>)}
              </select>
            </div>
          )}
          <div className={s.quillWrap}>
            <ReactQuill key={activePageId} ref={quillRef} theme="snow" defaultValue={activePage.content}
              onChange={handleContentChange} modules={QUILL_MODULES} placeholder="Start writing…" />
          </div>
          <ImageResizer quillRef={quillRef} />
          {/* Word count (#9) */}
          <div className={s.wordCountBar}>
            {wc.words} words · {wc.chars} chars
          </div>
        </div>
      ) : (
        <div className={s.empty}>
          <p>No pages yet</p>
          <button className="btn btn-primary btn-sm" onClick={handleNewPage}>+ New page</button>
        </div>
      ))}
    </div>

    {/* ── Maximized portal ── */}
    {maximized && createPortal(
      <div className={s.overlay} onClick={e => { if (e.target === e.currentTarget) setMaximized(false); }}>
        <div className={s.modal}>
          {/* Modal header */}
          <div className={s.modalHeader}>
            <div className={s.modalHeaderLeft}>
              <svg className={s.notesIcon} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clipRule="evenodd"/>
              </svg>
              <span className={s.headerTitle}>Notes</span>
              {savedFlash && <span className={s.savedBadge}>✓ Saved</span>}
            </div>
            <div className={s.modalHeaderRight}>
              <span className={s.shortcutHint}>Ctrl+N new · Ctrl+S save · Ctrl+Shift+F search · Ctrl+D duplicate · Ctrl+P pin</span>
              <button className={s.modalNewBtn} onClick={handleNewPage}>
                <svg viewBox="0 0 14 14" fill="currentColor"><path d="M7 1a1 1 0 011 1v4h4a1 1 0 010 2H8v4a1 1 0 01-2 0V8H2a1 1 0 010-2h4V2a1 1 0 011-1z"/></svg>
                New page
              </button>
              <button className={s.closeBtn} onClick={() => setMaximized(false)} title="Close (Esc)">
                <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M2 2l10 10M12 2L2 12"/>
                </svg>
              </button>
            </div>
          </div>

          {/* Modal body */}
          <div className={s.modalBody}>
            {/* ── Sidebar ── */}
            <div className={s.modalSidebar}>
              {/* Search (#6) */}
              <div className={s.sidebarSearch}>
                <input ref={searchRef} className={s.sidebarSearchInput} placeholder="Search…"
                  value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
                {searchQuery && (
                  <button className={s.searchClear} onClick={() => setSearchQuery('')}>×</button>
                )}
              </div>

              {/* Sort & Filter row (#15) */}
              <div className={s.sidebarControls}>
                <select className={s.sidebarSelect} value={sortBy} onChange={e => handleSortChange(e.target.value)} title="Sort by">
                  <option value="modified">Modified</option>
                  <option value="created">Created</option>
                  <option value="name">Name</option>
                  <option value="manual">Manual</option>
                </select>
                <select className={s.sidebarSelect} value={folderFilter} onChange={e => setFolderFilter(e.target.value)} title="Filter folder">
                  <option value="all">All folders</option>
                  <option value="none">Uncategorized</option>
                  {folders.map(f => <option key={f.id} value={f.id}>📁 {f.name}</option>)}
                </select>
              </div>

              {/* Archive toggle (#14) */}
              <label className={s.archiveToggle}>
                <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} />
                <span>Show archived</span>
              </label>

              {/* Page list */}
              <div className={s.sidebarList}>
                {processedPages.map(page => (
                  <div
                    key={page.id}
                    className={`${s.modalPageItem} ${page.id === activePageId ? s.modalPageActive : ''} ${page.archived ? s.modalPageArchived : ''} ${dragOverId === page.id && dragRef.current !== page.id ? s.dragOver : ''} ${dragRef.current === page.id ? s.dragging : ''}`}
                    onClick={() => handleSelectPage(page.id)}
                    draggable
                    onDragStart={e => handleDragStart(e, page.id)}
                    onDragOver={e => handleDragOver(e, page.id)}
                    onDrop={e => handleDrop(e, page.id)}
                    onDragEnd={handleDragEnd}
                  >
                    <div className={s.modalPageRow}>
                      {page.pinned && <span className={s.pinIcon} title="Pinned">📌</span>}
                      <svg className={s.modalPageIcon} viewBox="0 0 14 14" fill="currentColor">
                        <path d="M3 2a1 1 0 011-1h4.586a1 1 0 01.707.293l2.414 2.414A1 1 0 0112 4.414V12a1 1 0 01-1 1H4a1 1 0 01-1-1V2zm2 5a.5.5 0 000 1h4a.5.5 0 000-1H5zm0 2a.5.5 0 000 1h4a.5.5 0 000-1H5z"/>
                      </svg>
                      <div className={s.modalPageInfo}>
                        {renamingId === page.id ? (
                          <input ref={renameRef} className={s.renameInput} value={renameValue}
                            onChange={e => setRenameValue(e.target.value)}
                            onBlur={commitRename}
                            onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenamingId(null); }}
                            onClick={e => e.stopPropagation()} />
                        ) : (
                          <span className={s.modalPageName} onDoubleClick={e => { e.stopPropagation(); startRename(page); }}
                            title="Double-click to rename">
                            {page.title}
                          </span>
                        )}
                        <div className={s.modalPageMeta}>
                          <span className={s.modalPageDate}>{formatDate(page.updatedAt)}</span>
                          {page.folderId && <span className={s.modalPageFolder}>📁 {folderName(page.folderId)}</span>}
                          {renderTagDots(page)}
                        </div>
                      </div>
                      {/* Context menu button */}
                      <button className={s.pageMenuBtn} onClick={e => { e.stopPropagation(); setPageMenu(pageMenu === page.id ? null : page.id); }}
                        title="More actions">⋯</button>
                    </div>
                    {renderPageMenu(page)}
                  </div>
                ))}
                {processedPages.length === 0 && (
                  <div className={s.sidebarEmpty}>
                    {searchQuery ? 'No pages match your search' : showArchived ? 'No archived pages' : 'No pages yet'}
                  </div>
                )}
              </div>

              {/* Folder management (#12) */}
              <div className={s.sidebarFooter}>
                {folders.length > 0 && (
                  <div className={s.folderList}>
                    <span className={s.folderListLabel}>Folders</span>
                    {folders.map(f => (
                      <div key={f.id} className={s.folderItem}>
                        <span className={s.folderItemName}>📁 {f.name}</span>
                        <div className={s.folderItemActions}>
                          <button className={s.folderAddBtn} onClick={() => handleNewPage(f.id)}
                            title={`New page in "${f.name}"`}>+</button>
                          <button className={s.folderDeleteBtn} onClick={() => deleteFolder(f.id)} title="Delete folder">×</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {newFolderOpen ? (
                  <div className={s.newFolderRow}>
                    <input className={s.newFolderInput} value={newFolderName} onChange={e => setNewFolderName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleNewFolder(); if (e.key === 'Escape') setNewFolderOpen(false); }}
                      placeholder="Folder name…" autoFocus />
                    <button className={s.newFolderOk} onClick={handleNewFolder}>✓</button>
                  </div>
                ) : (
                  <button className={s.sidebarNewFolder} onClick={() => setNewFolderOpen(true)}>+ New Folder</button>
                )}
              </div>
            </div>

            {/* ── Editor ── */}
            <div className={s.modalEditorArea}>
              {activePage ? (
                <>
                  {/* Title + actions row */}
                  <div className={s.modalTitleRow}>
                    <input className={s.modalTitleInput} value={activePage.title} onChange={handleTitleChange} placeholder="Page title…" />
                    <div className={s.modalActions}>
                      <button className={`${s.actBtn} ${activePage.pinned ? s.actBtnActive : ''}`}
                        onClick={() => togglePin(activePage.id)} title={activePage.pinned ? 'Unpin' : 'Pin to top'}>📌</button>
                      <button className={s.actBtn} onClick={() => duplicatePage(activePage.id)} title="Duplicate">📋</button>
                      <button className={s.actBtn} onClick={() => toggleArchive(activePage.id)}
                        title={activePage.archived ? 'Unarchive' : 'Archive'}>{activePage.archived ? '📤' : '📦'}</button>
                      <button className={`${s.actBtn} ${s.actBtnDanger}`} onClick={handleDeletePage} title="Delete">🗑️</button>
                    </div>
                  </div>

                  {/* Meta row: folder + tags */}
                  <div className={s.modalMetaRow}>
                    <select className={s.folderSelect} value={activePage.folderId || ''}
                      onChange={e => moveToFolder(activePage.id, e.target.value || null)}>
                      <option value="">No folder</option>
                      {folders.map(f => <option key={f.id} value={f.id}>📁 {f.name}</option>)}
                    </select>
                    {renderTagEditor()}
                  </div>

                  {/* Quill editor */}
                  <div className={s.modalQuillWrap}>
                    <ReactQuill key={activePageId} ref={modalQuillRef} theme="snow" defaultValue={activePage.content}
                      onChange={handleContentChange} modules={QUILL_MODULES} placeholder="Start writing…" />
                  </div>
                  <ImageResizer quillRef={modalQuillRef} />

                  {/* Word count footer (#9) */}
                  <div className={s.wordCountBar}>
                    {wc.words} words · {wc.chars} chars
                    {activePage.createdAt && (
                      <span className={s.wordCountMeta}> · Created {formatDate(activePage.createdAt)}</span>
                    )}
                  </div>
                </>
              ) : (
                <div className={s.empty}>
                  <p>No pages yet</p>
                  <button className="btn btn-primary btn-sm" onClick={handleNewPage}>+ New page</button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>,
      document.body
    )}

    {/* Delete confirmation (#20) */}
    <ConfirmDialog
      isOpen={confirmDelete}
      title="Delete Page"
      message={`Are you sure you want to delete "${activePage?.title || 'this page'}"? This action cannot be undone.`}
      confirmText="Delete"
      cancelText="Cancel"
      onConfirm={confirmDeletePage}
      onCancel={() => setConfirmDelete(false)}
      isDanger
    />
    </>
  );
}
