/* ModalEditor — right panel of the maximized modal.
   Now also renders breadcrumbs, page metadata (icon/cover/properties),
   reactions, sub-pages, backlinks and a sticky table of contents. */
import React, { useState, useRef } from 'react';
import { formatDate, buildFolderTree } from '../notesUtils';
import QuillEditor from './QuillEditor';
import TagEditor from './TagEditor';
import VersionHistory from './VersionHistory';
import Breadcrumbs from './Breadcrumbs';
import IconPicker from './IconPicker';
import PagePropertiesPanel from './PagePropertiesPanel';
import ReactionsBar from './ReactionsBar';
import SubPagesPanel from './SubPagesPanel';
import BacklinksPanel from './BacklinksPanel';
import TableOfContents from './TableOfContents';
import DrawioEditor from './DrawioEditor';
import AIAssistPanel from './AIAssistPanel';
import SmartSuggestionsPanel from './SmartSuggestionsPanel';
import { useAuth } from '../../../AuthContext';
import {
    Pin, Copy, ArchiveRestore, Archive, Trash2, History,
    Lock, Unlock, Plus, Settings,
} from '../../../constants/icons';
import s from './ModalEditor.module.css';

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
}) {
    const { user } = useAuth();
    const [showHistory, setShowHistory] = useState(false);
    const [editorResetKey, setEditorResetKey] = useState(0);
    const [iconOpen, setIconOpen] = useState(false);
    const [propertiesOpen, setPropertiesOpen] = useState(false);
    const editorScrollRef = useRef(null);

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

    const readOnly = !!activePage.readOnly;

    /* IMPORTANT: when the diagram editor is open we render it as an
       *overlay* on top of the editor area instead of swapping the
       layout out completely. Otherwise QuillEditor would unmount and
       (a) `modalQuillRef.current` would be null when save fires, and
       (b) the blot DOM node we hold a reference to would be detached
       — so the saved SVG would never be persisted. */
    const diagramMode = !!drawioEditor;

    return (
        <div className={`${s.editorArea} ${diagramMode ? s.editorAreaDiagram : ''}`}>
            {/* Breadcrumbs */}
            <div className={s.crumbsRow}>
                <Breadcrumbs
                    activePage={activePage}
                    pages={pages}
                    folders={folders}
                    onSelectPage={onSelectPage}
                    onSelectFolder={onSelectFolder}
                />
            </div>

            {/* Optional cover band */}
            {activePage.coverColor && (
                <div className="notes-cover" style={{ background: activePage.coverColor }} />
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
                        <span className={s.iconChar}>{activePage.icon || '📝'}</span>
                    </button>
                    {iconOpen && (
                        <IconPicker
                            icon={activePage.icon}
                            coverColor={activePage.coverColor}
                            onChange={({ icon, coverColor }) =>
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
                        className={`${s.actBtn} ${propertiesOpen ? s.actBtnActive : ''}`}
                        onClick={() => setPropertiesOpen(o => !o)}
                        title="Page properties"
                        aria-label="Page properties"
                    ><Settings size={13} /></button>
                    <button
                        className={`${s.actBtn} ${activePage.pinned ? s.actBtnActive : ''}`}
                        onClick={() => onTogglePin(activePage.id)}
                        title={activePage.pinned ? 'Unpin' : 'Pin to top'}
                    ><Pin size={13} /></button>
                    <button
                        className={`${s.actBtn} ${readOnly ? s.actBtnActive : ''}`}
                        onClick={() => onToggleReadOnly?.(activePage.id)}
                        title={readOnly ? 'Unlock for editing' : 'Lock as read-only'}
                        aria-label={readOnly ? 'Unlock' : 'Lock'}
                    >{readOnly ? <Lock size={13} /> : <Unlock size={13} />}</button>
                    <button className={s.actBtn} onClick={() => onDuplicate(activePage.id)} title="Duplicate"><Copy size={13} /></button>
                    <button
                        className={s.actBtn}
                        onClick={() => onToggleArchive(activePage.id)}
                        title={activePage.archived ? 'Unarchive' : 'Archive'}
                    >
                        {activePage.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
                    </button>
                    <button
                        className={`${s.actBtn} ${showHistory ? s.actBtnActive : ''}`}
                        onClick={() => setShowHistory(h => !h)}
                        title="Version history"
                        aria-label="Version history"
                    >
                        <History size={13} />
                    </button>
                    <button className={`${s.actBtn} ${s.actBtnDanger}`} onClick={onDeletePage} title="Delete"><Trash2 size={13} /></button>
                </div>
            </div>

            {/* Folder + tag row */}
            <div className={s.metaRow}>
                <select
                    className={s.folderSelect}
                    value={activePage.folderId || ''}
                    onChange={e => onMoveToFolder(activePage.id, e.target.value || null)}
                    disabled={readOnly}
                >
                    <option value="">No folder</option>
                    {buildFolderTree(folders).map(f => (
                        <option key={f.id} value={f.id}>{'\u00A0\u00A0'.repeat(f.depth)}{f.name}</option>
                    ))}
                </select>
                <TagEditor
                    tags={activePage.tags || []}
                    tagInput={tagInput}
                    setTagInput={setTagInput}
                    showTagInput={showTagInput}
                    setShowTagInput={setShowTagInput}
                    tagInputRef={tagInputRef}
                    onAddTag={onAddTag}
                    onRemoveTag={onRemoveTag}
                    pageId={activePage.id}
                />
            </div>

            {/* Properties panel (collapsible) */}
            {propertiesOpen && (
                <PagePropertiesPanel
                    page={activePage}
                    readOnly={readOnly}
                    onChange={(properties) => onSetPageProperties?.(activePage.id, properties)}
                />
            )}

            {/* Reactions */}
            <ReactionsBar
                reactions={activePage.reactions || {}}
                currentUserId={user?.id}
                onToggle={(emoji) => onToggleReaction?.(activePage.id, emoji, user?.id)}
            />

            {/* Read-only banner */}
            {readOnly && (
                <div className="notes-readonly-banner">
                    <Lock size={13} />
                    <span>This page is locked. Click <Lock size={11} style={{ verticalAlign: '-2px' }} /> in the toolbar to enable editing.</span>
                </div>
            )}

            {/* Editor / version-history scroll area */}
            <div className={s.editorScroll} ref={editorScrollRef}>
                {showHistory ? (
                    <VersionHistory
                        pageId={activePage.id}
                        pageTitle={activePage.title}
                        currentContent={activePage.content}
                        onRestore={(content, title) => {
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
                                defaultContent={activePage.content}
                                quillRef={modalQuillRef}
                                onChange={onContentChange}
                                variant="modal"
                                resetKey={editorResetKey}
                                readOnly={readOnly}
                                onPickPageLink={onPickPageLink}
                                onInsertToc={onInsertToc}
                                onPageLinkClick={onSelectPage}
                            />

                            <SubPagesPanel
                                activePage={activePage}
                                pages={pages}
                                onSelectPage={onSelectPage}
                                onAddChild={onNewSubPage}
                            />

                            <BacklinksPanel
                                activePage={activePage}
                                pages={pages}
                                onSelectPage={onSelectPage}
                            />
                        </div>
                        <div className={s.tocCol}>
                            <TableOfContents
                                html={activePage.content}
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
                    {activePage.createdAt && (
                        <span className={s.wordCountMeta}>· Created {formatDate(activePage.createdAt)}</span>
                    )}
                    {activePage.updatedAt && (
                        <span className={s.wordCountMeta}>· Edited {formatDate(activePage.updatedAt)}</span>
                    )}
                </div>
            </div>

            {/* Diagram editor overlay — keeps Quill mounted underneath
                so saves can persist back through the live blot DOM node. */}
            {diagramMode && (
                <div className={s.diagramOverlay}>
                    <div className={s.diagramContextBar}>
                        <span className={s.diagramContextIcon}>{activePage.icon || '📝'}</span>
                        <span className={s.diagramContextTitle}>{activePage.title || 'Untitled'}</span>
                        <span className={s.diagramContextSep}>›</span>
                        <span>📐 Editing diagram</span>
                    </div>
                    <div className={s.diagramFill}>
                        <DrawioEditor
                            initialXml={drawioEditor.initialXml}
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
