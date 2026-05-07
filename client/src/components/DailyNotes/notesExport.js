/* ─────────────────────────────────────────────────────────
   notesExport — utilities for exporting Notes pages to PDF.
   Uses html2pdf.js (jsPDF + html2canvas under the hood) so
   the user gets a real downloadable .pdf file directly,
   without relying on the OS print dialog.
   ───────────────────────────────────────────────────────── */
import html2pdf from 'html2pdf.js';

/* ── File-name sanitization ─────────────────────────────── */
function safeFileName(title) {
    return (title || 'untitled')
        .replace(/[\\/:*?"<>|]+/g, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120) || 'untitled';
}

/* ── Print stylesheet for the rendered page ─────────────── */
const PDF_CSS = `
*,*::before,*::after { box-sizing: border-box; }
html,body { margin: 0; padding: 0; }
body {
  font: 13px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  color: #111; background: #fff;
  padding: 24px 28px;
}
h1.title { font-size: 1.85em; margin: 0 0 0.5em; letter-spacing: -0.01em;
  border-bottom: 1px solid #e5e7eb; padding-bottom: 0.45em; }
.meta { color: #6b7280; font-size: 0.78em; margin: -0.2em 0 1.2em; }
h1 { font-size: 1.5em; margin: 1em 0 0.4em; }
h2 { font-size: 1.25em; margin: 1em 0 0.4em; }
h3 { font-size: 1.05em; margin: 0.9em 0 0.4em; }
p { margin: 0 0 0.55em; }
ul,ol { padding-left: 1.4em; margin: 0 0 0.6em; }
li { margin-bottom: 0.15em; }
blockquote { border-left: 3px solid #cbd5e1; padding: 0.1em 0 0.1em 0.85em;
  color: #475569; margin: 0.6em 0; }
hr { border: none; border-top: 1px solid #e5e7eb; margin: 1.2em 0; }
pre {
  background: #f4f5f7; color: #1a1a2e; padding: 10px 12px; border-radius: 6px;
  overflow-x: hidden; white-space: pre-wrap; word-break: break-word;
  font: 0.82em/1.55 'JetBrains Mono', ui-monospace, monospace;
  border: 1px solid #e5e7eb;
  page-break-inside: avoid;
}
code { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.88em; }
img { max-width: 100%; height: auto; border-radius: 4px; }
a { color: #0ea5e9; text-decoration: underline; word-break: break-word; }
[data-callout] {
  position: relative; padding: 0.65em 0.85em 0.65em 2.4em; margin: 0.6em 0;
  border-radius: 8px; border: 1px solid #cbd5e1; background: #f8fafc;
  page-break-inside: avoid;
}
[data-callout]::before {
  position: absolute; left: 0.85em; top: 0.65em; font-size: 1em; line-height: 1.2;
  font-family: 'Apple Color Emoji', 'Segoe UI Emoji', sans-serif;
}
[data-callout="info"]::before { content: 'i'; font-weight: 700; color: #0ea5e9; }
[data-callout="tip"]::before { content: '✱'; color: #a855f7; }
[data-callout="warn"]::before { content: '!'; font-weight: 700; color: #f59e0b; }
[data-callout="success"]::before { content: '✓'; font-weight: 700; color: #22c55e; }
table { border-collapse: collapse; width: 100%; margin: 0.6em 0;
  page-break-inside: avoid; }
th, td { border: 1px solid #e5e7eb; padding: 4px 8px; text-align: left; }
th { background: #f9fafb; font-weight: 600; }

/* Quill checkbox lists in print */
ul[data-checked] { list-style: none; padding-left: 0; }
ul[data-checked] > li::before {
  content: '☐ '; margin-right: 4px;
  font-family: 'Apple Color Emoji', 'Segoe UI Emoji', sans-serif;
}
ul[data-checked="true"] > li::before { content: '☑ '; }
li[data-list="unchecked"] { list-style: none; }
li[data-list="checked"] { list-style: none; text-decoration: line-through; color: #6b7280; }
li[data-list="unchecked"]::before { content: '☐ '; margin-right: 4px; }
li[data-list="checked"]::before { content: '☑ '; margin-right: 4px; }
`;

/* ── Build the printable HTML document fragment ─────────── */
function buildPrintable(page) {
    const title = (page.title || 'Untitled').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    const meta = page.updatedAt
        ? `<div class="meta">Edited ${new Date(page.updatedAt).toLocaleString()}</div>`
        : '';
    const body = page.content || '<p><em>This page is empty.</em></p>';

    const wrap = document.createElement('div');
    wrap.style.position = 'fixed';
    wrap.style.left = '-99999px';
    wrap.style.top = '0';
    wrap.style.width = '760px';
    wrap.style.background = '#fff';
    wrap.innerHTML = `
        <style>${PDF_CSS}</style>
        <h1 class="title">${title}</h1>
        ${meta}
        ${body}
    `;
    return wrap;
}

/* ── Public API ───────────────────────────────────────────
   Save the active page directly as a .pdf file. Resolves
   when the file has been generated (the actual download is
   triggered by the browser as a Blob save). */
export async function savePageAsPdf(page) {
    if (!page) return;
    const node = buildPrintable(page);
    document.body.appendChild(node);
    try {
        const opts = {
            margin: [10, 12, 14, 12],
            filename: `${safeFileName(page.title)}.pdf`,
            image: { type: 'jpeg', quality: 0.95 },
            html2canvas: {
                scale: 2,
                useCORS: true,
                logging: false,
                backgroundColor: '#ffffff',
            },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
            pagebreak: { mode: ['avoid-all', 'css', 'legacy'] },
        };
        await html2pdf().set(opts).from(node).save();
    } finally {
        node.remove();
    }
}

/* Backwards-compatible alias used by the editor menu. */
export const downloadPdf = savePageAsPdf;