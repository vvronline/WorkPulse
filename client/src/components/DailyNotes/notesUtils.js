/* ─────────────────────────────────────────────────────────
   Pure utility helpers for the Notes feature.
   No React imports – fully tree‑shakeable.
   ───────────────────────────────────────────────────────── */

export const TAG_COLORS = [
  '#6366f1', '#ec4899', '#f59e0b', '#10b981',
  '#3b82f6', '#8b5cf6', '#ef4444', '#14b8a6',
];

// ── Factory helpers ──────────────────────────────────────

export function newPage(title = 'Untitled', folderId = null) {
  return {
    id: crypto.randomUUID(),
    title,
    content: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pinned: false,
    tags: [],
    folderId,
    archived: false,
    sortOrder: Date.now(),
  };
}

export function newFolder(name) {
  return { id: crypto.randomUUID(), name, sortOrder: Date.now() };
}

// ── Data migration ───────────────────────────────────────

export function migratePageModel(page) {
  return {
    id: page.id,
    title: page.title || 'Untitled',
    content: page.content || '',
    createdAt: page.createdAt || page.updatedAt || new Date().toISOString(),
    updatedAt: page.updatedAt || new Date().toISOString(),
    pinned: !!page.pinned,
    tags: page.tags || [],
    folderId: page.folderId || null,
    archived: !!page.archived,
    sortOrder: page.sortOrder ?? Date.now(),
  };
}

// ── Formatting ───────────────────────────────────────────

export function formatDate(iso) {
  const d = new Date(iso);
  const diff = Math.floor((Date.now() - d) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ── HTML helpers ─────────────────────────────────────────

export function stripHtml(html) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  return doc.body.textContent || '';
}

export function getWordCount(html) {
  const text = stripHtml(html).trim();
  if (!text) return { words: 0, chars: 0 };
  return { words: text.split(/\s+/).length, chars: text.length };
}

// ── Tag colour (deterministic hash) ─────────────────────

export function tagColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return TAG_COLORS[Math.abs(h) % TAG_COLORS.length];
}
