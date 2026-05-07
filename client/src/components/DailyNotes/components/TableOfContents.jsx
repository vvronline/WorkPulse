/* ─────────────────────────────────────────────────────────
   TableOfContents — auto-generated from H1/H2/H3 headings
   in the active page's HTML. Clicking a heading scrolls the
   editor to it.
   ───────────────────────────────────────────────────────── */
import React, { useMemo } from 'react';
import { ListTree } from '../../../constants/icons';
import { extractHeadings } from '../notesUtils';
import s from './TableOfContents.module.css';

export default function TableOfContents({ html, scrollContainerRef }) {
    const headings = useMemo(() => extractHeadings(html), [html]);
    if (headings.length < 2) return null;

    const onJump = (text) => {
        const root = scrollContainerRef?.current;
        if (!root) return;
        // Find heading by exact text match (good enough for in-page nav)
        const candidates = root.querySelectorAll('h1, h2, h3');
        for (const node of candidates) {
            if ((node.textContent || '').trim() === text) {
                node.scrollIntoView({ behavior: 'smooth', block: 'start' });
                node.classList.add('toc-flash');
                setTimeout(() => node.classList.remove('toc-flash'), 1500);
                return;
            }
        }
    };

    return (
        <aside className={s.toc} aria-label="Table of contents">
            <header className={s.header}>
                <ListTree size={12} aria-hidden="true" />
                <span>On this page</span>
            </header>
            <ul className={s.list}>
                {headings.map(h => (
                    <li
                        key={h.id}
                        className={`${s.item} ${s[`level${h.level}`]}`}
                    >
                        <button
                            type="button"
                            className={s.link}
                            onClick={() => onJump(h.text)}
                            title={h.text}
                        >{h.text}</button>
                    </li>
                ))}
            </ul>
        </aside>
    );
}