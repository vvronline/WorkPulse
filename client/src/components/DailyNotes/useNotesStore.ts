/* eslint-disable @typescript-eslint/no-explicit-any */
/* ─────────────────────────────────────────────────────────
   useNotesStore – central state + business logic hook.
   Owns: pages, folders, UI state, persistence, all handlers.
   Returns a single "store" object consumed by index.tsx and
   passed down as props to child components.
   ───────────────────────────────────────────────────────── */
import { useState, useEffect, useRef, useCallback } from "react";
import {
    newPage,
    newFolder,
    newTodo,
    getDescendantFolderIds,
    getDescendantPageIds,
    extractHeadings,
} from "./notesUtils";
import type { NotePage, NoteFolder } from "./notesUtils";
import { useNotesPersistence } from "./useNotesPersistence";
import { useNotesFilters } from "./useNotesFilters";
import { useClickOutside } from "../../hooks/useClickOutside";
import {
    getTemplate,
    buildJournalPrefillHtml,
    buildOneOnOnePrefillHtml,
} from "./templates";
import {
    savePageAsPdf,
    savePageAsMarkdown,
    savePageAsHtml,
    exportAllPagesAsMarkdown,
    readFileAsText,
} from "./notesExport";
import { markdownToHtml } from "./notesMarkdown";
import {
    getMentionableUsers,
    sendNoteMention,
    getDailyPrefill,
    getOneOnOnePrefill,
    convertToTask,
} from "../../api";
import useCollaboration from "./useCollaboration";
import { useAuth } from "../../AuthContext";
import { useBranding } from "../../BrandingContext";

export function useNotesStore(userId: number | string | undefined) {
    const { user } = useAuth();
    const { branding } = useBranding();
    const {
        pages,
        setPages,
        folders,
        setFolders,
        todos,
        setTodos,
        activePageId,
        setActivePageId,
        sortBy,
        setSortBy,
        savedFlash,
        setSavedFlash,
        saveTimerRef,
        persist,
        scheduleAutoSave,
    } = useNotesPersistence(userId);

    /* ── UI flags ──────────────────────────────────────────── */
    const [expanded, setExpanded] = useState(false);
    const [maximized, setMaximized] = useState(false);
    const [embedded, setEmbedded] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    // 'home' = dashboard landing view, 'editor' = page editing view.
    // Only meaningful when embedded (full /notes route). Defaults to 'home'.
    const [view, setView] = useState("home");
    // Floating popovers / palettes (replace the always-visible sidebar)
    const [switcherOpen, setSwitcherOpen] = useState(false);
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [showArchived, setShowArchived] = useState(false);
    const [folderFilter, setFolderFilter] = useState("all");
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [pageMenu, setPageMenu] = useState<any>(null);
    const [dropdownSearch, setDropdownSearch] = useState("");
    const [quickCaptureOpen, setQuickCaptureOpen] = useState(false);
    /* Floating page-link picker (slash-menu → /pagelink) */
    const [pageLinkPicker, setPageLinkPicker] = useState<any>(null); // { quill, range, position }
    /* Draw.io diagram editor (full-screen modal). When non-null,
       NotesPage renders <DrawioEditor> with this state. */
    const [drawioEditor, setDrawioEditor] = useState<any>(null); // { node, initialXml }
    /* Audio recorder modal — open via slash menu /record */
    const [audioRecorder, setAudioRecorder] = useState<any>(null); // { quill, range } | null
    /* ── Rename ─────────────────────────────────────────────── */
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState("");

    /* ── Tags ───────────────────────────────────────────────── */
    const [tagInput, setTagInput] = useState("");
    const [showTagInput, setShowTagInput] = useState(false);

    /* ── Folders ────────────────────────────────────────────── */
    const [newFolderOpen, setNewFolderOpen] = useState(false);
    const [newFolderName, setNewFolderName] = useState("");

    /* ── Drag-and-drop ──────────────────────────────────────── */
    const [dragOverId, setDragOverId] = useState<string | null>(null);

    /* ── Refs ───────────────────────────────────────────────── */
    const renameRef = useRef<HTMLInputElement | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);
    const quillRef = useRef<any>(null);
    const modalQuillRef = useRef<any>(null);
    const searchRef = useRef<HTMLInputElement | null>(null);
    const tagInputRef = useRef<HTMLInputElement | null>(null);
    const pageMenuRef = useRef<HTMLDivElement | null>(null);
    const dragRef = useRef<string | null>(null);

    /* ── Derived values ─────────────────────────────────────── */
    const { activePage, wc, processedPages, dropdownPages } = useNotesFilters({
        pages,
        activePageId,
        sortBy,
        showArchived,
        folderFilter,
        searchQuery,
        dropdownSearch,
        currentUserId: user?.id,
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
        const h = (e: KeyboardEvent) => {
            if (e.key === "Escape") setMaximized(false);
        };
        document.addEventListener("keydown", h);
        return () => document.removeEventListener("keydown", h);
    }, [maximized]);

    /* ── Prevent body scroll when modal open ─────────────────── */
    useEffect(() => {
        document.body.style.overflow = maximized ? "hidden" : "";
        return () => {
            document.body.style.overflow = "";
        };
    }, [maximized]);

    /* ── Keyboard shortcuts ─────────────────────────────────── */
    useEffect(() => {
        const h = (e: KeyboardEvent) => {
            const ctrl = e.ctrlKey || e.metaKey;
            const active = expanded || maximized || embedded;
            if (!active) return;

            if (ctrl && e.key === "n" && !e.shiftKey) {
                e.preventDefault();
                handleNewPage();
            }
            if (ctrl && e.key === "s" && !e.shiftKey) {
                e.preventDefault();
                if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
                persist(pages, folders, activePageId, sortBy);
                setSavedFlash(true);
                setTimeout(() => setSavedFlash(false), 2000);
            }
            if (ctrl && e.shiftKey && (e.key === "F" || e.key === "f")) {
                e.preventDefault();
                setTimeout(() => searchRef.current?.focus(), 50);
            }
            if (ctrl && e.key === "p" && !e.shiftKey && activePageId) {
                if (
                    !["INPUT", "TEXTAREA"].includes(
                        document.activeElement?.tagName || "",
                    )
                ) {
                    e.preventDefault();
                    handleTogglePin(activePageId);
                }
            }
            if (ctrl && e.key === "d" && !e.shiftKey && activePageId) {
                e.preventDefault();
                handleDuplicatePage(activePageId);
            }
            if (
                ctrl &&
                e.shiftKey &&
                (e.key === "A" || e.key === "a") &&
                activePageId
            ) {
                e.preventDefault();
                handleToggleArchive(activePageId);
            }
            if (
                ctrl &&
                (e.key === "h" || e.key === "H") &&
                !e.shiftKey &&
                embedded
            ) {
                e.preventDefault();
                openHome();
            }
            // Ctrl+K → command palette (works in editor view, embedded or modal)
            if (ctrl && (e.key === "k" || e.key === "K") && !e.shiftKey) {
                e.preventDefault();
                setPaletteOpen((p) => !p);
            }
            // Ctrl+Shift+N → quick capture into Inbox page
            if (ctrl && e.shiftKey && (e.key === "N" || e.key === "n")) {
                e.preventDefault();
                setQuickCaptureOpen((p) => !p);
            }
            // Ctrl+P (without other meta) → page switcher (when not in INPUT/TEXTAREA)
            if (ctrl && e.shiftKey && (e.key === "O" || e.key === "o")) {
                // Ctrl+Shift+O → page switcher (avoids conflict with browser print)
                if (
                    !["INPUT", "TEXTAREA"].includes(
                        document.activeElement?.tagName || "",
                    )
                ) {
                    e.preventDefault();
                    setSwitcherOpen((p) => !p);
                }
            }
        };
        document.addEventListener("keydown", h);
        return () => document.removeEventListener("keydown", h);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        expanded,
        maximized,
        embedded,
        pages,
        folders,
        activePageId,
        sortBy,
        persist,
    ]);

    /* ══════════════════════════ Handlers ═══════════════════════ */

    const handleContentChange = (content: string) => {
        const updated = pages.map((p) =>
            p.id === activePageId
                ? {
                      ...p,
                      content,
                      updatedAt: new Date().toISOString(),
                      lastEditedBy: user?.id || null,
                  }
                : p,
        );
        setPages(updated);
        scheduleAutoSave(updated, folders, activePageId);
    };

    const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const title = e.target.value;
        const updated = pages.map((p) =>
            p.id === activePageId ? { ...p, title } : p,
        );
        setPages(updated);
        scheduleAutoSave(updated, folders, activePageId);
    };

    const handleNewPage = (explicitFolderId?: any, inlineTitle?: any) => {
        // Guard: if called as an onClick handler, explicitFolderId will be a synthetic
        // event or DOM element — treat it as "no explicit folder" in that case.
        const validFolder =
            typeof explicitFolderId === "string" || explicitFolderId === null
                ? explicitFolderId
                : undefined;
        const folderId =
            validFolder !== undefined
                ? validFolder
                : folderFilter !== "all" && folderFilter !== "none"
                  ? folderFilter
                  : null;
        const title =
            typeof inlineTitle === "string" && inlineTitle.trim()
                ? inlineTitle.trim()
                : "Untitled";
        const page = newPage(title, folderId);
        page.createdBy = user?.id || null;
        page.lastEditedBy = user?.id || null;
        const updated = [...pages, page];
        setPages(updated);
        setActivePageId(page.id);
        persist(updated, folders, page.id);
        setMenuOpen(false);
        setView("editor");
        if (!inlineTitle) {
            setTimeout(() => {
                setRenamingId(page.id);
                setRenameValue(title);
            }, 50);
        }
    };

    const handleSelectPage = (id: string) => {
        setActivePageId(id);
        persist(pages, folders, id);
        setMenuOpen(false);
        setView("editor");
    };

    /* ── Home / Editor view switching ────────────────────────── */
    const openHome = () => {
        setView("home");
        setMenuOpen(false);
    };

    const openEditor = (id?: string) => {
        if (id) {
            setActivePageId(id);
            persist(pages, folders, id);
        }
        setView("editor");
        setMenuOpen(false);
    };

    /* ── Create page from a template (used by Home quick actions) ── */
    const handleNewFromTemplate = (templateId: string) => {
        const tpl = getTemplate(templateId);
        const title =
            (typeof tpl.title === "function" ? tpl.title() : tpl.title) ||
            "Untitled";
        const html =
            (typeof tpl.html === "function" ? tpl.html() : tpl.html) || "";

        // If template specifies a folder name, find or create it.
        let folderId: string | null = null;
        let nextFolders = folders;
        if (tpl.folderName) {
            const existing = folders.find(
                (f) =>
                    f.name.toLowerCase() === tpl.folderName!.toLowerCase() &&
                    !f.parentId,
            );
            if (existing) {
                folderId = existing.id;
            } else {
                const f = newFolder(tpl.folderName, null);
                nextFolders = [...folders, f];
                setFolders(nextFolders);
                folderId = f.id;
            }
        }

        const page = { ...newPage(title, folderId), content: html };
        page.createdBy = user?.id || null;
        page.lastEditedBy = user?.id || null;
        const updatedPages = [...pages, page];
        setPages(updatedPages);
        setActivePageId(page.id);
        persist(updatedPages, nextFolders, page.id);
        setView("editor");
        setMenuOpen(false);

        // Only blank pages get auto-rename — others have meaningful titles.
        if (templateId === "blank") {
            setTimeout(() => {
                setRenamingId(page.id);
                setRenameValue(title);
            }, 50);
        }
    };

    /* ── Open or create today's journal entry (with auto-prefill) ─ */
    const handleOpenTodayJournal = async () => {
        const tpl = getTemplate("journal");
        const title = (tpl.title as () => string)();
        const existing = pages.find((p) => p.title === title && !p.archived);
        if (existing) {
            openEditor(existing.id);
            return;
        }
        // Fetch daily prefill data from server, then create the page
        let html = (tpl.html as () => string)();
        try {
            const res = await getDailyPrefill();
            if (res.data) {
                html = buildJournalPrefillHtml(res.data);
            }
        } catch {
            /* fall back to static template */
        }

        let folderId: string | null = null;
        let nextFolders = folders;
        if (tpl.folderName) {
            const existingFolder = folders.find(
                (f) =>
                    f.name.toLowerCase() === tpl.folderName!.toLowerCase() &&
                    !f.parentId,
            );
            if (existingFolder) {
                folderId = existingFolder.id;
            } else {
                const f = newFolder(tpl.folderName, null);
                nextFolders = [...folders, f];
                setFolders(nextFolders);
                folderId = f.id;
            }
        }

        const page = { ...newPage(title, folderId), content: html };
        page.createdBy = user?.id || null;
        page.lastEditedBy = user?.id || null;
        const updatedPages = [...pages, page];
        setPages(updatedPages);
        setActivePageId(page.id);
        persist(updatedPages, nextFolders, page.id);
        setView("editor");
        setMenuOpen(false);
    };

    /* ── Create 1-on-1 page with auto-prefill for a direct report ── */
    const handleNewOneOnOneWithPrefill = async (reportUserId: number | string) => {
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

        // Reuse an existing page with the same title for today if present.
        const existing = pages.find((p) => !p.archived && p.title === title);
        if (existing) {
            openEditor(existing.id);
            return;
        }

        const page = {
            ...newPage(title, activePage?.folderId || null),
            content: html,
        };
        page.createdBy = user?.id || null;
        page.lastEditedBy = user?.id || null;
        const updated = [...pages, page];
        setPages(updated);
        setActivePageId(page.id);
        persist(updated, folders, page.id);
        setView("editor");
        setMenuOpen(false);
    };

    /* ── Convert a checklist item text into a real Task ── */
    const handleConvertToTask = async (taskTitle: string) => {
        if (!taskTitle?.trim()) return null;
        try {
            const res = await convertToTask(
                taskTitle.trim(),
                activePageId || "",
                activePage?.title || "Untitled",
            );
            return res.data?.task || null;
        } catch {
            return null;
        }
    };

    const handleDeletePage = () => setConfirmDelete(true);

    const handleConfirmDelete = () => {
        setConfirmDelete(false);
        if (
            pages.filter((p) => !p.archived).length <= 1 &&
            !activePage?.archived
        ) {
            const fresh = newPage("My Notes");
            setPages([fresh]);
            setActivePageId(fresh.id);
            persist([fresh], folders, fresh.id);
            return;
        }
        // Cascade: also delete descendant pages so the tree stays consistent.
        const descendantIds = getDescendantPageIds(activePageId || "", pages);
        const removeIds = new Set([activePageId, ...descendantIds]);
        const updated = pages.filter((p) => !removeIds.has(p.id));
        const remaining = updated.filter((p) => !p.archived);
        const newActive = remaining[0]?.id || updated[0]?.id;
        setPages(updated);
        setActivePageId(newActive);
        persist(updated, folders, newActive);
    };

    /* ── Update page metadata ── */
    const updatePageMeta = (pageId: string, patch: Partial<NotePage>) => {
        const updated = pages.map((p) =>
            p.id === pageId
                ? { ...p, ...patch, updatedAt: new Date().toISOString() }
                : p,
        );
        setPages(updated);
        persist(updated, folders, activePageId);
    };

    const handleSetPageIcon = (
        pageId: string,
        icon?: string,
        coverColor?: string,
    ) => {
        updatePageMeta(pageId, {
            ...(icon !== undefined ? { icon } : {}),
            ...(coverColor !== undefined ? { coverColor } : {}),
        });
    };

    const handleSetPageProperties = (
        pageId: string,
        properties: Record<string, unknown>,
    ) => {
        updatePageMeta(pageId, { properties });
    };

    const handleToggleReadOnly = (pageId: string) => {
        const p = pages.find((x) => x.id === pageId);
        if (!p) return;
        updatePageMeta(pageId, { readOnly: !p.readOnly });
    };

    const handleToggleReaction = (
        pageId: string,
        emoji: string,
        reactionUserId: number | string,
    ) => {
        if (!pageId || !emoji || !reactionUserId) return;
        const updated = pages.map((p) => {
            if (p.id !== pageId) return p;
            const reactions: Record<string, any> = { ...(p.reactions || {}) };
            const list = reactions[emoji] ? [...reactions[emoji]] : [];
            const idx = list.indexOf(reactionUserId);
            if (idx >= 0) list.splice(idx, 1);
            else list.push(reactionUserId);
            if (list.length === 0) delete reactions[emoji];
            else reactions[emoji] = list;
            return { ...p, reactions };
        });
        setPages(updated);
        persist(updated, folders, activePageId);
    };

    /* ── Sub-pages ───────────────────────────────────────── */
    const handleNewSubPage = (parentPageId: string, title = "Untitled") => {
        const parent = pages.find((p) => p.id === parentPageId);
        const folderId = parent?.folderId || null;
        const child = newPage(title, folderId, parentPageId);
        child.createdBy = user?.id || null;
        child.lastEditedBy = user?.id || null;
        const updated = [...pages, child];
        setPages(updated);
        setActivePageId(child.id);
        persist(updated, folders, child.id);
        setView("editor");
        setTimeout(() => {
            setRenamingId(child.id);
            setRenameValue(title);
        }, 50);
    };

    const handleMovePageToParent = (
        pageId: string,
        parentPageId: string | null,
    ) => {
        // Prevent cycles: a page cannot be a descendant of itself.
        if (pageId === parentPageId) return;
        const descendants = getDescendantPageIds(pageId, pages);
        if (parentPageId && descendants.includes(parentPageId)) return;
        updatePageMeta(pageId, { parentPageId: parentPageId || null });
    };

    /* ── Page-link picker (slash-menu helper) ───────────── */
    const openPageLinkPicker = (quill: any, range: any) => {
        if (!quill) return;
        let position = null;
        try {
            const bounds = quill.getBounds(range?.index ?? quill.getLength());
            const editorRect = quill.root.getBoundingClientRect();
            position = {
                top: editorRect.top + bounds.bottom + 6,
                left: editorRect.left + bounds.left,
            };
        } catch {
            /* ignore */
        }
        setPageLinkPicker({ quill, range, position });
    };

    const closePageLinkPicker = () => setPageLinkPicker(null);

    const insertPageLink = (target: any) => {
        const ctx = pageLinkPicker;
        if (!ctx || !ctx.quill || !target) {
            closePageLinkPicker();
            return;
        }
        const q = ctx.quill;
        const idx = ctx.range?.index ?? q.getLength();
        const title = target.title || "Untitled";
        q.insertText(idx, title, "user");
        q.formatText(idx, title.length, "pagelink", { id: target.id, title }, "user");
        q.insertText(idx + title.length, " ", "user");
        q.setSelection(idx + title.length + 1, "silent");
        closePageLinkPicker();
    };

    const insertPageLinkForNew = (title: string) => {
        const ctx = pageLinkPicker;
        if (!ctx || !ctx.quill || !title) {
            closePageLinkPicker();
            return;
        }
        const created = newPage(title, activePage?.folderId || null);
        const updated = [...pages, created];
        setPages(updated);
        persist(updated, folders, activePageId);
        // Wait one tick so React flushes; then insert.
        setTimeout(() => {
            insertPageLink(created);
        }, 0);
    };

    /* ── Draw.io diagram editor ───────────────────────────── */
    useEffect(() => {
        const onEdit = (e: any) => {
            const node = e?.detail?.node;
            if (!node || !(node instanceof Element)) return;
            const enc = node.getAttribute("data-xml") || "";
            let xml = "";
            try {
                xml = decodeURIComponent(enc);
            } catch {
                xml = enc;
            }
            setDrawioEditor({ node, initialXml: xml });
        };
        document.addEventListener("notes:drawio-edit", onEdit);
        return () => document.removeEventListener("notes:drawio-edit", onEdit);
    }, []);

    const closeDrawioEditor = () => setDrawioEditor(null);

    const deleteDrawioBlock = () => {
        const ctx = drawioEditor;
        if (!ctx?.node) {
            closeDrawioEditor();
            return;
        }
        const q = modalQuillRef?.current?.getEditor
            ? modalQuillRef.current.getEditor()
            : modalQuillRef?.current;
        if (q && q.scroll && typeof q.scroll.find === "function") {
            try {
                const blot = q.scroll.find(ctx.node);
                if (blot) {
                    const idx = q.getIndex(blot);
                    q.deleteText(idx, blot.length(), "user");
                }
            } catch {
                /* ignore */
            }
        } else if (ctx.node.parentNode) {
            // Fallback: yank from DOM and re-read HTML
            ctx.node.parentNode.removeChild(ctx.node);
        }
        if (q && q.root) {
            const html = q.root.innerHTML;
            const updated = pages.map((p) =>
                p.id === activePageId
                    ? { ...p, content: html, updatedAt: new Date().toISOString() }
                    : p,
            );
            setPages(updated);
            persist(updated, folders, activePageId);
        }
        closeDrawioEditor();
    };

    const saveDrawioEditor = ({ xml, svg }: { xml?: string; svg?: string }) => {
        const ctx = drawioEditor;
        if (!ctx?.node) {
            closeDrawioEditor();
            return;
        }
        const node = ctx.node;
        // Update DOM in-place so changes are visible immediately.
        if (xml != null) node.setAttribute("data-xml", encodeURIComponent(xml));
        if (svg) {
            node.innerHTML =
                svg + '<div class="ql-drawio-overlay">Click to edit</div>';
        } else if (xml) {
            node.innerHTML =
                '<div class="ql-drawio-empty">📐 Draw.io diagram — click to edit</div>';
        }
        const q = modalQuillRef?.current?.getEditor
            ? modalQuillRef.current.getEditor()
            : modalQuillRef?.current;
        if (q && q.root) {
            const html = q.root.innerHTML;
            const updated = pages.map((p) =>
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
    const insertTocIntoEditor = (quill: any) => {
        if (!quill) return;
        const html = quill.root?.innerHTML || "";
        const headings = extractHeadings(html);
        if (headings.length === 0) {
            if (typeof window !== "undefined")
                window.alert("Add some H1 / H2 / H3 headings first.");
            return;
        }
        const range = quill.getSelection(true) || { index: 0 };
        let pos = range.index;
        quill.insertText(pos, "Table of contents\n", "user");
        quill.formatLine(pos, 1, "header", 3, "user");
        pos += "Table of contents\n".length;
        headings.forEach((h: any) => {
            const indent = "  ".repeat(Math.max(0, h.level - 1));
            const line = `${indent}${h.text}\n`;
            quill.insertText(pos, line, "user");
            quill.formatLine(pos, 1, "list", "bullet", "user");
            pos += line.length;
        });
        quill.setSelection(pos, "silent");
    };

    const handleStartRename = (page: NotePage) => {
        setRenamingId(page.id);
        setRenameValue(page.title);
        setMenuOpen(false);
    };

    const handleCommitRename = () => {
        if (!renamingId) return;
        const title = renameValue.trim() || "Untitled";
        const updated = pages.map((p) =>
            p.id === renamingId ? { ...p, title } : p,
        );
        setPages(updated);
        persist(updated, folders, activePageId);
        setRenamingId(null);
    };

    const handleTogglePin = (pageId: string) => {
        const updated = pages.map((p) =>
            p.id === pageId ? { ...p, pinned: !p.pinned } : p,
        );
        setPages(updated);
        persist(updated, folders, activePageId);
    };

    const handleToggleArchive = (pageId: string) => {
        const updated = pages.map((p) =>
            p.id === pageId
                ? {
                      ...p,
                      archived: !p.archived,
                      updatedAt: new Date().toISOString(),
                  }
                : p,
        );
        setPages(updated);
        if (pageId === activePageId) {
            const remaining = updated.filter((p) => !p.archived);
            const newActive = remaining[0]?.id || updated[0]?.id;
            setActivePageId(newActive);
            persist(updated, folders, newActive);
        } else {
            persist(updated, folders, activePageId);
        }
        setPageMenu(null);
    };

    const handleDuplicatePage = (pageId: string) => {
        const source = pages.find((p) => p.id === pageId);
        if (!source) return;
        const dup = {
            ...newPage("Copy of " + source.title, source.folderId),
            content: source.content,
            tags: [...(source.tags || [])],
        };
        const updated = [...pages, dup];
        setPages(updated);
        setActivePageId(dup.id);
        persist(updated, folders, dup.id);
        setPageMenu(null);
    };

    const handleMoveToFolder = (pageId: string, folderId: string | null) => {
        const updated = pages.map((p) =>
            p.id === pageId ? { ...p, folderId: folderId || null } : p,
        );
        setPages(updated);
        persist(updated, folders, activePageId);
        setPageMenu(null);
    };

    const handleAddTag = (pageId: string, tag: string) => {
        const t = tag.trim().toLowerCase();
        if (!t) return;
        const updated = pages.map((p) => {
            if (p.id !== pageId) return p;
            if ((p.tags || []).includes(t)) return p;
            return { ...p, tags: [...(p.tags || []), t] };
        });
        setPages(updated);
        persist(updated, folders, activePageId);
    };

    const handleRemoveTag = (pageId: string, tag: string) => {
        const updated = pages.map((p) =>
            p.id === pageId
                ? { ...p, tags: (p.tags || []).filter((t) => t !== tag) }
                : p,
        );
        setPages(updated);
        persist(updated, folders, activePageId);
    };

    const handleNewFolder = (parentId: string | null = null, inlineName?: string) => {
        const name = (inlineName || newFolderName).trim();
        if (!name) return;
        const f = newFolder(name, parentId);
        const updated = [...folders, f];
        setFolders(updated);
        persist(pages, updated, activePageId);
        if (!inlineName) {
            setNewFolderOpen(false);
            setNewFolderName("");
        }
    };

    const handleDeleteFolder = (folderId: string) => {
        const descendantIds = getDescendantFolderIds(folderId, folders);
        const allRemovedIds = [folderId, ...descendantIds];
        const updatedPages = pages.map((p) =>
            allRemovedIds.includes(p.folderId as string)
                ? { ...p, folderId: null }
                : p,
        );
        const updatedFolders = folders.filter(
            (f) => !allRemovedIds.includes(f.id),
        );
        setPages(updatedPages);
        setFolders(updatedFolders);
        if (allRemovedIds.includes(folderFilter)) setFolderFilter("all");
        persist(updatedPages, updatedFolders, activePageId);
    };

    /* ── Rename a folder ──────────────────────────────────── */
    const handleRenameFolder = (folderId: string, name: string) => {
        const clean = (name || "").trim();
        if (!clean) return;
        const updated = folders.map((f) =>
            f.id === folderId ? { ...f, name: clean } : f,
        );
        setFolders(updated);
        persist(pages, updated, activePageId);
    };

    /* ── Move (re-parent) a folder, with cycle prevention ──── */
    const handleMoveFolder = (folderId: string, newParentId: string | null) => {
        if (!folderId || folderId === newParentId) return;
        // A folder cannot become a descendant of itself.
        const descendantIds = getDescendantFolderIds(folderId, folders);
        if (newParentId && descendantIds.includes(newParentId)) return;
        const updated = folders.map((f) =>
            f.id === folderId ? { ...f, parentId: newParentId || null } : f,
        );
        setFolders(updated);
        persist(pages, updated, activePageId);
    };

    const handleSortChange = (val: string) => {
        setSortBy(val);
        persist(pages, folders, activePageId, val);
    };

    /* ── Drag-and-drop ────────────────────────────────────── */
    const handleDragStart = (e: React.DragEvent, pageId: string) => {
        dragRef.current = pageId;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", pageId);
    };

    const handleDragOver = (e: React.DragEvent, pageId?: string) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (pageId !== undefined) setDragOverId(pageId);
    };

    const handleDrop = (e: React.DragEvent, targetId: string) => {
        e.preventDefault();
        const draggedId = dragRef.current;
        if (!draggedId || draggedId === targetId) return;
        const items = [...processedPages];
        const dragIdx = items.findIndex((p) => p.id === draggedId);
        const dropIdx = items.findIndex((p) => p.id === targetId);
        if (dragIdx === -1 || dropIdx === -1) return;
        const existingOrders = items.map((p) => p.sortOrder ?? 0);
        const [moved] = items.splice(dragIdx, 1);
        items.splice(dropIdx, 0, moved);
        const orderMap: Record<string, number> = {};
        items.forEach((p, i) => {
            orderMap[p.id] = existingOrders[i];
        });
        const updated = pages.map((p) =>
            orderMap[p.id] !== undefined
                ? { ...p, sortOrder: orderMap[p.id] }
                : p,
        );
        setPages(updated);
        setSortBy("manual");
        persist(updated, folders, activePageId, "manual");
        dragRef.current = null;
        setDragOverId(null);
    };

    const handleDragEnd = () => {
        dragRef.current = null;
        setDragOverId(null);
    };

    /* ── Quick capture ─────────────────────────────────────── */
    const appendToInbox = (text: string) => {
        const value = (text || "").trim();
        if (!value) return;
        const inboxName = "Inbox";
        let inbox = pages.find(
            (p) => !p.archived && p.title.toLowerCase() === inboxName.toLowerCase(),
        );
        let updatedPages = pages;
        if (!inbox) {
            inbox = { ...newPage(inboxName), pinned: true };
            updatedPages = [...pages, inbox];
        }
        const ts = new Date().toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        });
        // Convert plain newlines to <br> so multi-line captures keep shape.
        const safe = value
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/\n/g, "<br>");
        const block =
            `<p><strong>${ts}</strong></p>` + `<p>${safe}</p>` + `<p><br></p>`;
        const now = new Date().toISOString();
        updatedPages = updatedPages.map((p) =>
            p.id === inbox!.id
                ? { ...p, content: (p.content || "") + block, updatedAt: now }
                : p,
        );
        setPages(updatedPages);
        persist(updatedPages, folders, activePageId);
    };

    /* ── Audio recorder ───────────────────────────────────── */
    useEffect(() => {
        const onOpen = (e: any) => {
            const detail = e?.detail || {};
            setAudioRecorder({
                quill: detail.quill || null,
                range: detail.range || null,
            });
        };
        document.addEventListener("notes:open-audio-recorder", onOpen);
        return () =>
            document.removeEventListener("notes:open-audio-recorder", onOpen);
    }, []);

    const closeAudioRecorder = () => setAudioRecorder(null);

    const insertAudioRecording = ({ src, label }: { src?: string; label?: string }) => {
        const ctx = audioRecorder;
        const q =
            ctx?.quill ||
            (modalQuillRef?.current?.getEditor
                ? modalQuillRef.current.getEditor()
                : modalQuillRef?.current);
        if (!q || !src) {
            closeAudioRecorder();
            return;
        }
        const idx = ctx?.range?.index ?? q.getLength();
        try {
            q.insertEmbed(idx, "audio", { src, label }, "user");
            q.setSelection(idx + 1, "silent");
        } catch {
            /* ignore */
        }
        // Persist explicitly because the Quill embed insertion may not always
        // trigger our debounced auto-save in time.
        try {
            const html = q.root?.innerHTML;
            if (html != null) {
                const updated = pages.map((p) =>
                    p.id === activePageId
                        ? {
                              ...p,
                              content: html,
                              updatedAt: new Date().toISOString(),
                          }
                        : p,
                );
                setPages(updated);
                persist(updated, folders, activePageId);
            }
        } catch {
            /* ignore */
        }
        closeAudioRecorder();
    };

    /* ── Markdown / HTML export + import ────────────────── */
    const handleExportMarkdown = (page?: NotePage) => {
        savePageAsMarkdown(page || activePage || undefined, branding?.org_name ?? undefined);
    };
    const handleExportHtml = (page?: NotePage) => {
        savePageAsHtml(page || activePage || undefined);
    };
    const handleExportAllMarkdown = () => {
        exportAllPagesAsMarkdown(pages, folders, branding?.org_name ?? undefined);
    };

    /** Import one or more .md / .markdown files as new pages. */
    const handleImportMarkdownFiles = async (fileList: FileList | File[]) => {
        if (!fileList || fileList.length === 0) return;
        const created: NotePage[] = [];
        for (const file of Array.from(fileList)) {
            try {
                const text = await readFileAsText(file);
                // Title precedence: first H1 (#) line, else file name
                let title = file.name.replace(/\.(md|markdown|txt)$/i, "");
                const firstHeading = text.match(/^\s*#\s+(.+)$/m);
                if (firstHeading) title = firstHeading[1].trim();
                const html = markdownToHtml(text);
                created.push({
                    ...newPage(title, activePage?.folderId || null),
                    content: html,
                });
            } catch (e) {
                console.warn("[notes] failed to import", file.name, e);
            }
        }
        if (created.length === 0) return;
        const updated = [...pages, ...created];
        setPages(updated);
        // Open the first imported page so the user sees the result immediately.
        const firstId = created[0].id;
        setActivePageId(firstId);
        persist(updated, folders, firstId);
        setView("editor");
    };

    /* ── Export the active page as a downloadable PDF ───── */
    const handleExportPdf = (page?: NotePage) => {
        const target = page || activePage;
        if (!target) return;
        let liveContent = target.content;
        if (target.id === activePageId) {
            const q = modalQuillRef?.current?.getEditor
                ? modalQuillRef.current.getEditor()
                : modalQuillRef?.current;
            if (q && typeof q.root?.innerHTML === "string") {
                liveContent = q.root.innerHTML;
            }
        }
        savePageAsPdf({ ...target, content: liveContent });
    };

    const handleRestoreSnapshot = (content: string, title?: string) => {
        const now = new Date().toISOString();
        const updated = pages.map((p) =>
            p.id === activePageId
                ? { ...p, content, title: title || p.title, updatedAt: now }
                : p,
        );
        setPages(updated);
        persist(updated, folders, activePageId);
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 2000);
    };

    /* ── Tier 6: 1-on-1 report picker ─────────────────────── */
    const [reportPickerOpen, setReportPickerOpen] = useState(false);

    useEffect(() => {
        const onOpen = () => setReportPickerOpen(true);
        document.addEventListener("notes:open-oneonone-picker", onOpen);
        return () =>
            document.removeEventListener("notes:open-oneonone-picker", onOpen);
    }, []);

    /* ── Collaboration: @mentions + real-time editing ──────── */
    const [mentionableUsers, setMentionableUsers] = useState<any[]>([]);

    // Load mentionable users (org members)
    useEffect(() => {
        if (!userId) return;
        let cancelled = false;
        getMentionableUsers()
            .then((res) => {
                if (!cancelled && res.data?.users) {
                    setMentionableUsers(res.data.users);
                }
            })
            .catch(() => {
                /* ignore */
            });
        return () => {
            cancelled = true;
        };
    }, [userId]);

    // Real-time collaboration via Yjs
    const { connected: collabConnected, users: collabUsers } = useCollaboration({
        pageId: activePageId,
        tenantId: user?.tenant_id || null,
        user,
        quillRef: modalQuillRef,
        enabled: !!maximized && !!activePageId,
    });

    // Handle @mention — send notification to mentioned user
    const handleMention = useCallback(
        (mentionedUser: any) => {
            if (!mentionedUser?.id || !activePageId) return;
            const page = pages.find((p) => p.id === activePageId);
            sendNoteMention(
                mentionedUser.id,
                activePageId,
                page?.title || "Untitled",
            ).catch(() => {
                /* best effort */
            });
        },
        [activePageId, pages],
    );

    /* ── Todos (standalone checklist, persisted in notebook) ── */
    const handleAddTodo = useCallback(
        (text: string) => {
            const t = (text || "").trim();
            if (!t) return;
            setTodos((prev) => {
                const next = [...prev, newTodo(t)];
                persist(undefined, undefined, undefined, undefined, next);
                return next;
            });
        },
        [setTodos, persist],
    );

    const handleToggleTodo = useCallback(
        (id: string) => {
            setTodos((prev) => {
                const next = prev.map((td) =>
                    td.id === id
                        ? {
                              ...td,
                              done: !td.done,
                              completedAt: !td.done
                                  ? new Date().toISOString()
                                  : null,
                          }
                        : td,
                );
                persist(undefined, undefined, undefined, undefined, next);
                return next;
            });
        },
        [setTodos, persist],
    );

    const handleEditTodo = useCallback(
        (id: string, text: string) => {
            const t = (text || "").trim();
            setTodos((prev) => {
                const next = t
                    ? prev.map((td) => (td.id === id ? { ...td, text: t } : td))
                    : prev.filter((td) => td.id !== id);
                persist(undefined, undefined, undefined, undefined, next);
                return next;
            });
        },
        [setTodos, persist],
    );

    const handleDeleteTodo = useCallback(
        (id: string) => {
            setTodos((prev) => {
                const next = prev.filter((td) => td.id !== id);
                persist(undefined, undefined, undefined, undefined, next);
                return next;
            });
        },
        [setTodos, persist],
    );

    const handleSetTodoPriority = useCallback(
        (id: string, priority: any) => {
            setTodos((prev) => {
                const next = prev.map((td) =>
                    td.id === id
                        ? {
                              ...td,
                              priority:
                                  td.priority === priority ? null : priority,
                          }
                        : td,
                );
                persist(undefined, undefined, undefined, undefined, next);
                return next;
            });
        },
        [setTodos, persist],
    );

    const handleSetTodoDue = useCallback(
        (id: string, dueDate: any) => {
            setTodos((prev) => {
                const next = prev.map((td) =>
                    td.id === id ? { ...td, dueDate: dueDate || null } : td,
                );
                persist(undefined, undefined, undefined, undefined, next);
                return next;
            });
        },
        [setTodos, persist],
    );

    const handleReorderTodos = useCallback(
        (fromId: string, toId: string) => {
            setTodos((prev) => {
                if (fromId === toId) return prev;
                const fromIdx = prev.findIndex((td) => td.id === fromId);
                const toIdx = prev.findIndex((td) => td.id === toId);
                if (fromIdx === -1 || toIdx === -1) return prev;
                const next = [...prev];
                const [moved] = next.splice(fromIdx, 1);
                next.splice(toIdx, 0, moved);
                const stamped = next.map((td, i) => ({ ...td, sortOrder: i }));
                persist(undefined, undefined, undefined, undefined, stamped);
                return stamped;
            });
        },
        [setTodos, persist],
    );

    const handleClearCompletedTodos = useCallback(() => {
        setTodos((prev) => {
            const next = prev.filter((td) => !td.done);
            persist(undefined, undefined, undefined, undefined, next);
            return next;
        });
    }, [setTodos, persist]);

    /* ── Return everything consumers need ─────────────────── */
    return {
        // data
        pages,
        folders,
        activePage,
        activePageId,
        setActivePageId,
        processedPages,
        dropdownPages,
        wc,
        // ui state
        savedFlash,
        expanded,
        setExpanded,
        maximized,
        setMaximized,
        embedded,
        setEmbedded,
        view,
        setView,
        menuOpen,
        setMenuOpen,
        searchQuery,
        setSearchQuery,
        sortBy,
        showArchived,
        setShowArchived,
        folderFilter,
        setFolderFilter,
        confirmDelete,
        setConfirmDelete,
        pageMenu,
        setPageMenu,
        dropdownSearch,
        setDropdownSearch,
        quickCaptureOpen,
        setQuickCaptureOpen,
        dragRef,
        dragOverId,
        // rename
        renamingId,
        setRenamingId,
        renameValue,
        setRenameValue,
        // tags
        tagInput,
        setTagInput,
        showTagInput,
        setShowTagInput,
        // folders
        newFolderOpen,
        setNewFolderOpen,
        newFolderName,
        setNewFolderName,
        // refs
        saveTimerRef,
        renameRef,
        menuRef,
        quillRef,
        modalQuillRef,
        searchRef,
        tagInputRef,
        pageMenuRef,
        // handlers
        handleContentChange,
        handleTitleChange,
        handleNewPage,
        handleSelectPage,
        handleDeletePage,
        handleConfirmDelete,
        handleStartRename,
        handleCommitRename,
        handleTogglePin,
        handleToggleArchive,
        handleDuplicatePage,
        handleMoveToFolder,
        handleAddTag,
        handleRemoveTag,
        handleNewFolder,
        handleDeleteFolder,
        handleRenameFolder,
        handleMoveFolder,
        handleSortChange,
        handleRestoreSnapshot,
        handleDragStart,
        handleDragOver,
        handleDrop,
        handleDragEnd,
        // home / editor view switching
        openHome,
        openEditor,
        handleNewFromTemplate,
        handleOpenTodayJournal,
        // quick capture + export
        appendToInbox,
        handleExportPdf,
        // floating navigation
        switcherOpen,
        setSwitcherOpen,
        paletteOpen,
        setPaletteOpen,
        // page metadata + new features
        handleSetPageIcon,
        handleSetPageProperties,
        handleToggleReadOnly,
        handleToggleReaction,
        handleNewSubPage,
        handleMovePageToParent,
        // page-link picker (slash-menu → /link)
        pageLinkPicker,
        openPageLinkPicker,
        closePageLinkPicker,
        insertPageLink,
        insertPageLinkForNew,
        insertTocIntoEditor,
        // draw.io diagram editor (slash-menu → /drawio)
        drawioEditor,
        closeDrawioEditor,
        saveDrawioEditor,
        deleteDrawioBlock,
        // Tier 3 — audio recorder
        audioRecorder,
        closeAudioRecorder,
        insertAudioRecording,
        // Tier 5 — Markdown / HTML import & export
        handleExportMarkdown,
        handleExportHtml,
        handleExportAllMarkdown,
        handleImportMarkdownFiles,
        persist,
        // Collaboration — @mentions + presence
        mentionableUsers,
        handleMention,
        collabUsers,
        collabConnected,
        // Tier 6 — AINO integrations
        handleNewOneOnOneWithPrefill,
        handleConvertToTask,
        reportPickerOpen,
        setReportPickerOpen,
        // Todos (standalone checklist)
        todos,
        handleAddTodo,
        handleToggleTodo,
        handleEditTodo,
        handleDeleteTodo,
        handleSetTodoPriority,
        handleSetTodoDue,
        handleReorderTodos,
        handleClearCompletedTodos,
    };
}