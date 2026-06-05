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
  '#0ea5e9', '#ec4899', '#f59e0b', '#10b981',
  '#3b82f6', '#0ea5e9', '#ef4444', '#14b8a6',
];

// ── Factory helpers ──────────────────────────────────────

export function newPage(title = 'Untitled', folderId = null, parentPageId = null) {
  return {
    id: generateId(),
    title,
    content: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdBy: null,
    lastEditedBy: null,
    pinned: false,
    tags: [],
    folderId,
    parentPageId,        // sub-page parent (null = top-level)
    archived: false,
    sortOrder: Date.now(),
    icon: '',            // optional emoji
    coverColor: '',      // optional hex/css colour for cover band
    readOnly: false,     // locked from editing
    properties: {},      // { status, priority, dueDate, owner, ... }
    reactions: {},       // { '👍': [userId, ...] }
  };
}

export function newFolder(name, parentId = null) {
  return { id: generateId(), name, parentId, sortOrder: Date.now() };
}

export function newTodo(text = '') {
  return {
    id: generateId(),
    text: text.trim(),
    done: false,
    priority: null,        // 'low' | 'medium' | 'high' | null
    dueDate: null,         // ISO date string (YYYY-MM-DD) or null
    createdAt: new Date().toISOString(),
    completedAt: null,
    sortOrder: Date.now(),
  };
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
    parentPageId: page.parentPageId || null,
    archived: !!page.archived,
    sortOrder: page.sortOrder ?? Date.now(),
    icon: page.icon || '',
    coverColor: page.coverColor || '',
    readOnly: !!page.readOnly,
    properties: page.properties && typeof page.properties === 'object' ? page.properties : {},
    reactions: page.reactions && typeof page.reactions === 'object' ? page.reactions : {},
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

// ── Page hierarchy helpers (sub-pages) ───────────────────

/** Return ordered ancestor pages (root first) for the given page */
export function getPageAncestors(pageId, pages) {
  const result = [];
  const seen = new Set();
  let current = pages.find(p => p.id === pageId);
  while (current?.parentPageId && !seen.has(current.parentPageId)) {
    seen.add(current.parentPageId);
    const parent = pages.find(p => p.id === current.parentPageId);
    if (!parent) break;
    result.unshift(parent);
    current = parent;
  }
  return result;
}

/** Recursively collect descendant page ids of the given page id */
export function getDescendantPageIds(pageId, pages) {
  const direct = pages.filter(p => p.parentPageId === pageId);
  let ids = direct.map(p => p.id);
  for (const child of direct) {
    ids = ids.concat(getDescendantPageIds(child.id, pages));
  }
  return ids;
}

/** Build page hierarchy tree as nested nodes (depth + children) */
export function buildPageTree(pages, parentPageId = null, depth = 0) {
  const children = pages
    .filter(p => (p.parentPageId || null) === parentPageId && !p.archived)
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (a.sortOrder || 0) - (b.sortOrder || 0);
    });
  return children.map(p => ({
    ...p,
    depth,
    children: buildPageTree(pages, p.id, depth + 1),
  }));
}

// ── Internal page-link helpers ───────────────────────────

/**
 * Extract internal page links from rendered HTML content.
 * Looks for <a data-page-id="…"> nodes (the format used by PageLinkBlot).
 * Returns an array of unique target page ids.
 */
export function extractPageLinks(html) {
  if (!html) return [];
  const ids = new Set();
  const re = /data-page-id="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) ids.add(m[1]);
  return Array.from(ids);
}

/** Find pages that link to the given page id */
export function getBacklinks(pageId, pages) {
  if (!pageId) return [];
  return pages.filter(p => !p.archived && p.id !== pageId
    && extractPageLinks(p.content).includes(pageId));
}

// ── Heading / TOC extraction ─────────────────────────────

/** Extract a flat list of headings from HTML for TOC generation */
export function extractHeadings(html) {
  if (!html) return [];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const nodes = doc.querySelectorAll('h1, h2, h3');
  return Array.from(nodes).map((n, idx) => ({
    id: `toc-${idx}`,
    level: parseInt(n.tagName.substring(1), 10),
    text: (n.textContent || '').trim(),
  })).filter(h => h.text);
}

// ── Simple line-based diff (no external dependency) ──────

/**
 * Compute a minimal line diff using the LCS algorithm.
 * Returns array of { type: 'eq'|'add'|'del', text }.
 * Operates on the **stripped** (text) version of HTML to keep
 * diffs human-readable in the version-history UI.
 */
export function lineDiff(oldHtml, newHtml) {
  const oldText = stripHtml(oldHtml || '').replace(/\s+\n/g, '\n');
  const newText = stripHtml(newHtml || '').replace(/\s+\n/g, '\n');
  const a = oldText.split(/\r?\n/);
  const b = newText.split(/\r?\n/);
  const m = a.length, n = b.length;
  // LCS table
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ type: 'eq', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: a[i] }); i++; }
    else { out.push({ type: 'add', text: b[j] }); j++; }
  }
  while (i < m) out.push({ type: 'del', text: a[i++] });
  while (j < n) out.push({ type: 'add', text: b[j++] });
  return out;
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
