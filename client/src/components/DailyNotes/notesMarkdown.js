/* ─────────────────────────────────────────────────────────
   notesMarkdown — minimal, dependency-free Markdown converters.

   Two directions:
     • htmlToMarkdown(html)  — Quill HTML → CommonMark-flavoured MD
     • markdownToHtml(md)    — Markdown → HTML compatible with Quill

   These cover the elements WorkPulse Notes actually uses:
     headings (h1-h3), paragraphs, bold/italic/underline/strike,
     inline code, links, images, blockquote, ordered / bulleted /
     todo lists, code blocks (with language), horizontal rules,
     and tables. Custom blots (callout, datechip, math, mermaid,
     drawio, page-link) are converted to a sensible Markdown
     fallback so the export remains useful even if not reversible.

   Implemented in pure JS so no new npm dependency is required.
   ───────────────────────────────────────────────────────── */

/* ══════════════════════════ HTML → MARKDOWN ══════════════════════════ */

/* Decode the most common HTML entities (we only care about a small set
   because the input comes from Quill which is well-behaved). */
function decodeEntities(s) {
    if (!s) return '';
    return s
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
}

/* Escape characters that have meaning in Markdown when they appear
   inside plain text. Keep this deliberately conservative — overzealous
   escaping makes exports ugly. */
function escapeMd(text) {
    return (text || '').replace(/([\\`*_{}\[\]()#+\-!])/g, '\\$1');
}

/* Recursively serialise a DOM node into Markdown. */
function nodeToMd(node, ctx = {}) {
    if (!node) return '';
    if (node.nodeType === 3) {
        // Text node — collapse whitespace runs (but preserve a single space).
        const t = node.nodeValue.replace(/\s+/g, ' ');
        return ctx.inPre ? node.nodeValue : (ctx.raw ? t : escapeMd(t));
    }
    if (node.nodeType !== 1) return '';

    const tag = node.tagName.toLowerCase();

    // Custom blots first (they would otherwise be unwrapped to plain text)
    if (node.classList?.contains('ql-pagelink')) {
        const title = node.getAttribute('data-page-title') || node.textContent || 'page';
        const id = node.getAttribute('data-page-id') || '';
        return `[[${title}${id ? `|${id}` : ''}]]`;
    }
    if (node.classList?.contains('ql-datechip')) {
        const d = node.getAttribute('data-date') || node.textContent || '';
        return ` 📅 ${d} `;
    }
    if (node.classList?.contains('ql-math')) {
        const tex = node.getAttribute('data-tex') || '';
        return tex ? `\n\n$$${tex}$$\n\n` : '';
    }
    if (node.classList?.contains('ql-drawio')) {
        const appName = ctx.appName || 'WorkPulse';
        return `\n\n_[Diagram — open in ${appName} to view]_\n\n`;
    }
    if (node.classList?.contains('ql-callout')) {
        const variant = node.getAttribute('data-callout') || 'info';
        const inner = childrenToMd(node, ctx).trim();
        const sigil = variant === 'warn' ? '⚠️' : variant === 'tip' ? '💡' : variant === 'success' ? '✅' : 'ℹ️';
        return `\n> ${sigil} ${inner.replace(/\n/g, '\n> ')}\n\n`;
    }
    if (node.classList?.contains('ql-toggle')) {
        const inner = childrenToMd(node, ctx).trim();
        return `\n<details><summary>${inner.split('\n')[0] || 'Details'}</summary>\n\n${inner.split('\n').slice(1).join('\n')}\n\n</details>\n`;
    }
    if (node.classList?.contains('ql-simpletable')) {
        return tableToMd(node);
    }
    if (node.classList?.contains('ql-audio')) {
        const appName = ctx.appName || 'WorkPulse';
        return `\n\n_[Audio recording — open in ${appName} to play]_\n\n`;
    }

    switch (tag) {
        case 'h1': return `\n\n# ${childrenToMd(node, ctx).trim()}\n\n`;
        case 'h2': return `\n\n## ${childrenToMd(node, ctx).trim()}\n\n`;
        case 'h3': return `\n\n### ${childrenToMd(node, ctx).trim()}\n\n`;
        case 'h4': return `\n\n#### ${childrenToMd(node, ctx).trim()}\n\n`;
        case 'h5': return `\n\n##### ${childrenToMd(node, ctx).trim()}\n\n`;
        case 'h6': return `\n\n###### ${childrenToMd(node, ctx).trim()}\n\n`;

        case 'br': return ctx.inList ? ' ' : '  \n';
        case 'hr': return `\n\n---\n\n`;

        case 'strong':
        case 'b': return `**${childrenToMd(node, ctx)}**`;
        case 'em':
        case 'i': return `*${childrenToMd(node, ctx)}*`;
        case 'u': return `<u>${childrenToMd(node, ctx)}</u>`;
        case 's':
        case 'strike':
        case 'del': return `~~${childrenToMd(node, ctx)}~~`;
        case 'code': return ctx.inPre ? node.textContent : `\`${node.textContent}\``;

        case 'a': {
            const href = node.getAttribute('href') || '';
            const text = childrenToMd(node, ctx) || href;
            return href ? `[${text}](${href})` : text;
        }
        case 'img': {
            const src = node.getAttribute('src') || '';
            const alt = node.getAttribute('alt') || '';
            // Strip giant base64 data URLs from MD output — keep a placeholder
            const safeSrc = src.startsWith('data:') ? '(embedded image)' : src;
            return src ? `\n\n![${alt}](${safeSrc})\n\n` : '';
        }

        case 'p': {
            const inner = childrenToMd(node, ctx).trim();
            return inner ? `\n\n${inner}\n\n` : '\n';
        }

        case 'blockquote': {
            const inner = childrenToMd(node, ctx).trim();
            return `\n\n${inner.split('\n').map(l => `> ${l}`).join('\n')}\n\n`;
        }

        case 'pre': {
            // Quill emits <pre class="ql-syntax" spellcheck="false">…</pre>
            // and <pre class="ql-code-block-container"><div class="ql-code-block" data-language="js">…
            const lang = node.getAttribute('data-language')
                || node.querySelector?.('[data-language]')?.getAttribute('data-language')
                || '';
            const text = node.textContent.replace(/\n+$/, '');
            return `\n\n\`\`\`${lang}\n${text}\n\`\`\`\n\n`;
        }

        case 'ul': {
            const checked = node.getAttribute('data-checked');
            // Quill 2 emits checkbox lists either as <ul data-checked="true|false">
            // or as <ol> with <li data-list="checked|unchecked">. Handle both.
            return `\n${listToMd(node, false, checked != null)}\n`;
        }
        case 'ol': {
            // If any <li> has data-list=checked/unchecked, treat as todo list
            const isTodo = !!node.querySelector?.('li[data-list="checked"], li[data-list="unchecked"]');
            return `\n${listToMd(node, !isTodo, isTodo)}\n`;
        }

        case 'table': return tableToMd(node);
        case 'div':
        case 'span':
        default:
            return childrenToMd(node, ctx);
    }
}

function childrenToMd(node, ctx) {
    let out = '';
    node.childNodes.forEach(c => { out += nodeToMd(c, ctx); });
    return out;
}

function listToMd(listEl, ordered, asTodo) {
    let out = '';
    let idx = 1;
    Array.from(listEl.children).forEach(li => {
        if (li.tagName?.toLowerCase() !== 'li') return;
        const inner = childrenToMd(li, { inList: true }).trim().replace(/\n/g, ' ');
        let prefix;
        if (asTodo) {
            const status = li.getAttribute('data-list') === 'checked'
                || listEl.getAttribute('data-checked') === 'true'
                ? 'x' : ' ';
            prefix = `- [${status}]`;
        } else if (ordered) {
            prefix = `${idx++}.`;
        } else {
            prefix = `-`;
        }
        out += `${prefix} ${inner}\n`;
    });
    return out;
}

function tableToMd(root) {
    const table = root.tagName?.toLowerCase() === 'table' ? root : root.querySelector?.('table');
    if (!table) return '';
    const rows = Array.from(table.querySelectorAll('tr'));
    if (rows.length === 0) return '';
    const lines = [];
    rows.forEach((tr, i) => {
        const cells = Array.from(tr.children).map(td =>
            childrenToMd(td, {}).replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim() || ' ',
        );
        lines.push(`| ${cells.join(' | ')} |`);
        if (i === 0) {
            lines.push(`| ${cells.map(() => '---').join(' | ')} |`);
        }
    });
    return `\n\n${lines.join('\n')}\n\n`;
}

/** Public: convert a Quill HTML string to Markdown. */
export function htmlToMarkdown(html, appName) {
    if (!html) return '';
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
    const root = doc.body.firstElementChild;
    let md = childrenToMd(root, { appName });
    md = decodeEntities(md);
    // Collapse 3+ blank lines and trim
    md = md.replace(/\n{3,}/g, '\n\n').trim();
    return md + '\n';
}

/* ══════════════════════════ MARKDOWN → HTML ══════════════════════════ */

/* A pragmatic CommonMark subset. Supports headings, paragraphs, fenced
   code blocks, blockquotes, ordered/unordered/todo lists, hr, links,
   images, inline bold/italic/code, and `|`-tables. */

function escapeHtml(s) {
    return (s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function inlineMd(line) {
    if (!line) return '';
    let s = escapeHtml(line);
    // images
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, a, h) => `<img alt="${a}" src="${h}">`);
    // links
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, h) => `<a href="${h}">${t}</a>`);
    // bold (** **)
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // italic (* * or _ _)
    s = s.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/(^|\W)_([^_]+)_(?!\w)/g, '$1<em>$2</em>');
    // strikethrough
    s = s.replace(/~~([^~]+)~~/g, '<s>$1</s>');
    // inline code
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    // [[Page link]]
    s = s.replace(/\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/g,
        (_m, title, id) =>
            `<a class="ql-pagelink" data-page-id="${id || ''}" data-page-title="${title}" href="#" contenteditable="false">${title}</a>`);
    return s;
}

/** Public: convert Markdown text into Quill-compatible HTML. */
export function markdownToHtml(md) {
    if (!md) return '';
    const lines = md.replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let i = 0;

    const flushParagraph = (buf) => {
        const text = buf.join(' ').trim();
        if (text) out.push(`<p>${inlineMd(text)}</p>`);
    };

    while (i < lines.length) {
        const ln = lines[i];

        // Blank line
        if (/^\s*$/.test(ln)) { i++; continue; }

        // Fenced code block
        const fence = ln.match(/^```(\w+)?\s*$/);
        if (fence) {
            const lang = fence[1] || '';
            const body = [];
            i++;
            while (i < lines.length && !/^```\s*$/.test(lines[i])) {
                body.push(lines[i]); i++;
            }
            i++; // closing ```
            const escaped = escapeHtml(body.join('\n'));
            if (lang) {
                out.push(`<pre class="ql-syntax" data-language="${lang}" spellcheck="false">${escaped}</pre>`);
            } else {
                out.push(`<pre class="ql-syntax" spellcheck="false">${escaped}</pre>`);
            }
            continue;
        }

        // Heading
        const h = ln.match(/^(#{1,6})\s+(.*)$/);
        if (h) {
            const level = Math.min(h[1].length, 3);   // Quill toolbar exposes h1-h3
            out.push(`<h${level}>${inlineMd(h[2])}</h${level}>`);
            i++; continue;
        }

        // Horizontal rule
        if (/^\s*(?:---|\*\*\*|___)\s*$/.test(ln)) { out.push('<hr>'); i++; continue; }

        // Blockquote (consume contiguous quoted lines)
        if (/^>\s?/.test(ln)) {
            const quoted = [];
            while (i < lines.length && /^>\s?/.test(lines[i])) {
                quoted.push(lines[i].replace(/^>\s?/, '')); i++;
            }
            out.push(`<blockquote>${inlineMd(quoted.join(' '))}</blockquote>`);
            continue;
        }

        // Table (header row + separator)
        if (/\|/.test(ln) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
            const rows = [];
            while (i < lines.length && /\|/.test(lines[i]) && !/^```/.test(lines[i])) {
                rows.push(lines[i]); i++;
            }
            const sepIdx = 1;
            const dataRows = rows.filter((_, idx) => idx !== sepIdx);
            const headerRow = dataRows[0];
            const bodyRows = dataRows.slice(1);
            const renderRow = (r, tag) => {
                const cells = r.replace(/^\s*\||\|\s*$/g, '').split('|').map(c => c.trim());
                return '<tr>' + cells.map(c => `<${tag}>${inlineMd(c)}</${tag}>`).join('') + '</tr>';
            };
            let html = '<div class="ql-simpletable" contenteditable="true"><table>';
            if (headerRow) html += `<thead>${renderRow(headerRow, 'th')}</thead>`;
            // Only emit <tbody> when there are data rows; previously the closing
            // </tbody> was always emitted even with no body rows, producing
            // malformed HTML when a table had only a header.
            if (bodyRows.length > 0) {
                html += '<tbody>' + bodyRows.map(r => renderRow(r, 'td')).join('') + '</tbody>';
            }
            html += '</table></div>';
            out.push(html);
            continue;
        }

        // Lists
        const listMatch = ln.match(/^(\s*)(-|\*|\+|\d+\.)\s+(?:\[([ xX])\]\s+)?(.*)$/);
        if (listMatch) {
            const items = [];
            const isOrdered = /^\d+\./.test(listMatch[2]);
            let isTodo = !!listMatch[3];
            while (i < lines.length) {
                const m = lines[i].match(/^(\s*)(-|\*|\+|\d+\.)\s+(?:\[([ xX])\]\s+)?(.*)$/);
                if (!m) break;
                const checked = m[3] && m[3].toLowerCase() === 'x';
                const isItemOrdered = /^\d+\./.test(m[2]);
                if (isItemOrdered !== isOrdered) break;
                if (m[3]) isTodo = true;
                items.push({ text: m[4], checked, todo: !!m[3] });
                i++;
            }
            if (isTodo) {
                const lis = items.map(it =>
                    `<li data-list="${it.checked ? 'checked' : 'unchecked'}">${inlineMd(it.text)}</li>`,
                ).join('');
                out.push(`<ul>${lis}</ul>`);
            } else {
                const lis = items.map(it => `<li>${inlineMd(it.text)}</li>`).join('');
                out.push(isOrdered ? `<ol>${lis}</ol>` : `<ul>${lis}</ul>`);
            }
            continue;
        }

        // Paragraph (consume contiguous non-empty, non-special lines)
        const buf = [];
        while (i < lines.length
            && lines[i].trim()
            && !/^(#{1,6}\s+|>\s?|```|---|\*\*\*|___)/.test(lines[i])
            && !/^(\s*)(-|\*|\+|\d+\.)\s+/.test(lines[i])) {
            buf.push(lines[i]); i++;
        }
        flushParagraph(buf);
    }

    return out.join('\n');
}

/* ══════════════════════════ FILE-NAME ══════════════════════════ */

export function safeFileName(title) {
    return (title || 'untitled')
        .replace(/[\\/:*?"<>|]+/g, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120) || 'untitled';
}