/* ─────────────────────────────────────────────────────────
   notesAi — local-only "intelligence" helpers for the Notes
   feature. NO network calls, NO LLM dependency.

   Why local-only? WorkPulse may or may not have an LLM
   provider configured. These helpers give the AI assist UI a
   useful baseline that works offline, in tests, and for
   self-hosted deployments. If/when a server-side LLM endpoint
   is added, the panel can fall back to these heuristics when
   the call fails.

   Provides:
     • summarise(html, maxSentences) — extractive summary
     • extractActionItems(html)       — find todo / "TODO:" lines
     • outline(html)                  — heading hierarchy
     • findRelatedPages(page, all)    — token-overlap similarity
     • findStalePages(pages, days)    — pages not edited in N days
     • generateActivityFeed(pages, h) — chronological recent edits
     • improveWriting(text)           — light style cleanup
   ───────────────────────────────────────────────────────── */
import { stripHtml } from './notesUtils';

/* ── Stop-words (small, deliberately English-only) ─────── */
const STOP_WORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'if', 'so', 'of', 'in', 'on', 'at',
    'to', 'for', 'with', 'by', 'as', 'is', 'are', 'was', 'were', 'be', 'been',
    'being', 'this', 'that', 'these', 'those', 'it', 'its', 'we', 'you', 'they',
    'i', 'me', 'my', 'our', 'your', 'their', 'them', 'us', 'he', 'she', 'his',
    'her', 'him', 'will', 'would', 'should', 'can', 'could', 'may', 'might',
    'must', 'have', 'has', 'had', 'do', 'does', 'did', 'not', 'no', 'yes',
    'than', 'then', 'there', 'here', 'about', 'into', 'from', 'up', 'down',
    'out', 'over', 'under', 'just', 'also', 'very', 'much', 'many', 'most',
    'some', 'any', 'all', 'each', 'other', 'such', 'so', 'too', 'one', 'two',
    'new', 'old', 'use', 'used', 'using', 'get', 'got', 'make', 'made',
]);

/* ── Tokenisation ───────────────────────────────────────── */
function tokenize(text) {
    return (text || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 3 && !STOP_WORDS.has(w));
}

/* Sentence splitter — naive but works for typical prose. */
function splitSentences(text) {
    return (text || '')
        .replace(/\s+/g, ' ')
        .split(/(?<=[.!?])\s+(?=[A-Z(])/)
        .map(s => s.trim())
        .filter(s => s.length > 12);
}

/* ── Extractive summary (term-frequency scoring) ────────── */
export function summarise(html, maxSentences = 3) {
    const text = stripHtml(html || '').trim();
    if (!text) return '';
    const sentences = splitSentences(text);
    if (sentences.length <= maxSentences) return sentences.join(' ');

    // Score each sentence by sum of term-frequencies of its non-stop tokens.
    const tf = {};
    sentences.forEach(s => tokenize(s).forEach(w => { tf[w] = (tf[w] || 0) + 1; }));
    const scored = sentences.map((s, idx) => {
        const words = tokenize(s);
        if (words.length === 0) return { idx, s, score: 0 };
        const score = words.reduce((a, w) => a + (tf[w] || 0), 0) / words.length;
        // Slight bonus for early sentences (often topic sentences).
        const positional = 1 + Math.max(0, 0.3 - idx * 0.02);
        return { idx, s, score: score * positional };
    });
    const top = scored.sort((a, b) => b.score - a.score).slice(0, maxSentences)
        .sort((a, b) => a.idx - b.idx)
        .map(x => x.s);
    return top.join(' ');
}

/* ── Action-item extraction ──────────────────────────────
   Pulls out:
     • Quill todo items: <li data-list="unchecked|checked">
     • Markdown-style "- [ ]" / "- [x]" lines (in case of imports)
     • Lines that start with "TODO:", "Action:", "Action item:" */
export function extractActionItems(html) {
    if (!html) return [];
    const out = [];
    const seen = new Set();
    const push = (text, done = false) => {
        const t = (text || '').trim();
        if (!t || seen.has(t.toLowerCase())) return;
        seen.add(t.toLowerCase());
        out.push({ text: t, done });
    };

    // 1) Parse DOM for Quill checkbox items
    try {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        doc.querySelectorAll('li[data-list="unchecked"]').forEach(li =>
            push(li.textContent || '', false),
        );
        doc.querySelectorAll('li[data-list="checked"]').forEach(li =>
            push(li.textContent || '', true),
        );
        doc.querySelectorAll('ul[data-checked="false"] > li').forEach(li =>
            push(li.textContent || '', false),
        );
        doc.querySelectorAll('ul[data-checked="true"] > li').forEach(li =>
            push(li.textContent || '', true),
        );
    } catch { /* ignore DOM parse errors */ }

    // 2) Scan plain text for explicit markers
    const text = stripHtml(html);
    text.split(/\r?\n/).forEach(line => {
        const todo = line.match(/^\s*(?:[-*]\s*)?\[(\s|x|X)\]\s*(.+)$/);
        if (todo) {
            push(todo[2], todo[1].toLowerCase() === 'x');
            return;
        }
        const m = line.match(/^\s*(?:TODO|FIXME|ACTION|ACTION ITEM)\s*:\s*(.+)$/i);
        if (m) push(m[1], false);
    });

    return out;
}

/* ── Outline: heading hierarchy with depth ─────────────── */
export function outline(html) {
    if (!html) return [];
    try {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        return Array.from(doc.querySelectorAll('h1, h2, h3, h4'))
            .map((n, i) => ({
                id: `outline-${i}`,
                level: parseInt(n.tagName.substring(1), 10),
                text: (n.textContent || '').trim(),
            }))
            .filter(h => h.text);
    } catch { return []; }
}

/* ── Related-pages similarity ────────────────────────────
   Uses Jaccard similarity over tokenised content + tags + title.
   Cheap, no embeddings, surprisingly useful. */
function pageTokens(page) {
    const titleTokens = tokenize(page.title || '');
    const bodyTokens = tokenize(stripHtml(page.content || ''));
    const tagTokens = (page.tags || []).flatMap(t => tokenize(String(t)));
    return new Set([...titleTokens, ...bodyTokens, ...tagTokens]);
}

function jaccard(a, b) {
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    const small = a.size < b.size ? a : b;
    const big = small === a ? b : a;
    small.forEach(w => { if (big.has(w)) inter++; });
    return inter / (a.size + b.size - inter);
}

export function findRelatedPages(page, allPages, limit = 5) {
    if (!page || !Array.isArray(allPages)) return [];
    const target = pageTokens(page);
    if (target.size === 0) return [];
    return allPages
        .filter(p => p.id !== page.id && !p.archived)
        .map(p => ({ page: p, score: jaccard(target, pageTokens(p)) }))
        .filter(x => x.score >= 0.05)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
}

/* ── Stale pages — not edited in N days ────────────────── */
export function findStalePages(pages, days = 30, limit = 10) {
    if (!Array.isArray(pages)) return [];
    const cutoff = Date.now() - days * 86400000;
    return pages
        .filter(p => !p.archived && p.updatedAt && new Date(p.updatedAt).getTime() < cutoff)
        .sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt))
        .slice(0, limit);
}

/* ── Activity feed — chronological recent edits ─────────
   Bucket pages by day, return the most recent N buckets. */
export function generateActivityFeed(pages, days = 14) {
    if (!Array.isArray(pages)) return [];
    const cutoff = Date.now() - days * 86400000;
    const items = pages
        .filter(p => p.updatedAt && new Date(p.updatedAt).getTime() >= cutoff)
        .map(p => ({
            id: p.id,
            title: p.title || 'Untitled',
            updatedAt: p.updatedAt,
            createdAt: p.createdAt,
            isNew: p.createdAt && new Date(p.createdAt).getTime() >= cutoff,
        }))
        .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

    // Group by ISO date
    const byDay = new Map();
    items.forEach(it => {
        const day = new Date(it.updatedAt).toISOString().slice(0, 10);
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(it);
    });
    return Array.from(byDay.entries()).map(([day, list]) => ({ day, items: list }));
}

/* ── "Improve writing" — light style polish ──────────────
   Heuristic-only: collapses double spaces, fixes obvious
   capitalisation, replaces common contractions to avoid awkward
   grammar in formal notes. Returns the cleaned plain text. */
export function improveWriting(text) {
    if (!text) return '';
    let s = text
        .replace(/\s+/g, ' ')
        .replace(/\s+([,.;:!?])/g, '$1')
        .replace(/([,.;:!?])(?=\S)/g, '$1 ')
        .replace(/\bi\b/g, 'I')
        .replace(/\bdont\b/gi, "don't")
        .replace(/\bcant\b/gi, "can't")
        .replace(/\bwont\b/gi, "won't")
        .replace(/\bim\b/gi, "I'm")
        .replace(/\bive\b/gi, "I've")
        .replace(/\b(very|really|just|actually|basically|simply)\s+/gi, '');
    // Capitalise first character of each sentence
    s = s.replace(/(^|[.!?]\s+)([a-z])/g, (_m, p, c) => p + c.toUpperCase());
    return s.trim();
}