/* EditorContextMenu — right-click context menu for the Quill editor canvas.
   Detects the element type at the click position and shows relevant actions
   like delete, copy, duplicate, change variant, etc. */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    Trash2, Copy, Clipboard, ClipboardPaste, Scissors,
    Type, Image as ImageIcon, Table2, Code2, Minus, SplitSquareHorizontal,
    Volume2, PencilLine, MessageSquareQuote, ChevronRight,
} from 'lucide-react';
import s from './EditorContextMenu.module.css';

/* ── Detect what the right-click landed on ──────────────── */
function detectTarget(el) {
    if (!el) return null;

    // Walk up to find a recognisable block
    let node = el;
    while (node && !node.classList?.contains('ql-editor')) {
        // Image
        if (node.tagName === 'IMG') {
            return { type: 'image', node, label: 'Image' };
        }
        // Divider
        if (node.tagName === 'HR') {
            return { type: 'divider', node, label: 'Divider' };
        }
        // Table
        if (node.classList?.contains('ql-simpletable')) {
            return { type: 'table', node, label: 'Table' };
        }
        // Diagram
        if (node.classList?.contains('ql-drawio')) {
            return { type: 'diagram', node, label: 'Diagram' };
        }
        // Code block
        if (node.tagName === 'PRE' && node.classList?.contains('ql-syntax')) {
            return { type: 'codeblock', node, label: 'Code block' };
        }
        // Math
        if (node.classList?.contains('ql-math')) {
            return { type: 'math', node, label: 'Math block' };
        }
        // Audio
        if (node.classList?.contains('ql-audio')) {
            return { type: 'audio', node, label: 'Audio recording' };
        }
        // Callout
        if (node.classList?.contains('ql-callout')) {
            return { type: 'callout', node, label: 'Callout', variant: node.getAttribute('data-callout') || 'info' };
        }
        // Toggle
        if (node.classList?.contains('ql-toggle')) {
            return { type: 'toggle', node, label: 'Toggle block' };
        }
        // Mention
        if (node.classList?.contains('ql-mention')) {
            return { type: 'mention', node, label: 'Mention' };
        }
        // Page link
        if (node.classList?.contains('ql-pagelink')) {
            return { type: 'pagelink', node, label: 'Page link' };
        }
        // Date chip
        if (node.classList?.contains('ql-datechip')) {
            return { type: 'datechip', node, label: 'Date chip' };
        }
        // Blockquote
        if (node.tagName === 'BLOCKQUOTE') {
            return { type: 'blockquote', node, label: 'Quote' };
        }
        // List item
        if (node.tagName === 'LI' && node.closest('.ql-editor')) {
            return { type: 'listitem', node, label: 'List item' };
        }
        // Heading
        if (/^H[1-6]$/.test(node.tagName) && node.closest('.ql-editor')) {
            return { type: 'heading', node, label: `Heading ${node.tagName.slice(1)}` };
        }
        // Paragraph (only if directly inside ql-editor)
        if (node.tagName === 'P' && node.parentNode?.classList?.contains('ql-editor')) {
            return { type: 'paragraph', node, label: 'Paragraph' };
        }
        node = node.parentNode;
    }
    return null;
}

/* ── Icon for element type ──────────────────────────────── */
function getTypeIcon(type) {
    const size = 13;
    switch (type) {
        case 'image': return <ImageIcon size={size} />;
        case 'divider': return <Minus size={size} />;
        case 'table': return <Table2 size={size} />;
        case 'diagram': return <PencilLine size={size} />;
        case 'codeblock': return <Code2 size={size} />;
        case 'math': return <Type size={size} />;
        case 'audio': return <Volume2 size={size} />;
        case 'callout': return <MessageSquareQuote size={size} />;
        case 'toggle': return <SplitSquareHorizontal size={size} />;
        default: return <Type size={size} />;
    }
}

const CALLOUT_VARIANTS = [
    { id: 'info', label: 'ℹ️ Info', color: '#3b82f6' },
    { id: 'warn', label: '⚠️ Warning', color: '#f59e0b' },
    { id: 'success', label: '✅ Success', color: '#10b981' },
    { id: 'tip', label: '💡 Tip', color: '#8b5cf6' },
];

export default function EditorContextMenu({ quillRef, pageId, resetKey, readOnly }) {
    const [menu, setMenu] = useState(null); // { x, y, target, hasSelection }
    const [subMenu, setSubMenu] = useState(null); // for callout variant picker
    const menuRef = useRef(null);

    const getQuill = useCallback(() => {
        const node = quillRef?.current;
        if (!node) return null;
        return typeof node.getEditor === 'function' ? node.getEditor() : node;
    }, [quillRef]);

    // Close on outside click / scroll / Escape
    useEffect(() => {
        if (!menu) return;
        const close = () => { setMenu(null); setSubMenu(null); };
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        document.addEventListener('mousedown', (e) => {
            if (menuRef.current && !menuRef.current.contains(e.target)) close();
        });
        document.addEventListener('scroll', close, true);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', close);
            document.removeEventListener('scroll', close, true);
            document.removeEventListener('keydown', onKey);
        };
    }, [menu]);

    // Attach contextmenu listener to Quill root
    useEffect(() => {
        const quill = getQuill();
        if (!quill) return;
        const root = quill.root;
        if (!root) return;

        const onContext = (e) => {
            const target = detectTarget(e.target);
            const sel = quill.getSelection();
            const hasSelection = sel && sel.length > 0;

            // Only show custom menu if we detected a block OR have a text selection
            if (!target && !hasSelection) return;

            e.preventDefault();

            // Position relative to viewport
            const x = e.clientX;
            const y = e.clientY;
            setSubMenu(null);
            setMenu({ x, y, target, hasSelection });
        };

        root.addEventListener('contextmenu', onContext);
        return () => root.removeEventListener('contextmenu', onContext);
    }, [getQuill, pageId, resetKey]);

    /* ── Actions ──────────────────────────────────────────── */

    const deleteBlock = useCallback(() => {
        const quill = getQuill();
        const target = menu?.target;
        if (!quill || !target) return;
        const blot = Quill_findBlot(quill, target.node);
        if (blot) {
            const idx = quill.getIndex(blot);
            const len = blot.length?.() || 1;
            quill.deleteText(idx, len, 'user');
        } else {
            // Fallback: try removing the DOM node's content via selection
            target.node.remove();
        }
        setMenu(null);
    }, [getQuill, menu]);

    const duplicateBlock = useCallback(() => {
        const quill = getQuill();
        const target = menu?.target;
        if (!quill || !target) return;
        const blot = Quill_findBlot(quill, target.node);
        if (blot) {
            const idx = quill.getIndex(blot);
            const len = blot.length?.() || 1;
            const delta = quill.getContents(idx, len);
            quill.updateContents({ ops: [{ retain: idx + len }, ...delta.ops] }, 'user');
        }
        setMenu(null);
    }, [getQuill, menu]);

    const copySelection = useCallback(() => {
        const quill = getQuill();
        if (!quill) return;
        const sel = quill.getSelection();
        if (sel && sel.length > 0) {
            const text = quill.getText(sel.index, sel.length);
            navigator.clipboard?.writeText(text);
        }
        setMenu(null);
    }, [getQuill]);

    const cutSelection = useCallback(() => {
        const quill = getQuill();
        if (!quill || readOnly) return;
        const sel = quill.getSelection();
        if (sel && sel.length > 0) {
            const text = quill.getText(sel.index, sel.length);
            navigator.clipboard?.writeText(text);
            quill.deleteText(sel.index, sel.length, 'user');
        }
        setMenu(null);
    }, [getQuill, readOnly]);

    const pasteFromClipboard = useCallback(async () => {
        const quill = getQuill();
        if (!quill || readOnly) return;
        try {
            const text = await navigator.clipboard?.readText();
            if (text) {
                const sel = quill.getSelection(true) || { index: quill.getLength() };
                quill.insertText(sel.index, text, 'user');
            }
        } catch { /* clipboard permission denied */ }
        setMenu(null);
    }, [getQuill, readOnly]);

    const changeCalloutVariant = useCallback((variant) => {
        const target = menu?.target;
        if (!target || target.type !== 'callout') return;
        target.node.setAttribute('data-callout', variant);
        setMenu(null);
        setSubMenu(null);
    }, [menu]);

    const convertHeadingLevel = useCallback((level) => {
        const quill = getQuill();
        const target = menu?.target;
        if (!quill || !target) return;
        const blot = Quill_findBlot(quill, target.node);
        if (blot) {
            const idx = quill.getIndex(blot);
            quill.formatLine(idx, 1, 'header', level || false, 'user');
        }
        setMenu(null);
    }, [getQuill, menu]);

    const turnIntoBlockquote = useCallback(() => {
        const quill = getQuill();
        const target = menu?.target;
        if (!quill || !target) return;
        const blot = Quill_findBlot(quill, target.node);
        if (blot) {
            const idx = quill.getIndex(blot);
            quill.formatLine(idx, 1, 'blockquote', true, 'user');
        }
        setMenu(null);
    }, [getQuill, menu]);

    const removeBlockquote = useCallback(() => {
        const quill = getQuill();
        const target = menu?.target;
        if (!quill || !target) return;
        const blot = Quill_findBlot(quill, target.node);
        if (blot) {
            const idx = quill.getIndex(blot);
            quill.formatLine(idx, 1, 'blockquote', false, 'user');
        }
        setMenu(null);
    }, [getQuill, menu]);

    if (!menu) return null;

    const { target, hasSelection } = menu;
    const embeds = ['image', 'divider', 'table', 'diagram', 'math', 'audio'];
    const isEmbed = target && embeds.includes(target.type);

    // Adjust position to stay within viewport
    const style = { position: 'fixed', left: menu.x, top: menu.y, zIndex: 10000 };

    return (
        <div className={s.overlay}>
            <div className={s.menu} style={style} ref={menuRef}>
                {/* Header showing what was clicked */}
                {target && (
                    <div className={s.header}>
                        {getTypeIcon(target.type)}
                        <span>{target.label}</span>
                    </div>
                )}

                {/* Text selection actions */}
                {hasSelection && (
                    <>
                        <button className={s.item} onClick={copySelection}>
                            <Copy size={13} /> Copy
                            <span className={s.shortcut}>Ctrl+C</span>
                        </button>
                        {!readOnly && (
                            <button className={s.item} onClick={cutSelection}>
                                <Scissors size={13} /> Cut
                                <span className={s.shortcut}>Ctrl+X</span>
                            </button>
                        )}
                    </>
                )}

                {/* Paste */}
                {!readOnly && (
                    <button className={s.item} onClick={pasteFromClipboard}>
                        <ClipboardPaste size={13} /> Paste
                        <span className={s.shortcut}>Ctrl+V</span>
                    </button>
                )}

                {/* Separator if we have both selection and block actions */}
                {hasSelection && target && <div className={s.separator} />}

                {/* Block-level actions */}
                {target && !readOnly && (
                    <>
                        {/* Delete block */}
                        <button className={`${s.item} ${s.danger}`} onClick={deleteBlock}>
                            <Trash2 size={13} /> Delete {target.label.toLowerCase()}
                        </button>

                        {/* Duplicate (for embeds and blocks) */}
                        {(isEmbed || target.type === 'callout' || target.type === 'codeblock') && (
                            <button className={s.item} onClick={duplicateBlock}>
                                <Copy size={13} /> Duplicate
                            </button>
                        )}

                        <div className={s.separator} />

                        {/* Callout: change variant */}
                        {target.type === 'callout' && (
                            <div className={s.subMenuWrap}
                                onMouseEnter={() => setSubMenu('callout-variant')}
                                onMouseLeave={() => setSubMenu(null)}>
                                <button className={s.item}>
                                    <MessageSquareQuote size={13} /> Change style
                                    <ChevronRight size={12} className={s.subArrow} />
                                </button>
                                {subMenu === 'callout-variant' && (
                                    <div className={s.subMenu}>
                                        {CALLOUT_VARIANTS.map(v => (
                                            <button key={v.id} className={s.item}
                                                onClick={() => changeCalloutVariant(v.id)}>
                                                <span>{v.label}</span>
                                                {target.variant === v.id && <span className={s.check}>✓</span>}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Heading: change level */}
                        {target.type === 'heading' && (
                            <div className={s.subMenuWrap}
                                onMouseEnter={() => setSubMenu('heading-level')}
                                onMouseLeave={() => setSubMenu(null)}>
                                <button className={s.item}>
                                    <Type size={13} /> Change heading
                                    <ChevronRight size={12} className={s.subArrow} />
                                </button>
                                {subMenu === 'heading-level' && (
                                    <div className={s.subMenu}>
                                        {[1, 2, 3].map(lv => (
                                            <button key={lv} className={s.item}
                                                onClick={() => convertHeadingLevel(lv)}>
                                                <span>H{lv}</span>
                                            </button>
                                        ))}
                                        <div className={s.separator} />
                                        <button className={s.item} onClick={() => convertHeadingLevel(false)}>
                                            <span>Normal text</span>
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Paragraph: turn into */}
                        {target.type === 'paragraph' && (
                            <div className={s.subMenuWrap}
                                onMouseEnter={() => setSubMenu('turn-into')}
                                onMouseLeave={() => setSubMenu(null)}>
                                <button className={s.item}>
                                    <Type size={13} /> Turn into
                                    <ChevronRight size={12} className={s.subArrow} />
                                </button>
                                {subMenu === 'turn-into' && (
                                    <div className={s.subMenu}>
                                        {[1, 2, 3].map(lv => (
                                            <button key={lv} className={s.item}
                                                onClick={() => convertHeadingLevel(lv)}>
                                                <span>Heading {lv}</span>
                                            </button>
                                        ))}
                                        <div className={s.separator} />
                                        <button className={s.item} onClick={turnIntoBlockquote}>
                                            <MessageSquareQuote size={13} /> Quote
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Blockquote: remove formatting */}
                        {target.type === 'blockquote' && (
                            <button className={s.item} onClick={removeBlockquote}>
                                <Type size={13} /> Turn into paragraph
                            </button>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

/* Helper: find the Quill blot for a DOM node */
function Quill_findBlot(quill, node) {
    try {
        const Parchment = quill.scroll?.constructor?.name === 'Scroll'
            ? quill.scroll
            : null;
        // Try Quill's own find method
        if (quill.scroll?.find) {
            let cur = node;
            while (cur && cur !== quill.root) {
                const blot = quill.scroll.find(cur, false);
                if (blot) return blot;
                cur = cur.parentNode;
            }
        }
    } catch { /* ignore */ }
    return null;
}
