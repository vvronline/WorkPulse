/* ─────────────────────────────────────────────────────────
   Pure utility helpers for the Notes feature.
   No React imports – fully tree‑shakeable.
   ───────────────────────────────────────────────────────── */

// crypto.randomUUID() requires a secure context (HTTPS / localhost).
// Fall back to a Math.random-based UUID v4 when unavailable.
function generateId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

export const TAG_COLORS = [
  '#6366f1', '#ec4899', '#f59e0b', '#10b981',
  '#3b82f6', '#8b5cf6', '#ef4444', '#14b8a6',
];

// ── Factory helpers ──────────────────────────────────────

export function newPage(title = 'Untitled', folderId = null) {
  return {
    id: generateId(),
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

export function newFolder(name, parentId = null) {
  return { id: generateId(), name, parentId, sortOrder: Date.now() };
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

// ── Folder tree helpers ─────────────────────────────

/** Get all descendant folder IDs (recursive) */
export function getDescendantFolderIds(folderId, folders) {
  const children = folders.filter(f => f.parentId === folderId);
  let ids = children.map(f => f.id);
  for (const child of children) {
    ids = ids.concat(getDescendantFolderIds(child.id, folders));
  }
  return ids;
}

/** Build a flat list of folders with depth for indented display */
export function buildFolderTree(folders, parentId = null, depth = 0) {
  const children = folders
    .filter(f => (f.parentId || null) === parentId)
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  let result = [];
  for (const folder of children) {
    result.push({ ...folder, depth });
    result = result.concat(buildFolderTree(folders, folder.id, depth + 1));
  }
  return result;
}

/** Get folder path string (e.g. "Work / Projects / Q1") */
export function getFolderPath(folderId, folders) {
  const parts = [];
  let current = folders.find(f => f.id === folderId);
  while (current) {
    parts.unshift(current.name);
    current = folders.find(f => f.id === current.parentId);
  }
  return parts.join(' / ');
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
