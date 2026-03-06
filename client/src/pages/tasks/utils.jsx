import React, { useMemo } from 'react';
import DOMPurify from 'dompurify';
import hljs from '../../hljs-setup';
import { getLocalToday } from '../../api';

/** Pre-process HTML: syntax-highlight code blocks before React renders */
export function highlightHtml(raw) {
  if (!raw) return '';
  const clean = DOMPurify.sanitize(raw);
  return clean.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (match, code) => {
    const txt = code
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"');
    try {
      const result = hljs.highlightAuto(txt);
      return `<pre class="hljs">${result.value}</pre>`;
    } catch {
      return match;
    }
  });
}

export function HighlightedHtml({ html, className, ...rest }) {
  const highlighted = useMemo(() => highlightHtml(html), [html]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: highlighted }} {...rest} />;
}

export function stripHtml(html) {
  if (!html) return '';
  const tmp = document.createElement('div');
  tmp.innerHTML = DOMPurify.sanitize(html);
  return tmp.textContent || tmp.innerText || '';
}

export function parseLocalDate(value) {
  return new Date(`${value}T00:00:00`);
}

export function formatDueDate(d) {
  if (!d) return null;
  const today = getLocalToday();
  if (d === today) return 'Today';
  const diff = Math.ceil((parseLocalDate(d) - parseLocalDate(today)) / 86400000);
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff < 0) return `${Math.abs(diff)}d overdue`;
  if (diff <= 7) return `${diff}d left`;
  return parseLocalDate(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatDate(d) {
  if (!d) return '';
  return parseLocalDate(d).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function formatRelativeTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 7) return `${diffD}d ago`;
  if (diffD < 30) return `${Math.floor(diffD / 7)}w ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function getAvatarUrl(avatar) {
  if (!avatar) return '';
  return avatar.startsWith('/') ? avatar : `/uploads/avatars/${avatar}`;
}

export function isDueOverdue(d) {
  return d && d < getLocalToday();
}
