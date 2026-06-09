/* eslint-disable @typescript-eslint/no-explicit-any */
/* ModalEditor — right panel of the maximized modal.
   Now also renders breadcrumbs, page metadata (icon/cover/properties),
   reactions, sub-pages, backlinks, linked entities, and a sticky table of contents. */
import React, { useState, useRef, useCallback } from "react";
import { formatDate, buildFolderTree } from "../notesUtils";
import QuillEditor from "./QuillEditor";
import TagEditor from "./TagEditor";
import VersionHistory from "./VersionHistory";
import Breadcrumbs from "./Breadcrumbs";
import IconPicker from "./IconPicker";
import ReactionsBar from "./ReactionsBar";
import SubPagesPanel from "./SubPagesPanel";
import BacklinksPanel from "./BacklinksPanel";
import LinkedEntitiesPanel from "./LinkedEntitiesPanel";
import TableOfContents from "./TableOfContents";
import DrawioEditor from "./DrawioEditor";
import PresenceAvatars from "./PresenceAvatars";
import SprintEmbedBlock from "./SprintEmbedBlock";
import TimeTrackingBlock from "./TimeTrackingBlock";
import { useAuth } from "../../../AuthContext";
import {
    Pin, Copy, ArchiveRestore, Archive, Trash2, History,
    Lock, Unlock,
} from "../../../constants/icons";
import s from "./ModalEditor.module.css";
import type { NotePage, NoteFolder } from "../notesUtils";

interface ModalEditorProps {
    activePage: NotePage | null;
    pages: any[];
    folders: NoteFolder[];
    wc: { words: number; chars: number };
    modalQuillRef: React.RefObject<any>;
    tagInput: string;
    setTagInput: (v: string) => void;
    showTagInput: boolean;
    setShowTagInput: (v: boolean) => void;
    tagInputRef: React.RefObject<any>;
    onTitleChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onContentChange: (...args: any[]) => void;
    onTogglePin: (id: any) => void;
    onDuplicate: (id: any) => void;
    onToggleArchive: (id: any) => void;
    onDeletePage: () => void;
    onMoveToFolder: (id: any, folderId: string | null) => void;
    onAddTag: (...args: any[]) => void;
    onRemoveTag: (...args: any[]) => void;
    onNewPage: () => void;
    onRestoreSnapshot: (content: any, title: any) => void;
    onSelectPage?: (...args: any[]) => void;
    onSelectFolder?: (...args: any[]) => void;
    onSetPageIcon?: (id: any, icon: any, coverColor: any) => void;
    onSetPageProperties?: (...args: any[]) => void;
    onToggleReadOnly?: (id: any) => void;
    onToggleReaction?: (id: any, emoji: any, userId: any) => void;
    onNewSubPage?: (...args: any[]) => void;
    onPickPageLink?: (...args: any[]) => void;
    onInsertToc?: (...args: any[]) => void;
    drawioEditor?: { initialXml?: string } | null;
    onDrawioSave?: (...args: any[]) => void;
    onDrawioCancel?: (...args: any[]) => void;
    onDeleteDiagram?: (...args: any[]) => void;
    mentionableUsers: any[];
    onMention?: (...args: any[]) => void;
    collabUsers?: any[];
    collabConnected?: boolean;
    onConvertToTask?: (lineText: string) => Promise<any>;
    onNewOneOnOne?: (...args: any[]) => void;
}

export default function ModalEditor({
    activePage,
    pages,
    folders,
    wc,
    modalQuillRef,
    tagInput, setTagInput,
    showTagInput, setShowTagInput,
    tagInputRef,
    onTitleChange,
    onContentChange,
    onTogglePin,
    onDuplicate,
    onToggleArchive,
    onDeletePage,
    onMoveToFolder,
    onAddTag,
    onRemoveTag,
    onNewPage,
    onRestoreSnapshot,
    // New
    onSelectPage,
    onSelectFolder,
    onSetPageIcon,
    onSetPageProperties,
    onToggleReadOnly,
    onToggleReaction,
    onNewSubPage,
    onPickPageLink,
    onInsertToc,
    drawioEditor,
    onDrawioSave,
    onDrawioCancel,
    onDeleteDiagram,
    // Collaboration
    mentionableUsers,
    onMention,
    collabUsers,
    collabConnected,
    // Tier 6 — WorkPulse integrations
    onConvertToTask,
    onNewOneOnOne,
}: ModalEditorProps) {
    const { user } = useAuth() as any;
    const [showHistory, setShowHistory] = useState(false);
    const [editorResetKey, setEditorResetKey] = useState(0);
    const [iconOpen, setIconOpen] = useState(false);
    const [activeTab, setActiveTab] = useState<string | null>(null); // null | 'subpages' | 'linked'
    const editorScrollRef = useRef<HTMLDivElement | null>(null);

    // Tier 6: embedded sprint/time blocks (rendered as React components below the editor)
    const [sprintEmbeds, setSprintEmbeds] = useState<{ id: number }[]>([]);
    const [timeEmbeds, setTimeEmbeds] = useState<{ id: number }[]>([]);

    // Slash command callback: insert a sprint embed placeholder in Quill + render live component
    const handleInsertSprintEmbed = useCallback((q: any) => {
        const range = q.getSelection(true);
        q.insertText(range.index, "\n", "user");
        q.insertEmbed(range.index + 1, "divider", true, "user");
        q.insertText(range.index + 2, " 📊 Sprint Board (live embed below) ", "user");
        q.insertEmbed(range.index + 2 + " 📊 Sprint Board (live embed below) ".length, "divider", true, "user");
        q.setSelection(range.index + 2 + " 📊 Sprint Board (live embed below) ".length + 1, "silent");
        setSprintEmbeds(prev => [...prev, { id: Date.now() }]);
    }, []);

    // Slash command callback: insert a time tracking placeholder
    const handleInsertTimeBlock = useCallback((q: any) => {
        const range = q.getSelection(true);
        q.insertText(range.index, "\n", "user");
        q.insertEmbed(range.index + 1, "divider", true, "user");
        q.insertText(range.index + 2, " ⏱ Time Tracking (live embed below) ", "user");
        q.insertEmbed(range.index + 2 + " ⏱ Time Tracking (live embed below) ".length, "divider", true, "user");
        q.setSelection(range.index + 2 + " ⏱ Time Tracking (live embed below) ".length + 1, "silent");
        setTimeEmbeds(prev => [...prev, { id: Date.now() }]);
    }, []);

    // Slash command callback: convert current checklist item to task
    const handleSlashConvertToTask = useCallback(async (q: any, range: any, lineText: string) => {
        if (!lineText || !onConvertToTask) return;
        const task = await onConvertToTask(lineText);
        if (!task) return;
        try {
            // Mark the line as checked after conversion
            q.formatLine(range.index, 1, "list", "checked", "user");
            // Append " → Task #ID" to the END of the line. `q.getLine(index)` returns
            // [lineBlot, offsetWithinLine], NOT the line length — so we need to derive
            // the end-of-line index from the line blot's length.
            const [lineBlot, offsetInLine] = q.getLine(range.index) || [];
            if (!lineBlot) return;
            const lineStart = range.index - offsetInLine;
            // `lineBlot.length()` includes the trailing newline; subtract it so we
            // insert *before* the \n rather than on the next line.
            const lineEnd = lineStart + Math.max(0, lineBlot.length() - 1);
            const suffix = ` → Task #${task.id}`;
            q.insertText(lineEnd, suffix, { italic: true, color: "#10b981" }, "user");
        } catch { /* ignore — Quill APIs throw if the editor was unmounted mid-await */ }
    }, [onConvertToTask]);

    // Slash command callback: 1-on-1 with prefill
    const handleSlashNewOneOnOne = useCallback((q: any) => {
        if (typeof onNewOneOnOne === "function") {
            // Dispatch event so the store can pick it up and show a report picker
            document.dispatchEvent(new CustomEvent("notes:open-oneonone-picker"));
        }
    }, [onNewOneOnOne]);

    if (!activePage) {
        return (
            <div className={s.editorArea}>
                <div className={s.empty}>
                    <p>No pages yet</p>
                    <button className="btn btn-primary btn-sm" onClick={onNewPage}>+ New page</button>
                </div>
            </div>
        );
    }

    const readOnly = !!(activePage as any).readOnly;

    /* IMPORTANT: when the diagram editor is open we render it as an
       *overlay* on top of the editor area instead of swapping the
       layout out completely. Otherwise QuillEditor would unmount and
       (a) `modalQuillRef.current` would be null when save fires, and
       (b) the blot DOM node we hold a reference to would be detached
       — so the saved SVG would never be persisted. */
    const diagramMode = !!drawioEditor;

    return (
        <div className={`${s.editorArea} ${diagramMode ? s.editorAreaDiagram : ""}`}>
            {/* Breadcrumbs */}
            <div className={s.crumbsRow}>
                <Breadcrumbs
                    activePage={activePage}
                    pages={pages}
                    folders={folders}
                    onSelectPage={onSelectPage}
                    onSelectFolder={onSelectFolder}
                />
                <div style={{ flex: 1 }} />
                <PresenceAvatars users={collabUsers || []} connected={!!collabConnected} />
            </div>

            {/* Optional cover band */}
            {(activePage as any).coverColor && (
                <div className="notes-cover" style={{ background: (activePage as any).coverColor }} />
            )}

            {/* Title row with icon picker + actions */}
            <div className={s.titleRow}>
                <div className={s.iconPickerWrap}>
                    <button
                        type="button"
                        className={s.iconBtn}
                        onClick={() => setIconOpen(o => !o)}
                        title="Change icon / cover"
                        aria-label="Change icon"
                    >
                        <span className={s.iconChar}>{activePage.icon || "📝"}</span>
                    </button>
                    {iconOpen && (
                        <IconPicker
                            icon={activePage.icon}
                            coverColor={(activePage as any).coverColor}
                            onChange={({ icon, coverColor }: any) =>
                                onSetPageIcon?.(activePage.id, icon, coverColor)}
                            onClose={() => setIconOpen(false)}
                        />
                    )}
                </div>
                <input
                    className={s.titleInput}
                    value={activePage.title}
                    onChange={onTitleChange}
                    placeholder="Page title…"
                    disabled={readOnly}
                />
                <div className={s.actions}>
                    <button
                        className={`${s.actBtn} ${activePage.pinned ? s.actBtnActive : ""}`}
                        onClick={() => onTogglePin(activePage.id)}
                        title={activePage.pinned ? "Unpin" : "Pin to top"}
                    ><Pin size={13} /></button>
                    <button
                        className={`${s.actBtn} ${readOnly ? s.actBtnActive : ""}`}
                        onClick={() => onToggleReadOnly?.(activePage.id)}
                        title={readOnly ? "Unlock for editing" : "Lock as read-only"}
                        aria-label={readOnly ? "Unlock" : "Lock"}
                    >{readOnly ? <Lock size={13} /> : <Unlock size={13} />}</button>
                    <button className={s.actBtn} onClick={() => onDuplicate(activePage.id)} title="Duplicate"><Copy size={13} /></button>
                    <button
                        className={s.actBtn}
                        onClick={() => onToggleArchive(activePage.id)}
                        title={activePage.archived ? "Unarchive" : "Archive"}
                    >
                        {activePage.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
                    </button>
                    <button
                        className={`${s.actBtn} ${showHistory ? s.actBtnActive : ""}`}
                        onClick={() => setShowHistory(h => !h)}
                        title="Version history"
                        aria-label="Version history"
                    >
                        <History size={13} />
                    </button>
                    <button className={`${s.actBtn} ${s.actBtnDanger}`} onClick={onDeletePage} title="Delete"><Trash2 size={13} /></button>
                </div>
            </div>

            {/* Unified meta toolbar — folder, tags, reactions, sub-pages, linked */}
            <div className={s.metaRow}>
                <select
                    className={s.folderSelect}
                    value={activePage.folderId || ""}
                    onChange={e => onMoveToFolder(activePage.id, e.target.value || null)}
                    disabled={readOnly}
                >
                    <option value="">No folder</option>
                    {buildFolderTree(folders).map((f: any) => (
                        <option key={f.id} value={f.id}>{"\u00A0\u00A0".repeat(f.depth)}{f.name}</option>
                    ))}
                </select>
                <TagEditor
                    tags={(activePage as any).tags || []}
                    tagInput={tagInput}
                    setTagInput={setTagInput}
                    showTagInput={showTagInput}
                    setShowTagInput={setShowTagInput}
                    tagInputRef={tagInputRef}
                    onAddTag={onAddTag}
                    onRemoveTag={onRemoveTag}
                    pageId={activePage.id}
                />

                <div className={s.metaSpacer} />

                <ReactionsBar
                    reactions={(activePage as any).reactions || {}}
                    currentUserId={user?.id}
                    onToggle={(emoji: any) => onToggleReaction?.(activePage.id, emoji, user?.id)}
                    mentionableUsers={mentionableUsers as any}
                />
                <button
                    type="button"
                    className={`${s.tab} ${activeTab === "subpages" ? s.tabActive : ""}`}
                    onClick={() => setActiveTab(activeTab === "subpages" ? null : "subpages")}
                >
                    Sub-pages
                    {pages.filter(p => p.parentPageId === activePage.id && !p.archived).length > 0 && (
                        <span className={s.tabBadge}>
                            {pages.filter(p => p.parentPageId === activePage.id && !p.archived).length}
                        </span>
                    )}
                </button>
                <button
                    type="button"
                    className={`${s.tab} ${activeTab === "linked" ? s.tabActive : ""}`}
                    onClick={() => setActiveTab(activeTab === "linked" ? null : "linked")}
                >
                    Linked items
                </button>
            </div>
            {activeTab === "subpages" && (
                <div className={s.tabPanel}>
                    <SubPagesPanel
                        activePage={activePage}
                        pages={pages}
                        onSelectPage={onSelectPage}
                        onAddChild={onNewSubPage}
                    />
                </div>
            )}
            {activeTab === "linked" && (
                <div className={s.tabPanel}>
                    <LinkedEntitiesPanel pageId={activePage.id} />
                </div>
            )}

            {/* Read-only banner */}
            {readOnly && (
                <div className="notes-readonly-banner">
                    <Lock size={13} />
                    <span>This page is locked. Click <Lock size={11} style={{ verticalAlign: "-2px" }} /> in the toolbar to enable editing.</span>
                </div>
            )}

            {/* Editor / version-history scroll area */}
            <div className={s.editorScroll} ref={editorScrollRef}>
                {showHistory ? (
                    <VersionHistory
                        pageId={activePage.id}
                        pageTitle={activePage.title}
                        currentContent={(activePage as any).content}
                        onRestore={(content: any, title: any) => {
                            onRestoreSnapshot(content, title);
                            setEditorResetKey(k => k + 1);
                            setShowHistory(false);
                        }}
                        onClose={() => setShowHistory(false)}
                    />
                ) : (
                    <div className={s.editorWithToc}>
                        <div className={s.editorMain}>
                            <QuillEditor
                                pageId={activePage.id}
                                defaultContent={(activePage as any).content}
                                quillRef={modalQuillRef}
                                onChange={onContentChange}
                                variant="modal"
                                resetKey={editorResetKey}
                                readOnly={readOnly}
                                onPickPageLink={onPickPageLink}
                                onInsertToc={onInsertToc}
                                onPageLinkClick={onSelectPage}
                                mentionableUsers={mentionableUsers}
                                onMention={onMention}
                                onInsertSprintEmbed={handleInsertSprintEmbed}
                                onInsertTimeBlock={handleInsertTimeBlock}
                                onConvertToTask={handleSlashConvertToTask}
                                onNewOneOnOne={handleSlashNewOneOnOne}
                            />

                            {/* Tier 6 — live embedded blocks */}
                            {sprintEmbeds.map(e => (
                                <SprintEmbedBlock key={e.id}
                                    onRemove={() => setSprintEmbeds(prev => prev.filter(p => p.id !== e.id))} />
                            ))}
                            {timeEmbeds.map(e => (
                                <TimeTrackingBlock key={e.id}
                                    onRemove={() => setTimeEmbeds(prev => prev.filter(p => p.id !== e.id))} />
                            ))}

                            <BacklinksPanel
                                activePage={activePage}
                                pages={pages}
                                onSelectPage={onSelectPage}
                            />
                        </div>
                        <div className={s.tocCol}>
                            <TableOfContents
                                html={(activePage as any).content}
                                scrollContainerRef={editorScrollRef}
                            />
                        </div>
                    </div>
                )}
            </div>

            {/* Word count footer */}
            <div className={s.wordCount}>
                <div className={s.wordCountInner}>
                    <span>{wc.words} words · {wc.chars} chars</span>
                    {(activePage as any).createdAt && (
                        <span className={s.wordCountMeta}>
                            · Created {formatDate((activePage as any).createdAt)}
                            {(activePage as any).createdBy && (() => {
                                const u = mentionableUsers.find(m => m.id === (activePage as any).createdBy);
                                const name = (activePage as any).createdBy === user?.id ? "you" : (u?.name || u?.full_name || null);
                                return name ? ` by ${name}` : "";
                            })()}
                        </span>
                    )}
                    {activePage.updatedAt && (
                        <span className={s.wordCountMeta}>
                            · Edited {formatDate(activePage.updatedAt)}
                            {(activePage as any).lastEditedBy && (() => {
                                const u = mentionableUsers.find(m => m.id === (activePage as any).lastEditedBy);
                                const name = (activePage as any).lastEditedBy === user?.id ? "you" : (u?.name || u?.full_name || null);
                                return name ? ` by ${name}` : "";
                            })()}
                        </span>
                    )}
                </div>
            </div>

            {/* Diagram editor overlay — keeps Quill mounted underneath
                so saves can persist back through the live blot DOM node. */}
            {diagramMode && (
                <div className={s.diagramOverlay}>
                    <div className={s.diagramContextBar}>
                        <span className={s.diagramContextIcon}>{activePage.icon || "📝"}</span>
                        <span className={s.diagramContextTitle}>{activePage.title || "Untitled"}</span>
                        <span className={s.diagramContextSep}>›</span>
                        <span>📐 Editing diagram</span>
                    </div>
                    <div className={s.diagramFill}>
                        <DrawioEditor
                            initialXml={drawioEditor?.initialXml}
                            onSave={onDrawioSave}
                            onCancel={onDrawioCancel}
                            onDelete={onDeleteDiagram}
                        />
                    </div>
                </div>
            )}
        </div>
    );
}