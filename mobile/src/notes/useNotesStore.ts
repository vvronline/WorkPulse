/* ─────────────────────────────────────────────────────────
   useNotesStore — central state + business logic for the
   mobile Notes feature. Ported from the web client's
   useNotesStore + useNotesPersistence, merged into one hook
   and adapted for React Native (SecureStore fallback, no DOM,
   no keyboard shortcuts / drag-and-drop).
   ───────────────────────────────────────────────────────── */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as SecureStore from "expo-secure-store";
import {
  getNotes,
  saveNotes,
  getDailyPrefill,
  getOneOnOnePrefill,
  convertNoteToTask,
  type Notebook,
  type NotePage,
  type NoteFolder,
  type NoteTodo,
} from "../features";
import { useAuth } from "../auth/AuthContext";
import {
  newPage,
  newFolder,
  newTodo,
  migratePageModel,
  getDescendantFolderIds,
  getDescendantPageIds,
  stripHtml,
} from "./notesUtils";
import {
  getTemplate,
  buildJournalPrefillHtml,
  buildOneOnOnePrefillHtml,
} from "./templates";

const CACHE_PREFIX = "wp_notes_";

export type SortBy = "modified" | "created" | "title" | "manual";

export interface NotesStore {
  // ── state ──
  loading: boolean;
  pages: NotePage[];
  folders: NoteFolder[];
  todos: NoteTodo[];
  activePageId: string | null;
  activePage: NotePage | null;
  sortBy: SortBy;
  savedFlash: boolean;
  searchQuery: string;
  showArchived: boolean;
  folderFilter: string;
  // ── derived ──
  processedPages: NotePage[];
  // ── setters ──
  setActivePageId: (id: string | null) => void;
  setSortBy: (v: SortBy) => void;
  setSearchQuery: (v: string) => void;
  setShowArchived: (v: boolean) => void;
  setFolderFilter: (v: string) => void;
  // ── page handlers ──
  handleNewPage: (folderId?: string | null, title?: string) => string;
  handleNewFromTemplate: (templateId: string) => string;
  handleOpenTodayJournal: () => Promise<string>;
  handleNewOneOnOneWithPrefill: (reportUserId: number | string) => Promise<string>;
  handleNewSubPage: (parentPageId: string, title?: string) => string;
  handleSelectPage: (id: string) => void;
  handleContentChange: (content: string) => void;
  handleTitleChange: (title: string) => void;
  handleRename: (pageId: string, title: string) => void;
  handleTogglePin: (pageId: string) => void;
  handleToggleArchive: (pageId: string) => void;
  handleDuplicatePage: (pageId: string) => void;
  handleDeletePage: (pageId: string) => void;
  handleMoveToFolder: (pageId: string, folderId: string | null) => void;
  handleMovePageToParent: (pageId: string, parentPageId: string | null) => void;
  handleAddTag: (pageId: string, tag: string) => void;
  handleRemoveTag: (pageId: string, tag: string) => void;
  handleConvertToTask: (taskTitle: string) => Promise<{ id: number; title: string } | null>;
  // ── folder handlers ──
  handleNewFolder: (parentId?: string | null, name?: string) => void;
  handleRenameFolder: (folderId: string, name: string) => void;
  handleDeleteFolder: (folderId: string) => void;
  handleMoveFolder: (folderId: string, newParentId: string | null) => void;
  // ── todo handlers ──
  handleAddTodo: (text: string) => void;
  handleToggleTodo: (todoId: string) => void;
  handleSetTodoPriority: (todoId: string, priority: NoteTodo["priority"]) => void;
  handleSetTodoDue: (todoId: string, dueDate: string | null) => void;
  handleDeleteTodo: (todoId: string) => void;
  // ── misc ──
  flush: () => void;
}

export function useNotesStore(): NotesStore {
  const { user } = useAuth();
  const userId = user?.id;

  const [loading, setLoading] = useState(true);
  const [pages, setPages] = useState<NotePage[]>([]);
  const [folders, setFolders] = useState<NoteFolder[]>([]);
  const [todos, setTodos] = useState<NoteTodo[]>([]);
  const [activePageId, setActivePageId] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortBy>("modified");
  const [savedFlash, setSavedFlash] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [folderFilter, setFolderFilter] = useState("all");

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Snapshot refs for async callbacks + flush
  const latestPages = useRef<NotePage[]>([]);
  const latestFolders = useRef<NoteFolder[]>([]);
  const latestTodos = useRef<NoteTodo[]>([]);
  const latestActiveId = useRef<string | null>(null);
  const latestSortBy = useRef<SortBy>("modified");
  const userIdRef = useRef(userId);

  useEffect(() => { latestPages.current = pages; }, [pages]);
  useEffect(() => { latestFolders.current = folders; }, [folders]);
  useEffect(() => { latestTodos.current = todos; }, [todos]);
  useEffect(() => { latestActiveId.current = activePageId; }, [activePageId]);
  useEffect(() => { latestSortBy.current = sortBy; }, [sortBy]);
  useEffect(() => { userIdRef.current = userId; }, [userId]);

  const cacheKey = useCallback(
    () => `${CACHE_PREFIX}${userIdRef.current ?? "anon"}`,
    [],
  );

  const saveToServer = useCallback(async (data: Notebook) => {
    try {
      await saveNotes(data);
    } catch (e) {
      // Fall back to a local cache so edits survive offline.
      try {
        await SecureStore.setItemAsync(cacheKey(), JSON.stringify(data));
      } catch {
        /* ignore */
      }
    }
  }, [cacheKey]);

  const persist = useCallback(
    (
      pgs?: NotePage[],
      flds?: NoteFolder[],
      aid?: string | null,
      sort?: SortBy,
      tds?: NoteTodo[],
    ) => {
      const data: Notebook = {
        pages: pgs ?? latestPages.current,
        folders: flds ?? latestFolders.current,
        todos: tds ?? latestTodos.current,
        activePageId: aid ?? latestActiveId.current,
        sortBy: sort ?? latestSortBy.current,
      };
      void saveToServer(data);
    },
    [saveToServer],
  );

  const scheduleAutoSave = useCallback(
    (pgs?: NotePage[], flds?: NoteFolder[], aid?: string | null) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        persist(pgs, flds, aid);
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 2000);
      }, 2000);
    },
    [persist],
  );

  // ── Load on mount / when user changes ──
  useEffect(() => {
    if (!userId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await getNotes();
        if (cancelled) return;
        const nb = res.data?.data;
        if (nb?.pages && nb.pages.length > 0) {
          const pgs = nb.pages.map(migratePageModel);
          setPages(pgs);
          setFolders(nb.folders || []);
          setTodos(Array.isArray(nb.todos) ? nb.todos : []);
          setActivePageId(nb.activePageId || pgs[0]?.id || null);
          setSortBy((nb.sortBy as SortBy) || "modified");
          setLoading(false);
          return;
        }
      } catch {
        // try local cache below
      }
      try {
        const raw = await SecureStore.getItemAsync(`${CACHE_PREFIX}${userId}`);
        if (raw && !cancelled) {
          const nb = JSON.parse(raw) as Notebook;
          if (nb.pages?.length) {
            const pgs = nb.pages.map(migratePageModel);
            setPages(pgs);
            setFolders(nb.folders || []);
            setTodos(Array.isArray(nb.todos) ? nb.todos : []);
            setActivePageId(nb.activePageId || pgs[0]?.id || null);
            setSortBy((nb.sortBy as SortBy) || "modified");
            setLoading(false);
            return;
          }
        }
      } catch {
        /* ignore */
      }
      if (!cancelled) {
        const first = newPage("My Notes");
        setPages([first]);
        setActivePageId(first.id);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // ── Flush on unmount ──
  const flush = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (userIdRef.current && latestPages.current.length > 0) {
      persist();
    }
  }, [persist]);

  useEffect(() => {
    return () => {
      flush();
    };
  }, [flush]);

  const activePage = useMemo(
    () => pages.find((p) => p.id === activePageId) || null,
    [pages, activePageId],
  );

  // ── Derived: processed (filtered + sorted) page list ──
  const processedPages = useMemo(() => {
    let list = pages.filter((p) => (showArchived ? p.archived : !p.archived));

    if (folderFilter === "none") {
      list = list.filter((p) => !p.folderId);
    } else if (folderFilter !== "all") {
      list = list.filter((p) => p.folderId === folderFilter);
    }

    const q = searchQuery.trim().toLowerCase();
    if (q) {
      if (q.startsWith("#")) {
        const tag = q.slice(1);
        list = list.filter((p) => (p.tags || []).some((t) => t.toLowerCase().includes(tag)));
      } else {
        list = list.filter(
          (p) =>
            (p.title || "").toLowerCase().includes(q) ||
            stripHtml(p.content || "").toLowerCase().includes(q),
        );
      }
    }

    const sorted = [...list].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      switch (sortBy) {
        case "title":
          return (a.title || "").localeCompare(b.title || "");
        case "created":
          return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
        case "manual":
          return (a.sortOrder || 0) - (b.sortOrder || 0);
        case "modified":
        default:
          return new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
      }
    });
    return sorted;
  }, [pages, showArchived, folderFilter, searchQuery, sortBy]);

  /* ══════════════════════ Page handlers ══════════════════════ */

  const handleNewPage = useCallback(
    (folderId: string | null = null, title = "Untitled"): string => {
      const fid =
        folderId ??
        (folderFilter !== "all" && folderFilter !== "none" ? folderFilter : null);
      const page = newPage(title.trim() || "Untitled", fid);
      page.createdBy = userIdRef.current || null;
      page.lastEditedBy = userIdRef.current || null;
      const updated = [...latestPages.current, page];
      setPages(updated);
      setActivePageId(page.id);
      persist(updated, latestFolders.current, page.id);
      return page.id;
    },
    [folderFilter, persist],
  );

  const handleNewFromTemplate = useCallback(
    (templateId: string): string => {
      const tpl = getTemplate(templateId);
      const title = (typeof tpl.title === "function" ? tpl.title() : "Untitled") || "Untitled";
      const html = typeof tpl.html === "function" ? tpl.html() : "";

      let folderId: string | null = null;
      let nextFolders = latestFolders.current;
      if (tpl.folderName) {
        const existing = nextFolders.find(
          (f) => f.name.toLowerCase() === tpl.folderName!.toLowerCase() && !f.parentId,
        );
        if (existing) {
          folderId = existing.id;
        } else {
          const f = newFolder(tpl.folderName, null);
          nextFolders = [...nextFolders, f];
          setFolders(nextFolders);
          folderId = f.id;
        }
      }

      const page = { ...newPage(title, folderId), content: html };
      page.createdBy = userIdRef.current || null;
      page.lastEditedBy = userIdRef.current || null;
      const updated = [...latestPages.current, page];
      setPages(updated);
      setActivePageId(page.id);
      persist(updated, nextFolders, page.id);
      return page.id;
    },
    [persist],
  );

  const handleOpenTodayJournal = useCallback(async (): Promise<string> => {
    const tpl = getTemplate("journal");
    const title = (tpl.title as () => string)();
    const existing = latestPages.current.find((p) => p.title === title && !p.archived);
    if (existing) {
      setActivePageId(existing.id);
      return existing.id;
    }
    let html = (tpl.html as () => string)();
    try {
      const res = await getDailyPrefill();
      if (res.data) html = buildJournalPrefillHtml(res.data);
    } catch {
      /* fall back to static template */
    }

    let folderId: string | null = null;
    let nextFolders = latestFolders.current;
    if (tpl.folderName) {
      const existingFolder = nextFolders.find(
        (f) => f.name.toLowerCase() === tpl.folderName!.toLowerCase() && !f.parentId,
      );
      if (existingFolder) {
        folderId = existingFolder.id;
      } else {
        const f = newFolder(tpl.folderName, null);
        nextFolders = [...nextFolders, f];
        setFolders(nextFolders);
        folderId = f.id;
      }
    }

    const page = { ...newPage(title, folderId), content: html };
    page.createdBy = userIdRef.current || null;
    page.lastEditedBy = userIdRef.current || null;
    const updated = [...latestPages.current, page];
    setPages(updated);
    setActivePageId(page.id);
    persist(updated, nextFolders, page.id);
    return page.id;
  }, [persist]);

  const handleNewOneOnOneWithPrefill = useCallback(
    async (reportUserId: number | string): Promise<string> => {
      const tpl = getTemplate("oneonone");
      let html = (tpl.html as () => string)();
      let reportName = "Team member";
      try {
        const res = await getOneOnOnePrefill(reportUserId);
        if (res.data) {
          reportName = res.data.report?.fullName || reportName;
          html = buildOneOnOnePrefillHtml(res.data);
        }
      } catch {
        /* fall back to static template */
      }

      const dateLabel = new Date().toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
      const title = `1-on-1 with ${reportName} — ${dateLabel}`;

      const existing = latestPages.current.find((p) => !p.archived && p.title === title);
      if (existing) {
        setActivePageId(existing.id);
        return existing.id;
      }

      const page = { ...newPage(title, null), content: html };
      page.createdBy = userIdRef.current || null;
      page.lastEditedBy = userIdRef.current || null;
      const updated = [...latestPages.current, page];
      setPages(updated);
      setActivePageId(page.id);
      persist(updated, latestFolders.current, page.id);
      return page.id;
    },
    [persist],
  );

  const handleNewSubPage = useCallback(
    (parentPageId: string, title = "Untitled"): string => {
      const parent = latestPages.current.find((p) => p.id === parentPageId);
      const child = newPage(title, parent?.folderId || null, parentPageId);
      child.createdBy = userIdRef.current || null;
      child.lastEditedBy = userIdRef.current || null;
      const updated = [...latestPages.current, child];
      setPages(updated);
      setActivePageId(child.id);
      persist(updated, latestFolders.current, child.id);
      return child.id;
    },
    [persist],
  );

  const handleSelectPage = useCallback(
    (id: string) => {
      setActivePageId(id);
      persist(latestPages.current, latestFolders.current, id);
    },
    [persist],
  );

  const handleContentChange = useCallback(
    (content: string) => {
      const updated = latestPages.current.map((p) =>
        p.id === latestActiveId.current
          ? {
              ...p,
              content,
              updatedAt: new Date().toISOString(),
              lastEditedBy: userIdRef.current || null,
            }
          : p,
      );
      setPages(updated);
      scheduleAutoSave(updated, latestFolders.current, latestActiveId.current);
    },
    [scheduleAutoSave],
  );

  const handleTitleChange = useCallback(
    (title: string) => {
      const updated = latestPages.current.map((p) =>
        p.id === latestActiveId.current ? { ...p, title, updatedAt: new Date().toISOString() } : p,
      );
      setPages(updated);
      scheduleAutoSave(updated, latestFolders.current, latestActiveId.current);
    },
    [scheduleAutoSave],
  );

  const updatePageMeta = useCallback(
    (pageId: string, patch: Partial<NotePage>) => {
      const updated = latestPages.current.map((p) =>
        p.id === pageId ? { ...p, ...patch, updatedAt: new Date().toISOString() } : p,
      );
      setPages(updated);
      persist(updated, latestFolders.current, latestActiveId.current);
    },
    [persist],
  );

  const handleRename = useCallback(
    (pageId: string, title: string) => {
      updatePageMeta(pageId, { title: title.trim() || "Untitled" });
    },
    [updatePageMeta],
  );

  const handleTogglePin = useCallback(
    (pageId: string) => {
      const p = latestPages.current.find((x) => x.id === pageId);
      if (!p) return;
      updatePageMeta(pageId, { pinned: !p.pinned });
    },
    [updatePageMeta],
  );

  const handleToggleArchive = useCallback(
    (pageId: string) => {
      const updated = latestPages.current.map((p) =>
        p.id === pageId
          ? { ...p, archived: !p.archived, updatedAt: new Date().toISOString() }
          : p,
      );
      setPages(updated);
      if (pageId === latestActiveId.current) {
        const remaining = updated.filter((p) => !p.archived);
        const newActive = remaining[0]?.id || updated[0]?.id || null;
        setActivePageId(newActive);
        persist(updated, latestFolders.current, newActive);
      } else {
        persist(updated, latestFolders.current, latestActiveId.current);
      }
    },
    [persist],
  );

  const handleDuplicatePage = useCallback(
    (pageId: string) => {
      const source = latestPages.current.find((p) => p.id === pageId);
      if (!source) return;
      const dup = {
        ...newPage("Copy of " + source.title, source.folderId || null),
        content: source.content,
        tags: [...(source.tags || [])],
      };
      dup.createdBy = userIdRef.current || null;
      dup.lastEditedBy = userIdRef.current || null;
      const updated = [...latestPages.current, dup];
      setPages(updated);
      setActivePageId(dup.id);
      persist(updated, latestFolders.current, dup.id);
    },
    [persist],
  );

  const handleDeletePage = useCallback(
    (pageId: string) => {
      const active = latestPages.current.filter((p) => !p.archived);
      const target = latestPages.current.find((p) => p.id === pageId);
      if (active.length <= 1 && target && !target.archived) {
        const fresh = newPage("My Notes");
        setPages([fresh]);
        setActivePageId(fresh.id);
        persist([fresh], latestFolders.current, fresh.id);
        return;
      }
      const descendantIds = getDescendantPageIds(pageId, latestPages.current);
      const removeIds = new Set([pageId, ...descendantIds]);
      const updated = latestPages.current.filter((p) => !removeIds.has(p.id));
      const remaining = updated.filter((p) => !p.archived);
      const newActive = remaining[0]?.id || updated[0]?.id || null;
      setPages(updated);
      if (removeIds.has(latestActiveId.current || "")) setActivePageId(newActive);
      persist(updated, latestFolders.current, removeIds.has(latestActiveId.current || "") ? newActive : latestActiveId.current);
    },
    [persist],
  );

  const handleMoveToFolder = useCallback(
    (pageId: string, folderId: string | null) => {
      updatePageMeta(pageId, { folderId: folderId || null });
    },
    [updatePageMeta],
  );

  const handleMovePageToParent = useCallback(
    (pageId: string, parentPageId: string | null) => {
      if (pageId === parentPageId) return;
      const descendants = getDescendantPageIds(pageId, latestPages.current);
      if (parentPageId && descendants.includes(parentPageId)) return;
      updatePageMeta(pageId, { parentPageId: parentPageId || null });
    },
    [updatePageMeta],
  );

  const handleAddTag = useCallback(
    (pageId: string, tag: string) => {
      const t = tag.trim().toLowerCase();
      if (!t) return;
      const updated = latestPages.current.map((p) => {
        if (p.id !== pageId) return p;
        if ((p.tags || []).includes(t)) return p;
        return { ...p, tags: [...(p.tags || []), t] };
      });
      setPages(updated);
      persist(updated, latestFolders.current, latestActiveId.current);
    },
    [persist],
  );

  const handleRemoveTag = useCallback(
    (pageId: string, tag: string) => {
      const updated = latestPages.current.map((p) =>
        p.id === pageId ? { ...p, tags: (p.tags || []).filter((t) => t !== tag) } : p,
      );
      setPages(updated);
      persist(updated, latestFolders.current, latestActiveId.current);
    },
    [persist],
  );

  const handleConvertToTask = useCallback(
    async (taskTitle: string) => {
      if (!taskTitle?.trim()) return null;
      try {
        const res = await convertNoteToTask(taskTitle.trim(), latestActiveId.current || "");
        return res.data?.task || null;
      } catch {
        return null;
      }
    },
    [],
  );

  /* ══════════════════════ Folder handlers ══════════════════════ */

  const handleNewFolder = useCallback(
    (parentId: string | null = null, name?: string) => {
      const clean = (name || "").trim();
      if (!clean) return;
      const f = newFolder(clean, parentId);
      const updated = [...latestFolders.current, f];
      setFolders(updated);
      persist(latestPages.current, updated, latestActiveId.current);
    },
    [persist],
  );

  const handleRenameFolder = useCallback(
    (folderId: string, name: string) => {
      const clean = (name || "").trim();
      if (!clean) return;
      const updated = latestFolders.current.map((f) =>
        f.id === folderId ? { ...f, name: clean } : f,
      );
      setFolders(updated);
      persist(latestPages.current, updated, latestActiveId.current);
    },
    [persist],
  );

  const handleDeleteFolder = useCallback(
    (folderId: string) => {
      const descendantIds = getDescendantFolderIds(folderId, latestFolders.current);
      const allRemoved = [folderId, ...descendantIds];
      const updatedPages = latestPages.current.map((p) =>
        allRemoved.includes(p.folderId as string) ? { ...p, folderId: null } : p,
      );
      const updatedFolders = latestFolders.current.filter((f) => !allRemoved.includes(f.id));
      setPages(updatedPages);
      setFolders(updatedFolders);
      if (allRemoved.includes(folderFilter)) setFolderFilter("all");
      persist(updatedPages, updatedFolders, latestActiveId.current);
    },
    [folderFilter, persist],
  );

  const handleMoveFolder = useCallback(
    (folderId: string, newParentId: string | null) => {
      if (!folderId || folderId === newParentId) return;
      const descendantIds = getDescendantFolderIds(folderId, latestFolders.current);
      if (newParentId && descendantIds.includes(newParentId)) return;
      const updated = latestFolders.current.map((f) =>
        f.id === folderId ? { ...f, parentId: newParentId || null } : f,
      );
      setFolders(updated);
      persist(latestPages.current, updated, latestActiveId.current);
    },
    [persist],
  );

  /* ══════════════════════ Todo handlers ══════════════════════ */

  const persistTodos = useCallback(
    (tds: NoteTodo[]) => {
      setTodos(tds);
      persist(latestPages.current, latestFolders.current, latestActiveId.current, latestSortBy.current, tds);
    },
    [persist],
  );

  const handleAddTodo = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t) return;
      persistTodos([...latestTodos.current, newTodo(t)]);
    },
    [persistTodos],
  );

  const handleToggleTodo = useCallback(
    (todoId: string) => {
      const updated = latestTodos.current.map((t) =>
        t.id === todoId
          ? {
              ...t,
              done: !t.done,
              completedAt: !t.done ? new Date().toISOString() : null,
            }
          : t,
      );
      persistTodos(updated);
    },
    [persistTodos],
  );

  const handleSetTodoPriority = useCallback(
    (todoId: string, priority: NoteTodo["priority"]) => {
      persistTodos(
        latestTodos.current.map((t) => (t.id === todoId ? { ...t, priority } : t)),
      );
    },
    [persistTodos],
  );

  const handleSetTodoDue = useCallback(
    (todoId: string, dueDate: string | null) => {
      persistTodos(
        latestTodos.current.map((t) => (t.id === todoId ? { ...t, dueDate } : t)),
      );
    },
    [persistTodos],
  );

  const handleDeleteTodo = useCallback(
    (todoId: string) => {
      persistTodos(latestTodos.current.filter((t) => t.id !== todoId));
    },
    [persistTodos],
  );

  const handleSortChange = useCallback(
    (val: SortBy) => {
      setSortBy(val);
      persist(latestPages.current, latestFolders.current, latestActiveId.current, val);
    },
    [persist],
  );

  return {
    loading,
    pages,
    folders,
    todos,
    activePageId,
    activePage,
    sortBy,
    savedFlash,
    searchQuery,
    showArchived,
    folderFilter,
    processedPages,
    setActivePageId,
    setSortBy: handleSortChange,
    setSearchQuery,
    setShowArchived,
    setFolderFilter,
    handleNewPage,
    handleNewFromTemplate,
    handleOpenTodayJournal,
    handleNewOneOnOneWithPrefill,
    handleNewSubPage,
    handleSelectPage,
    handleContentChange,
    handleTitleChange,
    handleRename,
    handleTogglePin,
    handleToggleArchive,
    handleDuplicatePage,
    handleDeletePage,
    handleMoveToFolder,
    handleMovePageToParent,
    handleAddTag,
    handleRemoveTag,
    handleConvertToTask,
    handleNewFolder,
    handleRenameFolder,
    handleDeleteFolder,
    handleMoveFolder,
    handleAddTodo,
    handleToggleTodo,
    handleSetTodoPriority,
    handleSetTodoDue,
    handleDeleteTodo,
    flush,
  };
}