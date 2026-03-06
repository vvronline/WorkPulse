import React from 'react';
import ReactQuill from 'react-quill-new';
import 'react-quill-new/dist/quill.snow.css';
import { COMMENT_QUILL_MODULES } from './constants.js';
import { HighlightedHtml, stripHtml, getAvatarUrl } from './utils.jsx';
import s from './InlineCommentPanel.module.css';

export default function InlineCommentPanel({
  task,
  comments,
  commentsLoading,
  commentText,
  setCommentText,
  editingCommentId,
  setEditingCommentId,
  editCommentText,
  setEditCommentText,
  currentUser,
  onClose,
  onAddComment,
  onEditComment,
  onDeleteComment,
}) {
  if (!task) return null;

  return (
    <div className={s['comment-overlay']} onClick={onClose}>
      <div className={s['comment-panel']} onClick={(e) => e.stopPropagation()}>
        <div className={s['comment-panel-header']}>
          <h3>💬 Comments — {task.title}</h3>
          <button className={s['close-form-btn']} onClick={onClose}>
            ✕
          </button>
        </div>

        <div className={s['comment-list']}>
          {commentsLoading && (
            <div className="loading-spinner">
              <div className="spinner" />
            </div>
          )}
          {!commentsLoading && comments.length === 0 && (
            <div className={s['comment-empty']}>
              No comments yet. Start the conversation!
            </div>
          )}
          {comments.map((c) => (
            <div key={c.id} className={s['comment-item']}>
              <div className={s['comment-meta']}>
                {c.avatar ? (
                  <img
                    src={getAvatarUrl(c.avatar)}
                    alt=""
                    className={s['comment-avatar']}
                  />
                ) : (
                  <span className={s['comment-avatar-placeholder']}>
                    {(c.full_name || c.username || '?')[0].toUpperCase()}
                  </span>
                )}
                <strong>{c.full_name || c.username}</strong>
                <span className={s['comment-time']}>
                  {new Date(c.created_at + 'Z').toLocaleString()}
                </span>
                {c.updated_at && c.updated_at !== c.created_at && (
                  <span className={s['comment-edited']}>(edited)</span>
                )}
              </div>

              {editingCommentId === c.id ? (
                <div className={s['comment-edit']}>
                  <div className={s['comment-quill-wrapper']}>
                    <ReactQuill
                      theme="snow"
                      value={editCommentText}
                      onChange={setEditCommentText}
                      modules={COMMENT_QUILL_MODULES}
                      placeholder="Edit comment..."
                    />
                  </div>
                  <div className={s['comment-edit-actions']}>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => onEditComment(c.id)}
                    >
                      Save
                    </button>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => setEditingCommentId(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <HighlightedHtml html={c.content} className={s['comment-body']} />
                  <div className={s['comment-actions']}>
                    {c.user_id === currentUser?.id && (
                      <button
                        onClick={() => {
                          setEditingCommentId(c.id);
                          setEditCommentText(c.content);
                        }}
                      >
                        Edit
                      </button>
                    )}
                    <button onClick={() => onDeleteComment(c.id)}>Delete</button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>

        <div className={s['comment-input']}>
          <div className={s['comment-quill-wrapper']}>
            <ReactQuill
              theme="snow"
              value={commentText}
              onChange={setCommentText}
              modules={COMMENT_QUILL_MODULES}
              placeholder="Write a comment..."
            />
            <button
              className={`${s['comment-send-fab']} btn btn-primary btn-sm`}
              onClick={onAddComment}
              disabled={!stripHtml(commentText).trim()}
              title="Send comment"
              aria-label="Send comment"
            >
              ➤
            </button>
          </div>
          <button
            className={`btn btn-primary btn-sm ${s['comment-send-desktop']}`}
            onClick={onAddComment}
            disabled={!stripHtml(commentText).trim()}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
