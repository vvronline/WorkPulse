import React, { useState, useMemo } from 'react';
import ReactQuill from 'react-quill-new';
import DOMPurify from 'dompurify';
import hljs from '../hljs-setup';
import s from '../pages/Tasks.module.css';

const COMMENT_QUILL_MODULES = {
  toolbar: [
    ['bold', 'italic', 'underline', 'strike'],
    ['code-block'],
    [{ list: 'ordered' }, { list: 'bullet' }],
    ['link'],
    ['clean'],
  ],
  syntax: { highlight: (text) => hljs.highlightAuto(text).value },
};

function highlightHtml(raw) {
  if (!raw) return '';
  const clean = DOMPurify.sanitize(raw);
  return clean.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (match, code) => {
    const txt = code.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
    try {
      const result = hljs.highlightAuto(txt);
      return `<pre class="hljs">${result.value}</pre>`;
    } catch {
      return match;
    }
  });
}

function HighlightedHtml({ html, className, ...rest }) {
  const highlighted = useMemo(() => highlightHtml(html), [html]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: highlighted }} {...rest} />;
}

function stripHtml(html) {
  if (!html) return '';
  const tmp = document.createElement('div');
  tmp.innerHTML = DOMPurify.sanitize(html);
  return tmp.textContent || tmp.innerText || '';
}

function getAvatarUrl(avatar) {
  if (!avatar) return '';
  return avatar.startsWith('/') ? avatar : `/uploads/avatars/${avatar}`;
}

/**
 * Reusable comment section with inline editing.
 * Props:
 * - comments: Array of comment objects
 * - loading: boolean
 * - currentUserId: number
 * - onAdd: (content: string) => Promise<void>
 * - onEdit: (commentId: number, content: string) => Promise<void>
 * - onDelete: (commentId: number) => void
 */
export default function CommentSection({ comments, loading, currentUserId, onAdd, onEdit, onDelete }) {
  const [commentText, setCommentText] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');

  const handleAdd = async () => {
    if (!stripHtml(commentText).trim()) return;
    await onAdd(commentText);
    setCommentText('');
  };

  const handleEdit = async (id) => {
    if (!stripHtml(editText).trim()) return;
    await onEdit(id, editText);
    setEditingId(null);
    setEditText('');
  };

  return (
    <>
      {loading && <div className="loading-spinner"><div className="spinner" /></div>}
      <div className={s['detail-comment-list']}>
        {comments.length === 0 && !loading && (
          <div className={s['comment-empty']}>No comments yet. Start the conversation!</div>
        )}
        {comments.map(c => (
          <div key={c.id} className={s['comment-item']}>
            <div className={s['comment-meta']}>
              {c.avatar ? (
                <img src={getAvatarUrl(c.avatar)} alt="" className={s['comment-avatar']} />
              ) : (
                <span className={s['comment-avatar-placeholder']}>{(c.full_name || c.username || '?')[0].toUpperCase()}</span>
              )}
              <strong>{c.full_name || c.username}</strong>
              <span className={s['comment-time']}>{new Date(c.created_at).toLocaleString()}</span>
              {c.updated_at && c.updated_at !== c.created_at && <span className={s['comment-edited']}>(edited)</span>}
            </div>
            {editingId === c.id ? (
              <div className={s['comment-edit']}>
                <div className={s['comment-quill-wrapper']}>
                  <ReactQuill theme="snow" value={editText} onChange={setEditText} modules={COMMENT_QUILL_MODULES} placeholder="Edit comment..." />
                </div>
                <div className={s['comment-edit-actions']}>
                  <button className="btn btn-primary btn-sm" onClick={() => handleEdit(c.id)}>Save</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setEditingId(null)}>Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <HighlightedHtml html={c.content} className={s['comment-body']} />
                <div className={s['comment-actions']}>
                  {c.user_id === currentUserId && (
                    <button onClick={() => { setEditingId(c.id); setEditText(c.content); }}>Edit</button>
                  )}
                  <button onClick={() => onDelete(c.id)}>Delete</button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
      <div className={s['comment-input']}>
        <div className={s['comment-quill-wrapper']}>
          <ReactQuill theme="snow" value={commentText} onChange={setCommentText} modules={COMMENT_QUILL_MODULES} placeholder="Write a comment..." />
        </div>
        <button className="btn btn-primary btn-sm" onClick={handleAdd} disabled={!stripHtml(commentText).trim()}>Send</button>
      </div>
    </>
  );
}
