/* ─────────────────────────────────────────────────────────
   SlashMenu — Notion-style "/" command menu for the Quill
   editor. Listens for a '/' typed at the start of a line and
   shows a floating list of block-insert commands. Arrow keys
   navigate, Enter selects, Escape (or any non-matching key)
   closes the menu.

   Implementation notes:
   - Driven by a Quill 'text-change' listener that detects the
     trigger character and the typed query that follows.
   - Position is computed from `getBounds(index)` on the Quill
     instance, then anchored to the editor scroll container.
   - All commands operate via the public Quill API so they
     compose with the existing toolbar handlers + history.
   ───────────────────────────────────────────────────────── */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
    Heading1,
    Heading2,
    Heading3,
    List,
    ListOrdered,
    CheckSquare,
    Quote,
    Code2,
    Minus,
    Image as ImageIcon,
    Type,
    Info,
    Lightbulb,
    AlertTriangle,
    Sparkles,
    Clock,
    Table2,
    ChevronRight,
    Sigma,
    GitBranch,
    Link2,
    ListTree,
    CalendarDays,
    Mic,
} from 'lucide-react';
import { CODE_LANGUAGES } from '../quillConfig';
import { extractHeadings } from '../notesUtils';
import s from './SlashMenu.module.css';

/* ──────────────────────────────────────────────────────────
   Command registry. Each command:
     id     – unique key
     label  – displayed in the menu
     hint   – optional short subtitle
     icon   – lucide component
     keys   – search aliases
     run(q) – function that mutates the Quill editor `q`.
              `q.__slashRange` (provided by SlashMenu) gives
              the original "/" trigger range so commands can
              clear the typed query before inserting.
   ────────────────────────────────────────────────────────── */
function makeCommands(opts = {}) {
    const { onPickPageLink, onInsertToc } = opts;
    const blockFormat = (format, value = true) => (q) => {
        const range = q.getSelection(true);
        q.formatLine(range.index, 1, format, value, 'user');
    };

    const insertEmbed = (kind, value = true) => (q) => {
        const range = q.getSelection(true);
        q.insertEmbed(range.index, kind, value, 'user');
        q.setSelection(range.index + 1, 'silent');
    };

    return [
        {
            id: 'h1', label: 'Heading 1', hint: 'Large section title',
            icon: Heading1, keys: ['h1', 'heading1', 'title'],
            run: (q) => blockFormat('header', 1)(q),
        },
        {
            id: 'h2', label: 'Heading 2', hint: 'Medium section title',
            icon: Heading2, keys: ['h2', 'heading2', 'subtitle'],
            run: (q) => blockFormat('header', 2)(q),
        },
        {
            id: 'h3', label: 'Heading 3', hint: 'Small section title',
            icon: Heading3, keys: ['h3', 'heading3'],
            run: (q) => blockFormat('header', 3)(q),
        },
        {
            id: 'p', label: 'Text', hint: 'Plain paragraph',
            icon: Type, keys: ['p', 'paragraph', 'text'],
            run: (q) => blockFormat('header', false)(q),
        },
        {
            id: 'ul', label: 'Bulleted list', hint: 'Simple bullet list',
            icon: List, keys: ['ul', 'bullet', 'unordered'],
            run: (q) => blockFormat('list', 'bullet')(q),
        },
        {
            id: 'ol', label: 'Numbered list', hint: 'Ordered list',
            icon: ListOrdered, keys: ['ol', 'numbered', 'ordered'],
            run: (q) => blockFormat('list', 'ordered')(q),
        },
        {
            id: 'todo', label: 'To-do list', hint: 'Checkbox list',
            icon: CheckSquare, keys: ['todo', 'check', 'task', 'checkbox'],
            // Quill 2 (react-quill-new) uses 'unchecked' / 'checked' as the
            // list-format values for checkbox items — *not* 'check'.
            run: (q) => blockFormat('list', 'unchecked')(q),
        },
        {
            id: 'quote', label: 'Quote', hint: 'Blockquote',
            icon: Quote, keys: ['quote', 'blockquote'],
            run: (q) => blockFormat('blockquote', true)(q),
        },
        {
            id: 'code', label: 'Code block', hint: 'Monospace block (auto-detect)',
            icon: Code2, keys: ['code', 'codeblock', 'pre'],
            run: (q) => blockFormat('code-block', true)(q),
        },
        /* Language-specific code blocks */
        ...CODE_LANGUAGES.map(lang => ({
            id: `code-${lang.id}`,
            label: `Code · ${lang.label}`,
            hint: `${lang.label} code block`,
            icon: Code2,
            keys: ['code', lang.id, lang.label.toLowerCase()],
            run: (q) => blockFormat('code-block', lang.id)(q),
        })),
        {
            id: 'callout-info', label: 'Callout · Info', hint: 'Highlighted info card',
            icon: Info, keys: ['callout', 'info', 'note'],
            run: (q) => blockFormat('callout', 'info')(q),
        },
        {
            id: 'callout-tip', label: 'Callout · Tip', hint: 'Helpful tip',
            icon: Lightbulb, keys: ['callout', 'tip', 'hint'],
            run: (q) => blockFormat('callout', 'tip')(q),
        },
        {
            id: 'callout-warn', label: 'Callout · Warning', hint: 'Warning card',
            icon: AlertTriangle, keys: ['callout', 'warn', 'warning', 'caution'],
            run: (q) => blockFormat('callout', 'warn')(q),
        },
        {
            id: 'callout-success', label: 'Callout · Success', hint: 'Positive callout',
            icon: Sparkles, keys: ['callout', 'success', 'done'],
            run: (q) => blockFormat('callout', 'success')(q),
        },
        {
            id: 'divider', label: 'Divider', hint: 'Horizontal rule',
            icon: Minus, keys: ['divider', 'hr', 'rule', 'separator'],
            run: insertEmbed('divider'),
        },
        {
            id: 'timestamp', label: 'Timestamp', hint: 'Insert current date and time',
            icon: Clock, keys: ['timestamp', 'date', 'time', 'now'],
            run: (q) => {
                const range = q.getSelection(true);
                const str = new Date().toLocaleString(undefined, {
                    year: 'numeric', month: 'short', day: 'numeric',
                    hour: '2-digit', minute: '2-digit',
                });
                q.insertText(range.index, str, 'user');
                q.setSelection(range.index + str.length, 'silent');
            },
        },
        {
            id: 'today', label: 'Today', hint: 'Insert today\'s date as a chip',
            icon: CalendarDays, keys: ['today', 'date', 'now'],
            run: (q) => {
                const range = q.getSelection(true);
                const d = new Date();
                const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                q.insertText(range.index, ' ', 'user');
                q.formatText(range.index, 1, 'datechip', iso, 'user');
                q.insertText(range.index + 1, ' ', 'user');
                q.setSelection(range.index + 2, 'silent');
            },
        },
        {
            id: 'table', label: 'Table', hint: 'Insert a 3×3 editable table',
            icon: Table2, keys: ['table', 'grid', 'rows'],
            run: insertEmbed('simpletable', { rows: 3, cols: 3 }),
        },
        {
            id: 'toggle', label: 'Toggle', hint: 'Collapsible block',
            icon: ChevronRight, keys: ['toggle', 'collapse', 'collapsible', 'details'],
            run: (q) => {
                const range = q.getSelection(true);
                q.formatLine(range.index, 1, 'toggle', true, 'user');
            },
        },
        {
            id: 'math', label: 'Math (LaTeX)', hint: 'Inline LaTeX expression',
            icon: Sigma, keys: ['math', 'latex', 'tex', 'equation', 'formula'],
            run: (q) => {
                const range = q.getSelection(true);
                const tex = (typeof window !== 'undefined' ? window.prompt('LaTeX expression:', 'E = mc^2') : 'E = mc^2');
                if (tex == null) return;
                q.insertEmbed(range.index, 'math', tex, 'user');
                q.setSelection(range.index + 1, 'silent');
            },
        },
        {
            id: 'drawio', label: 'Draw.io diagram', hint: 'Flowcharts, sequence, ER, and more',
            icon: GitBranch, keys: ['drawio', 'diagram', 'flowchart', 'graph', 'mermaid', 'mxgraph'],
            run: (q) => {
                const range = q.getSelection(true);
                q.insertEmbed(range.index, 'drawio', { xml: '', svg: '' }, 'user');
                q.setSelection(range.index + 1, 'silent');
                // Open the editor immediately so the user can start drawing.
                setTimeout(() => {
                    const root = q.root;
                    const blocks = root?.querySelectorAll('.ql-drawio') || [];
                    const node = blocks[blocks.length - 1];
                    if (node) {
                        node.dispatchEvent(new CustomEvent('notes:drawio-edit', {
                            bubbles: true,
                            detail: { node },
                        }));
                    }
                }, 50);
            },
        },
        {
            id: 'pagelink', label: 'Link to page', hint: 'Insert link to another note',
            icon: Link2, keys: ['link', 'page', 'pagelink', 'wiki'],
            run: (q) => {
                if (typeof onPickPageLink === 'function') {
                    const range = q.getSelection(true);
                    onPickPageLink(q, range);
                } else {
                    const range = q.getSelection(true);
                    q.insertText(range.index, '[[]]', 'user');
                    q.setSelection(range.index + 2, 'silent');
                }
            },
        },
        {
            id: 'toc', label: 'Table of contents', hint: 'Auto-generate from headings',
            icon: ListTree, keys: ['toc', 'contents', 'outline'],
            run: (q) => {
                if (typeof onInsertToc === 'function') {
                    onInsertToc(q);
                    return;
                }
                // Fallback: read current editor headings and insert a bullet list
                const html = q.root?.innerHTML || '';
                const headings = extractHeadings(html);
                if (headings.length === 0) {
                    if (typeof window !== 'undefined') window.alert('Add some headings (H1/H2/H3) first.');
                    return;
                }
                const range = q.getSelection(true);
                let text = '';
                headings.forEach(h => { text += `${'  '.repeat(h.level - 1)}• ${h.text}\n`; });
                q.insertText(range.index, '\n— Table of contents —\n' + text + '\n', 'user');
            },
        },
        {
            id: 'record', label: 'Record audio', hint: 'Capture a voice note',
            icon: Mic, keys: ['record', 'audio', 'voice', 'mic', 'recording'],
            run: (q) => {
                const range = q.getSelection(true);
                if (typeof document !== 'undefined') {
                    document.dispatchEvent(new CustomEvent('notes:open-audio-recorder', {
                        detail: { quill: q, range },
                    }));
                }
            },
        },
        {
            id: 'image', label: 'Image', hint: 'Pick an image to upload',
            icon: ImageIcon, keys: ['image', 'img', 'picture', 'photo'],
            run: (q) => {
                const tb = q.getModule('toolbar');
                if (tb && tb.handlers && tb.handlers.image) {
                    tb.handlers.image.call({ quill: q });
                } else {
                    // Fallback: trigger a hidden file input
                    const input = document.createElement('input');
                    input.type = 'file';
                    input.accept = 'image/*';
                    input.onchange = () => {
                        const file = input.files?.[0];
                        if (!file) return;
                        const reader = new FileReader();
                        reader.onload = () => {
                            const range = q.getSelection(true);
                            q.insertEmbed(range.index, 'image', reader.result, 'user');
                            q.setSelection(range.index + 1, 'silent');
                        };
                        reader.readAsDataURL(file);
                    };
                    input.click();
                }
            },
        },
    ];
}

/* ──────────────────────────────────────────────────────────
   Hook + component
   ────────────────────────────────────────────────────────── */
export default function SlashMenu({ quillRef, pageId, resetKey, onPickPageLink, onInsertToc }) {
    const COMMANDS = useMemo(
        () => makeCommands({ onPickPageLink, onInsertToc }),
        [onPickPageLink, onInsertToc]
    );

    /* Combined state — render only when we have a position so the
       menu never flashes at (0, 0) during the first paint. */
    const [state, setState] = useState({ open: false, pos: null });
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(0);
    const open = state.open;
    const pos = state.pos;

    // Where the trigger '/' was inserted, plus how many query chars exist now.
    const triggerRef = useRef(null); // { index: number }
    const containerRef = useRef(null);

    /* ── Filter commands by typed query ───────────────────── */
    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return COMMANDS;
        return COMMANDS.filter(c =>
            c.label.toLowerCase().includes(q) ||
            c.keys.some(k => k.startsWith(q) || k.includes(q))
        );
    }, [COMMANDS, query]);

    /* Reset highlight whenever the filtered list shrinks or the menu reopens */
    useEffect(() => { setActive(0); }, [query, open]);

    /* ── Helpers to compute the menu position relative to the editor ── */
    const computePos = (q, idx) => {
        try {
            const bounds = q.getBounds(idx);
            const root = q.root; // .ql-editor
            const editorRect = root.getBoundingClientRect();
            // Anchor in viewport coordinates so we can use position: fixed.
            const top = editorRect.top + bounds.bottom + 6;
            const left = editorRect.left + bounds.left;
            const maxLeft = window.innerWidth - 320;
            return {
                top: Math.min(top, window.innerHeight - 360),
                left: Math.max(8, Math.min(left, maxLeft)),
            };
        } catch {
            return null;
        }
    };
    const repositionFor = (q, idx) => {
        const pos = computePos(q, idx);
        if (pos) setState(s => (s.open ? { open: true, pos } : s));
    };

    const closeMenu = () => {
        setState({ open: false, pos: null });
        setQuery('');
        triggerRef.current = null;
    };

    const runCommand = (cmd) => {
        const q = quillRef?.current?.getEditor ? quillRef.current.getEditor() : quillRef?.current;
        if (!q || !cmd) return closeMenu();

        const trig = triggerRef.current;
        if (trig) {
            // Delete the "/" + typed query so the slash command leaves no trace.
            const len = 1 + query.length;
            q.deleteText(trig.index, len, 'user');
            q.setSelection(trig.index, 'silent');
        }

        try { cmd.run(q); }
        finally { closeMenu(); }
    };

    /* ── Subscribe to Quill text-change to detect "/" trigger ──
       We parse the delta directly rather than reading getSelection(),
       because during text-change the selection isn't always updated
       to the post-insertion caret yet — that caused a one-keystroke
       delay before the menu would open. */
    useEffect(() => {
        const q = quillRef?.current?.getEditor ? quillRef.current.getEditor() : quillRef?.current;
        if (!q || typeof q.on !== 'function') return;

        /* Pull the first insert (and its position) out of a delta. */
        const firstInsert = (delta) => {
            let pos = 0;
            for (const op of (delta?.ops || [])) {
                if (typeof op.retain === 'number') pos += op.retain;
                else if (typeof op.delete === 'number') return null; // deletion → not an insert
                else if (typeof op.insert === 'string') return { pos, text: op.insert };
                else if (op.insert) return null; // embed
            }
            return null;
        };

        const onChange = (delta, _old, source) => {
            if (source !== 'user') return;

            // ── Menu already open → keep the query in sync ──────────
            if (triggerRef.current) {
                const trig = triggerRef.current;
                const sel = q.getSelection();
                if (!sel || sel.index < trig.index + 1) {
                    closeMenu();
                    return;
                }
                const typed = q.getText(trig.index + 1, sel.index - trig.index - 1);
                if (typed.includes('\n') || typed.includes(' ')) {
                    closeMenu();
                    return;
                }
                setQuery(typed);
                repositionFor(q, trig.index);
                return;
            }

            // ── Detect a fresh "/" insertion from the delta itself ──
            const ins = firstInsert(delta);
            if (!ins || !ins.text.includes('/')) return;

            // Find where the "/" sits inside the inserted run (usually the
            // end — typing always inserts a single char).
            const slashOffset = ins.text.lastIndexOf('/');
            const slashIndex = ins.pos + slashOffset;

            // Require the slash to be at line-start or preceded by whitespace.
            const prev = slashIndex >= 1 ? q.getText(slashIndex - 1, 1) : '\n';
            if (prev && !/\s/.test(prev) && prev !== '\n') return;

            triggerRef.current = { index: slashIndex };
            // Compute position synchronously so the very first paint is
            // already at the right coordinates.
            const pos = computePos(q, slashIndex);
            setQuery('');
            setState({ open: true, pos: pos || { top: 0, left: 0 } });
        };

        q.on('text-change', onChange);
        return () => { q.off('text-change', onChange); };
        // Re-bind when ReactQuill remounts (page change / snapshot restore)
        // — quillRef.current points to a brand-new editor instance then.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [quillRef, pageId, resetKey]);

    /* ── Reposition on resize/scroll while open ──────────── */
    useEffect(() => {
        if (!open) return;
        const handler = () => {
            const q = quillRef?.current?.getEditor ? quillRef.current.getEditor() : quillRef?.current;
            if (q && triggerRef.current) repositionFor(q, triggerRef.current.index);
        };
        window.addEventListener('resize', handler);
        window.addEventListener('scroll', handler, true);
        return () => {
            window.removeEventListener('resize', handler);
            window.removeEventListener('scroll', handler, true);
        };
    }, [open, quillRef]);

    /* ── Keyboard handling: ↑/↓/Enter/Esc ────────────────── */
    useEffect(() => {
        if (!open) return;
        const onKey = (e) => {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive(i => Math.min(i + 1, Math.max(filtered.length - 1, 0)));
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive(i => Math.max(i - 1, 0));
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const cmd = filtered[active];
                if (cmd) runCommand(cmd);
            } else if (e.key === 'Escape' || e.key === 'Tab') {
                e.preventDefault();
                closeMenu();
            }
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, filtered, active]);

    /* ── Click outside closes ────────────────────────────── */
    useEffect(() => {
        if (!open) return;
        const onClick = (e) => {
            if (containerRef.current && !containerRef.current.contains(e.target)) {
                closeMenu();
            }
        };
        document.addEventListener('mousedown', onClick);
        return () => document.removeEventListener('mousedown', onClick);
    }, [open]);

    if (!open || !pos) return null;
    if (filtered.length === 0) {
        return (
            <div
                ref={containerRef}
                className={s.menu}
                style={{ top: pos.top, left: pos.left }}
                role="menu"
            >
                <div className={s.empty}>No commands match "{query}"</div>
            </div>
        );
    }

    return (
        <div
            ref={containerRef}
            className={s.menu}
            style={{ top: pos.top, left: pos.left }}
            role="menu"
        >
            <div className={s.header}>
                <span className={s.headerLabel}>Insert block</span>
                {query && <span className={s.headerQuery}>"{query}"</span>}
            </div>
            <div className={s.list} role="listbox">
                {filtered.map((cmd, idx) => {
                    const Icon = cmd.icon;
                    return (
                        <button
                            type="button"
                            key={cmd.id}
                            className={`${s.row} ${idx === active ? s.rowActive : ''}`}
                            onMouseEnter={() => setActive(idx)}
                            onMouseDown={(e) => { e.preventDefault(); runCommand(cmd); }}
                            role="option"
                            aria-selected={idx === active}
                        >
                            <span className={s.rowIcon}>
                                {Icon ? <Icon size={16} /> : null}
                            </span>
                            <span className={s.rowText}>
                                <span className={s.rowLabel}>{cmd.label}</span>
                                {cmd.hint && <span className={s.rowHint}>{cmd.hint}</span>}
                            </span>
                        </button>
                    );
                })}
            </div>
            <div className={s.footer}>
                <kbd>↑</kbd><kbd>↓</kbd> navigate
                <span className={s.footerSep}>·</span>
                <kbd>↵</kbd> select
                <span className={s.footerSep}>·</span>
                <kbd>Esc</kbd> close
            </div>
        </div>
    );
}