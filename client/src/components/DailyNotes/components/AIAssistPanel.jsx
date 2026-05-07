/* ─────────────────────────────────────────────────────────
   AIAssistPanel — floating chat-style window with local AI helpers.
   Renders via createPortal in the bottom-right corner with a
   close icon, like Intercom / Notion AI.

   Operates entirely on the client using notesAi heuristics:
     • Summarise the page (extractive)
     • Pull out action items
     • Generate / refresh outline
     • Improve writing (lightweight cleanup)

   Each result can be inserted back into the page at the
   current caret with one click — no LLM needed.
   ───────────────────────────────────────────────────────── */
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    Sparkles, X, FileText, CheckSquare, ListTree, Hammer,
} from '../../../constants/icons';
import {
    summarise,
    extractActionItems,
    outline,
    improveWriting,
} from '../notesAi';
import { stripHtml } from '../notesUtils';
import s from './AIAssistPanel.module.css';

const TOOLS = [
    { id: 'summary', label: 'Summarise', icon: FileText, hint: 'Top-3 sentences' },
    { id: 'actions', label: 'Action items', icon: CheckSquare, hint: 'Pull todos' },
    { id: 'outline', label: 'Outline', icon: ListTree, hint: 'Heading map' },
    { id: 'polish', label: 'Polish writing', icon: Hammer, hint: 'Light cleanup' },
];

function escapeHtml(s) {
    return (s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export default function AIAssistPanel({
    activePage,
    quillRef,
    onClose,
}) {
    const [activeTool, setActiveTool] = useState('summary');
    const html = activePage?.content || '';

    /* Esc to close */
    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    const result = useMemo(() => {
        if (!activePage) return { kind: 'empty', text: '' };
        const wordCount = stripHtml(html).split(/\s+/).filter(Boolean).length;
        if (wordCount < 8) return { kind: 'sparse', text: '' };

        switch (activeTool) {
            case 'summary': {
                const text = summarise(html, 3);
                return { kind: 'text', text };
            }
            case 'actions': {
                const items = extractActionItems(html);
                return { kind: 'list', items };
            }
            case 'outline': {
                const items = outline(html);
                return { kind: 'outline', items };
            }
            case 'polish': {
                const text = improveWriting(stripHtml(html));
                return { kind: 'text', text };
            }
            default:
                return { kind: 'empty', text: '' };
        }
    }, [html, activeTool, activePage]);

    const getEditor = () => {
        const node = quillRef?.current;
        if (!node) return null;
        return typeof node.getEditor === 'function' ? node.getEditor() : node;
    };

    const insertHtmlAtCursor = (html) => {
        const q = getEditor();
        if (!q || !html) return;
        const range = q.getSelection(true) || { index: q.getLength() };
        q.clipboard.dangerouslyPasteHTML(range.index, html, 'user');
    };

    const insertSummary = () => {
        if (result.kind !== 'text' || !result.text) return;
        const html =
            `<h3>Summary</h3>` +
            `<p><em>${escapeHtml(result.text)}</em></p>` +
            `<p><br></p>`;
        insertHtmlAtCursor(html);
    };

    const insertActions = () => {
        if (result.kind !== 'list' || result.items.length === 0) return;
        const lis = result.items
            .map(it => `<li data-list="${it.done ? 'checked' : 'unchecked'}">${escapeHtml(it.text)}</li>`)
            .join('');
        insertHtmlAtCursor(`<h3>Action items</h3><ul>${lis}</ul><p><br></p>`);
    };

    const insertOutline = () => {
        if (result.kind !== 'outline' || result.items.length === 0) return;
        const lis = result.items
            .map(h => `<li>${'&nbsp;'.repeat((h.level - 1) * 2)}${escapeHtml(h.text)}</li>`)
            .join('');
        insertHtmlAtCursor(`<h3>Outline</h3><ul>${lis}</ul><p><br></p>`);
    };

    const replaceContentWithPolished = () => {
        if (result.kind !== 'text' || !result.text) return;
        const q = getEditor();
        if (!q) return;
        if (typeof window !== 'undefined') {
            const ok = window.confirm(
                'Replace the page content with the polished version? This cannot be undone via the editor.',
            );
            if (!ok) return;
        }
        const paragraphs = result.text
            .split(/(?<=[.!?])\s+(?=[A-Z(])/)
            .map(p => `<p>${escapeHtml(p)}</p>`)
            .join('');
        q.setText('');
        q.clipboard.dangerouslyPasteHTML(0, paragraphs, 'user');
    };

    return createPortal(
        <div className={s.window} role="dialog" aria-label="AI assist">
            <div className={s.header}>
                <div className={s.titleWrap}>
                    <span className={s.title}>
                        <Sparkles size={14} /> AI assist
                    </span>
                    <span className={s.subtitle}>
                        On-device — no data leaves WorkPulse
                    </span>
                </div>
                <button className={s.closeBtn} onClick={onClose} aria-label="Close" title="Close (Esc)">
                    <X size={15} />
                </button>
            </div>

            <div className={s.tools} role="tablist">
                {TOOLS.map(t => {
                    const Icon = t.icon;
                    const on = activeTool === t.id;
                    return (
                        <button
                            key={t.id}
                            className={`${s.tool} ${on ? s.toolOn : ''}`}
                            onClick={() => setActiveTool(t.id)}
                            role="tab"
                            aria-selected={on}
                        >
                            <span className={s.toolIcon}><Icon size={14} /></span>
                            <span className={s.toolLabel}>{t.label}</span>
                            <span className={s.toolHint}>{t.hint}</span>
                        </button>
                    );
                })}
            </div>

            <div className={s.body}>
                {!activePage && (
                    <p className={s.muted}>Open a page to get suggestions.</p>
                )}

                {activePage && result.kind === 'sparse' && (
                    <p className={s.muted}>
                        Add a few more sentences to this page first — at least ~8 words.
                    </p>
                )}

                {result.kind === 'text' && !result.text && (
                    <p className={s.muted}>Nothing useful to extract yet.</p>
                )}

                {activeTool === 'summary' && result.kind === 'text' && result.text && (
                    <>
                        <p className={s.resultText}>{result.text}</p>
                        <div className={s.actions}>
                            <button className="btn btn-primary btn-sm" onClick={insertSummary}>
                                Insert into page
                            </button>
                        </div>
                    </>
                )}

                {activeTool === 'actions' && result.kind === 'list' && (
                    <>
                        {result.items.length === 0 ? (
                            <p className={s.muted}>
                                No checklist items or "TODO:" lines found on this page.
                            </p>
                        ) : (
                            <>
                                <ul className={s.list}>
                                    {result.items.map((it, i) => (
                                        <li key={i} className={it.done ? s.itemDone : ''}>
                                            <span className={s.itemBox}>
                                                {it.done ? '☑' : '☐'}
                                            </span>
                                            {it.text}
                                        </li>
                                    ))}
                                </ul>
                                <div className={s.actions}>
                                    <button className="btn btn-primary btn-sm" onClick={insertActions}>
                                        Insert {result.items.length} item{result.items.length === 1 ? '' : 's'}
                                    </button>
                                </div>
                            </>
                        )}
                    </>
                )}

                {activeTool === 'outline' && result.kind === 'outline' && (
                    <>
                        {result.items.length === 0 ? (
                            <p className={s.muted}>
                                Add some H1/H2/H3 headings first to generate an outline.
                            </p>
                        ) : (
                            <>
                                <ul className={s.outline}>
                                    {result.items.map((h, i) => (
                                        <li
                                            key={i}
                                            className={s.outlineItem}
                                            style={{ paddingLeft: (h.level - 1) * 14 }}
                                        >
                                            <span className={s.outlineLevel}>H{h.level}</span>
                                            <span>{h.text}</span>
                                        </li>
                                    ))}
                                </ul>
                                <div className={s.actions}>
                                    <button className="btn btn-primary btn-sm" onClick={insertOutline}>
                                        Insert outline
                                    </button>
                                </div>
                            </>
                        )}
                    </>
                )}

                {activeTool === 'polish' && result.kind === 'text' && result.text && (
                    <>
                        <pre className={s.polishPre}>{result.text}</pre>
                        <div className={s.actions}>
                            <button
                                className="btn btn-secondary btn-sm"
                                onClick={() =>
                                    navigator?.clipboard?.writeText?.(result.text)
                                }
                            >
                                Copy
                            </button>
                            <button
                                className="btn btn-primary btn-sm"
                                onClick={replaceContentWithPolished}
                            >
                                Replace page
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>,
        document.body,
    );
}