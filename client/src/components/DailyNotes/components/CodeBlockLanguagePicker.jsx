/* ─────────────────────────────────────────────────────────
   CodeBlockLanguagePicker — adds a small language label /
   picker button to every <pre.ql-syntax> block inside the
   editor. Clicking it opens a dropdown with the supported
   languages (CODE_LANGUAGES from quillConfig). Selecting one
   sets the corresponding `code-block` format value on that
   line so the syntax module re-highlights it.

   Implementation strategy:
   - Observe the .ql-editor with a MutationObserver to detect
     when code blocks are added / removed / re-rendered.
   - For each <pre> block we own, ensure a small `<button
     data-cb-lang>` exists inside (positioned absolutely via
     CSS) whose label reflects the current `class` (Quill puts
     `ql-syntax` and the lang class such as `language-python`
     directly on the <pre>).
   - Clicking opens a single shared dropdown anchored to the
     button. Choosing a language calls `quill.formatLine` on
     the start index of that <pre> with `code-block: <lang>`.
   ───────────────────────────────────────────────────────── */
import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { CODE_LANGUAGES } from '../quillConfig';
import s from './CodeBlockLanguagePicker.module.css';

const LANG_LABEL = Object.fromEntries(CODE_LANGUAGES.map(l => [l.id, l.label]));

function getEditor(ref) {
    const node = ref?.current;
    if (!node) return null;
    return typeof node.getEditor === 'function' ? node.getEditor() : node;
}

/* Read the language from a <pre> element. Quill's syntax module
   either sets `data-language` or a class like `language-python`. */
function readLang(pre) {
    if (!pre) return 'plaintext';
    const dl = pre.getAttribute('data-language');
    if (dl) return dl;
    const cls = pre.className || '';
    const match = cls.match(/language-([a-z0-9+-]+)/i);
    return match ? match[1] : 'plaintext';
}

export default function CodeBlockLanguagePicker({ quillRef, pageId, resetKey }) {
    const [picker, setPicker] = useState(null); // { pre, top, left }
    const containerRef = useRef(null);

    /* ── Set up button injection + observers ──────────────── */
    useEffect(() => {
        const quill = getEditor(quillRef);
        if (!quill) return;
        const editor = quill.root;
        if (!editor) return;

        const ensureBadge = (pre) => {
            if (pre.querySelector('[data-cb-lang]')) return;
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.setAttribute('data-cb-lang', '1');
            btn.className = s.langBadge;
            btn.contentEditable = 'false';
            btn.tabIndex = -1;
            const label = readLang(pre);
            btn.innerText = LANG_LABEL[label] || label;
            // Ensure pre is positioned so the badge can absolutely-position
            if (!pre.style.position) pre.style.position = 'relative';
            pre.appendChild(btn);
        };

        const refreshBadge = (pre) => {
            const btn = pre.querySelector('[data-cb-lang]');
            if (!btn) return;
            const label = readLang(pre);
            btn.innerText = LANG_LABEL[label] || label;
        };

        const scan = () => {
            editor.querySelectorAll('pre').forEach(pre => {
                ensureBadge(pre);
                refreshBadge(pre);
            });
        };
        scan();

        const observer = new MutationObserver(() => scan());
        observer.observe(editor, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'data-language'],
        });

        /* Click handler — delegate to capture the badge inside <pre>. */
        const onClick = (e) => {
            const btn = e.target.closest('[data-cb-lang]');
            if (!btn) return;
            const pre = btn.closest('pre');
            if (!pre) return;
            e.preventDefault();
            e.stopPropagation();
            const rect = btn.getBoundingClientRect();
            setPicker({
                pre,
                top: rect.bottom + 4,
                left: Math.max(8, rect.right - 220),
                current: readLang(pre),
            });
        };
        editor.addEventListener('click', onClick, true);

        return () => {
            observer.disconnect();
            editor.removeEventListener('click', onClick, true);
        };
    }, [quillRef, pageId, resetKey]);

    /* ── Close picker on outside click / scroll / resize / Esc ── */
    useEffect(() => {
        if (!picker) return;
        const onDocClick = (e) => {
            if (containerRef.current && !containerRef.current.contains(e.target)) {
                setPicker(null);
            }
        };
        const onKey = (e) => { if (e.key === 'Escape') setPicker(null); };
        const onScrollOrResize = () => setPicker(null);
        document.addEventListener('mousedown', onDocClick);
        document.addEventListener('keydown', onKey);
        window.addEventListener('resize', onScrollOrResize);
        window.addEventListener('scroll', onScrollOrResize, true);
        return () => {
            document.removeEventListener('mousedown', onDocClick);
            document.removeEventListener('keydown', onKey);
            window.removeEventListener('resize', onScrollOrResize);
            window.removeEventListener('scroll', onScrollOrResize, true);
        };
    }, [picker]);

    const setLanguage = (langId) => {
        const quill = getEditor(quillRef);
        if (!quill || !picker?.pre) return setPicker(null);
        try {
            // Find the Quill blot/index for this <pre> element.
            const Quill = quill.constructor;
            const blot = Quill.find(picker.pre);
            if (!blot) return setPicker(null);
            const index = quill.getIndex(blot);
            const length = blot.length();
            quill.formatLine(index, length || 1, 'code-block', langId, 'user');
        } catch {
            /* ignore */
        } finally {
            setPicker(null);
        }
    };

    if (!picker) return null;

    return (
        <div
            ref={containerRef}
            className={s.menu}
            style={{ top: picker.top, left: picker.left }}
            role="menu"
            aria-label="Code block language"
        >
            <div className={s.menuHead}>Language</div>
            <div className={s.menuList}>
                {CODE_LANGUAGES.map(l => (
                    <button
                        key={l.id}
                        type="button"
                        className={`${s.menuItem} ${l.id === picker.current ? s.menuItemActive : ''}`}
                        onMouseDown={(e) => { e.preventDefault(); setLanguage(l.id); }}
                    >
                        <span className={s.menuLabel}>{l.label}</span>
                        <span className={s.menuId}>{l.id}</span>
                    </button>
                ))}
            </div>
        </div>
    );
}