/* eslint-disable @typescript-eslint/no-explicit-any */
/* QuillEditor — thin wrapper around ReactQuill with consistent styling.
   Wires in:
     • SlashMenu  — Notion-style "/" command popover.
     • MentionMenu — @mention user autocomplete.
     • Image paste — drop or paste images get embedded as data URLs
       (works immediately with no backend; can be swapped for an
       upload pipeline later by replacing the FileReader with an
       upload call). */
import React, { useEffect, useRef } from "react";
import ReactQuill from "react-quill-new";
import "react-quill-new/dist/quill.snow.css";
import "../collabCursors.css";
import ImageResizer from "../../common/ImageResizer";
import SlashMenu from "./SlashMenu";
import MentionMenu from "./MentionMenu";
import CodeBlockLanguagePicker from "./CodeBlockLanguagePicker";
import EditorContextMenu from "./EditorContextMenu";
import { QUILL_MODULES } from "../quillConfig";
import { loadKatex } from "../notesAssetsSetup";
import s from "./QuillEditor.module.css";

interface QuillEditorProps {
    pageId: string;
    defaultContent?: any;
    quillRef: React.RefObject<any>;
    onChange?: (...args: any[]) => void;
    variant?: "inline" | "modal";
    resetKey?: number;
    readOnly?: boolean;
    onPickPageLink?: (...args: any[]) => void;
    onInsertToc?: (...args: any[]) => void;
    onPageLinkClick?: (id: string) => void;
    onToggleClick?: () => void;
    mentionableUsers?: any[];
    onMention?: (...args: any[]) => void;
    onInsertSprintEmbed?: (...args: any[]) => void;
    onInsertTimeBlock?: (...args: any[]) => void;
    onConvertToTask?: (...args: any[]) => any;
    onNewOneOnOne?: (...args: any[]) => void;
}

function getEditor(ref: React.RefObject<any> | undefined): any {
    const node = ref?.current;
    if (!node) return null;
    return typeof node.getEditor === "function" ? node.getEditor() : node;
}

function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

/* Insert a single image File at the current selection (or the end). */
async function insertImageFromFile(quill: any, file: File): Promise<void> {
    if (!quill || !file || !file.type?.startsWith("image/")) return;
    try {
        const url = await fileToDataUrl(file);
        const sel = quill.getSelection(true) || { index: quill.getLength() };
        quill.insertEmbed(sel.index, "image", url, "user");
        quill.setSelection(sel.index + 1, "silent");
    } catch {
        /* swallow — pasting failed silently is better than crashing the editor */
    }
}

export default function QuillEditor({
    pageId,
    defaultContent,
    quillRef,
    onChange,
    variant = "inline", // 'inline' | 'modal'
    resetKey = 0,        // increment to force re-init (e.g. after snapshot restore)
    readOnly = false,
    onPickPageLink,
    onInsertToc,
    onPageLinkClick,
    onToggleClick,
    mentionableUsers,
    onMention,
    onInsertSprintEmbed,
    onInsertTimeBlock,
    onConvertToTask,
    onNewOneOnOne,
}: QuillEditorProps) {
    const wrapClass = variant === "modal" ? s.modalWrap : s.inlineWrap;
    const wrapRef = useRef<HTMLDivElement | null>(null);

    /* Lazy-load math runtime once. (Diagrams use the draw.io
       iframe — no client lib needed.) */
    useEffect(() => {
        loadKatex();
    }, []);

    /* ── Paste / drop image → embed as data URL ─────────────── */
    useEffect(() => {
        const quill = getEditor(quillRef);
        if (!quill) return;
        const root = quill.root;
        if (!root) return;

        const onPaste = (e: ClipboardEvent) => {
            const items = e.clipboardData?.items;
            if (!items) return;
            for (const item of items) {
                if (item.kind === "file" && item.type.startsWith("image/")) {
                    e.preventDefault();
                    const file = item.getAsFile();
                    if (file) insertImageFromFile(quill, file);
                    return;
                }
            }
        };

        const onDrop = (e: DragEvent) => {
            const files = e.dataTransfer?.files;
            if (!files || files.length === 0) return;
            const imgs = Array.from(files).filter(f => f.type.startsWith("image/"));
            if (imgs.length === 0) return;
            e.preventDefault();
            // Move caret to drop position when possible
            try {
                const range = quill.getSelection();
                if (!range) {
                    quill.focus();
                    quill.setSelection(quill.getLength(), "silent");
                }
            } catch { /* ignore */ }
            imgs.forEach(file => insertImageFromFile(quill, file));
        };

        const onDragOver = (e: DragEvent) => {
            // Allow drop
            if (e.dataTransfer && Array.from(e.dataTransfer.items || []).some(i => i.kind === "file")) {
                e.preventDefault();
            }
        };

        root.addEventListener("paste", onPaste);
        root.addEventListener("drop", onDrop);
        root.addEventListener("dragover", onDragOver);
        return () => {
            root.removeEventListener("paste", onPaste);
            root.removeEventListener("drop", onDrop);
            root.removeEventListener("dragover", onDragOver);
        };
        // Re-bind whenever Quill is re-created (pageId / resetKey)
    }, [quillRef, pageId, resetKey]);

    /* ── Page-link click + toggle expand/collapse ───────────── */
    useEffect(() => {
        const quill = getEditor(quillRef);
        if (!quill) return;
        const root = quill.root;
        if (!root) return;

        const onClick = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            // Internal page link
            const link = target.closest?.("a.ql-pagelink");
            if (link) {
                e.preventDefault();
                const id = link.getAttribute("data-page-id");
                if (id && onPageLinkClick) onPageLinkClick(id);
                return;
            }
            // Toggle block: clicking the chevron region toggles open state
            const toggle = target.closest?.(".ql-toggle");
            if (toggle && (e as any).offsetX < 28) {
                e.preventDefault();
                const open = toggle.getAttribute("data-open") !== "false";
                toggle.setAttribute("data-open", open ? "false" : "true");
                if (onToggleClick) onToggleClick();
            }
        };
        root.addEventListener("click", onClick);
        return () => root.removeEventListener("click", onClick);
    }, [quillRef, pageId, resetKey, onPageLinkClick, onToggleClick]);

    /* ── Apply read-only state ──────────────────────────────── */
    useEffect(() => {
        const quill = getEditor(quillRef);
        if (!quill) return;
        quill.enable(!readOnly);
    }, [quillRef, pageId, resetKey, readOnly]);

    /* ── Add hover tooltips to the toolbar buttons ──────────── */
    useEffect(() => {
        const wrap = wrapRef.current;
        if (!wrap) return;
        const toolbar = wrap.querySelector(".ql-toolbar");
        if (!toolbar) return;

        // [selector, tooltip] — selector is matched within the toolbar
        const TIPS: [string, string][] = [
            [".ql-bold", "Bold (Ctrl+B)"],
            [".ql-italic", "Italic (Ctrl+I)"],
            [".ql-underline", "Underline (Ctrl+U)"],
            [".ql-blockquote", "Quote"],
            [".ql-link", "Insert link"],
            [".ql-image", "Insert image"],
            [".ql-clean", "Clear formatting"],
            [".ql-divider", "Divider"],
            [".ql-timestamp", "Insert date & time"],
            [".ql-table", "Insert table"],
            ['.ql-list[value="ordered"]', "Numbered list"],
            ['.ql-list[value="bullet"]', "Bullet list"],
            ['.ql-list[value="check"]', "Checklist"],
            [".ql-color", "Text color"],
            [".ql-background", "Highlight color"],
            [".ql-header", "Heading style"],
        ];

        TIPS.forEach(([sel, tip]) => {
            toolbar.querySelectorAll(sel).forEach((el: Element) => {
                // For pickers, the clickable label is `.ql-picker-label`.
                const target = el.classList.contains("ql-picker")
                    ? el.querySelector(".ql-picker-label") || el
                    : el;
                target.setAttribute("title", tip);
                target.setAttribute("aria-label", tip);
            });
        });
    }, [quillRef, pageId, resetKey]);

    return (
        <div ref={wrapRef} className={`${wrapClass} ${readOnly ? "notes-readonly" : ""}`}>
            <ReactQuill
                key={`${pageId}-${resetKey}`}
                ref={quillRef}
                theme="snow"
                defaultValue={defaultContent}
                onChange={onChange}
                modules={QUILL_MODULES as any}
                readOnly={readOnly}
                placeholder="Start writing… or press / for commands"
            />
            <ImageResizer quillRef={quillRef} />
            <SlashMenu
                quillRef={quillRef}
                pageId={pageId}
                resetKey={resetKey}
                onPickPageLink={onPickPageLink}
                onInsertToc={onInsertToc}
                onInsertSprintEmbed={onInsertSprintEmbed}
                onInsertTimeBlock={onInsertTimeBlock}
                onConvertToTask={onConvertToTask}
                onNewOneOnOne={onNewOneOnOne}
            />
            <MentionMenu
                quillRef={quillRef}
                pageId={pageId}
                resetKey={resetKey}
                users={mentionableUsers || []}
                onMention={onMention}
            />
            <CodeBlockLanguagePicker
                quillRef={quillRef}
                pageId={pageId}
                resetKey={resetKey}
            />
            <EditorContextMenu
                quillRef={quillRef}
                pageId={pageId}
                resetKey={resetKey}
                readOnly={readOnly}
            />
        </div>
    );
}