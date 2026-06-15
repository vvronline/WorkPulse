/* ─────────────────────────────────────────────────────────
   Pure utility helpers for the mobile Notes feature.
   Ported from client/src/components/DailyNotes/notesUtils.ts —
   DOMParser-based helpers are reimplemented with regex so they
   run in the React Native JS runtime (no DOM available).
   ───────────────────────────────────────────────────────── */

import type { NotePage, NoteFolder, NoteTodo } from "../features";

export type { NotePage, NoteFolder, NoteTodo };

export interface Heading {
  id: string;
  level: number;
  text: string;
}

// crypto.randomUUID() isn't reliably available in RN — use a
// Math.random-based UUID v4 fallback.
function generateId(): string {
  const g: any =
    typeof globalThis !== "undefined" ? (globalThis as any).crypto : undefined;
  if (g && typeof g.randomUUID === "function") {
    try {
      return g.randomUUID();
    } catch {
      /* fall through */
    }
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export const TAG_COLORS = [
  "#0ea5e9", "#ec4899", "#f59e0b", "#10b981",
  "#3b82f6", "#0ea5e9", "#ef4444", "#14b8a6",
];

// ── Factory helpers ──────────────────────────────────────

export function newPage(
  title = "Untitled",
  folderId: string | null = null,
  parentPageId: string | null = null,
): NotePage {
  return {
    id: generateId(),
    title,
    content: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdBy: null,
    lastEditedBy: null,
    pinned: false,
    tags: [],
    folderId,
    parentPageId,
    archived: false,
    sortOrder: Date.now(),
    icon: "",
    coverColor: "",
    readOnly: false,
    properties: {},
    reactions: {},
  };
}

export function newFolder(name: string, parentId: string | null = null): NoteFolder {
  return { id: generateId(), name, parentId, sortOrder: Date.now() };
}

export function newTodo(text = ""): NoteTodo {
  return {
    id: generateId(),
    text: text.trim(),
    done: false,
    priority: null,
    dueDate: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
    sortOrder: Date.now(),
  };
}

// ── Data migration ───────────────────────────────────────

export function migratePageModel(page: Partial<NotePage> & { id: string }): NotePage {
  return {
    id: page.id,
    title: page.title || "Untitled",
    content: page.content || "",
    createdAt: page.createdAt || page.updatedAt || new Date().toISOString(),
    updatedAt: page.updatedAt || new Date().toISOString(),
    createdBy: page.createdBy ?? null,
    lastEditedBy: page.lastEditedBy ?? null,
    pinned: !!page.pinned,
    tags: page.tags || [],
    folderId: page.folderId || null,
    parentPageId: page.parentPageId || null,
    archived: !!page.archived,
    sortOrder: page.sortOrder ?? Date.now(),
    icon: page.icon || "",
    coverColor: page.coverColor || "",
    readOnly: !!page.readOnly,
    properties: page.properties && typeof page.properties === "object" ? page.properties : {},
    reactions: page.reactions && typeof page.reactions === "object" ? page.reactions : {},
  };
}

// ── Folder tree helpers ─────────────────────────────

export function getDescendantFolderIds(folderId: string, folders: NoteFolder[]): string[] {
  const children = folders.filter((f) => f.parentId === folderId);
  let ids = children.map((f) => f.id);
  for (const child of children) {
    ids = ids.concat(getDescendantFolderIds(child.id, folders));
  }
  return ids;
}

export function buildFolderTree(
  folders: NoteFolder[],
  parentId: string | null = null,
  depth = 0,
): (NoteFolder & { depth: number })[] {
  const children = folders
    .filter((f) => (f.parentId || null) === parentId)
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  let result: (NoteFolder & { depth: number })[] = [];
  for (const folder of children) {
    result.push({ ...folder, depth });
    result = result.concat(buildFolderTree(folders, folder.id, depth + 1));
  }
  return result;
}

export function getFolderPath(folderId: string, folders: NoteFolder[]): string {
  const parts: string[] = [];
  let current: NoteFolder | undefined = folders.find((f) => f.id === folderId);
  while (current) {
    parts.unshift(current.name);
    const parentId = current.parentId;
    current = parentId ? folders.find((f) => f.id === parentId) : undefined;
  }
  return parts.join(" / ");
}

// ── Page hierarchy helpers (sub-pages) ───────────────────

export function getPageAncestors(pageId: string, pages: NotePage[]): NotePage[] {
  const result: NotePage[] = [];
  const seen = new Set<string>();
  let current: NotePage | undefined = pages.find((p) => p.id === pageId);
  while (current?.parentPageId && !seen.has(current.parentPageId)) {
    seen.add(current.parentPageId);
    const parent = pages.find((p) => p.id === current!.parentPageId);
    if (!parent) break;
    result.unshift(parent);
    current = parent;
  }
  return result;
}

export function getDescendantPageIds(pageId: string, pages: NotePage[]): string[] {
  const direct = pages.filter((p) => p.parentPageId === pageId);
  let ids = direct.map((p) => p.id);
  for (const child of direct) {
    ids = ids.concat(getDescendantPageIds(child.id, pages));
  }
  return ids;
}

export function buildPageTree(
  pages: NotePage[],
  parentPageId: string | null = null,
  depth = 0,
): (NotePage & { depth: number; children: unknown[] })[] {
  const children = pages
    .filter((p) => (p.parentPageId || null) === parentPageId && !p.archived)
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (a.sortOrder || 0) - (b.sortOrder || 0);
    });
  return children.map((p) => ({
    ...p,
    depth,
    children: buildPageTree(pages, p.id, depth + 1),
  }));
}

// ── Internal page-link helpers ───────────────────────────

export function extractPageLinks(html?: string): string[] {
  if (!html) return [];
  const ids = new Set<string>();
  const re = /data-page-id="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) ids.add(m[1]);
  return Array.from(ids);
}

export function getBacklinks(pageId: string, pages: NotePage[]): NotePage[] {
  if (!pageId) return [];
  return pages.filter(
    (p) => !p.archived && p.id !== pageId && extractPageLinks(p.content).includes(pageId),
  );
}

// ── Heading / TOC extraction (regex — no DOMParser in RN) ─

export function extractHeadings(html?: string): Heading[] {
  if (!html) return [];
  const re = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi;
  const out: Heading[] = [];
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = re.exec(html)) !== null) {
    const level = parseInt(m[1], 10);
    const text = stripHtml(m[2]).trim();
    if (text) out.push({ id: `toc-${idx++}`, level, text });
  }
  return out;
}

// ── Formatting ───────────────────────────────────────────

export function formatDate(iso: string): string {
  const d = new Date(iso);
  const diff = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function relativeFromNow(iso?: string): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return formatDate(iso);
}

// ── HTML helpers (regex — no DOMParser in RN) ────────────

const NAMED_ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&[a-zA-Z#0-9]+;/g, (ent) => NAMED_ENTITIES[ent] ?? ent);
}

export function stripHtml(html?: string): string {
  if (!html) return "";
  // Drop script/style content, convert block breaks to spaces, strip tags.
  const noScripts = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
  const withBreaks = noScripts
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ");
  const noTags = withBreaks.replace(/<[^>]+>/g, "");
  return decodeEntities(noTags).replace(/\s+/g, " ").trim();
}

export function getWordCount(html?: string): { words: number; chars: number } {
  const text = stripHtml(html).trim();
  if (!text) return { words: 0, chars: 0 };
  return { words: text.split(/\s+/).length, chars: text.length };
}

export function snippetOf(html?: string, max = 140): string {
  const text = stripHtml(html || "").trim();
  if (!text) return "";
  return text.length > max ? text.slice(0, max).trim() + "…" : text;
}

// ── Tag colour (deterministic hash) ─────────────────────

export function tagColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return TAG_COLORS[Math.abs(h) % TAG_COLORS.length];
}