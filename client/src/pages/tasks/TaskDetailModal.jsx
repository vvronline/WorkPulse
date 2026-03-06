import React from 'react';
import ReactQuill from 'react-quill-new';
import 'react-quill-new/dist/quill.snow.css';
import CommentSection from '../../components/CommentSection';
import SprintSelector from '../../components/SprintSelector';
import LabelSelector from './LabelSelector.jsx';
import { PRIORITIES, COLUMNS } from './constants.js';
import { HighlightedHtml, formatDueDate, isDueOverdue, getAvatarUrl } from './utils.jsx';
import s from './TaskDetailModal.module.css';

function getPriority(p) {
  return PRIORITIES.find((pr) => pr.value === p) || PRIORITIES[1];
}

export default function TaskDetailModal({
  detailTask,
  detailComments,
  detailLoading,
  detailEditing,
  detailTab,
  setDetailTab,
  detailHistory,
  // Edit state
  detailEditTitle,
  setDetailEditTitle,
  detailEditDesc,
  setDetailEditDesc,
  detailEditPriority,
  setDetailEditPriority,
  detailEditAssignedTo,
  setDetailEditAssignedTo,
  detailEditDueDate,
  setDetailEditDueDate,
  detailEditSprintId,
  setDetailEditSprintId,
  detailEditLabels,
  setDetailEditLabels,
  detailEditLabelDropdownOpen,
  setDetailEditLabelDropdownOpen,
  scheduleDate,
  setScheduleDate,
  // Shared data
  assignableUsers,
  orgLabels,
  availableSprints,
  currentUser,
  activeTab,
  backlogOpen,
  // Callbacks
  onClose,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onDelete,
  onAddComment,
  onEditComment,
  onDeleteComment,
  onSchedule,
  onUnschedule,
  onStatusChange,
  onToggleLabel,
  showConfirm,
  closeConfirm,
  fetchTasks,
  fetchBacklog,
  setError,
}) {
  if (!detailTask) return null;

  const pri = getPriority(detailTask.priority);
  const colInfo = COLUMNS.find((c) => c.id === detailTask.status) || COLUMNS[0];
  const dueFmt = formatDueDate(detailTask.due_date);
  const overdue = isDueOverdue(detailTask.due_date) && detailTask.status !== 'done';
  const isBacklogItem = !detailTask.date;

  return (
    <div className={s['detail-overlay']} onClick={onClose}>
      <div className={s['detail-modal']} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className={s['detail-modal-header']}>
          <div className={s['detail-badges']}>
            <span
              className={s['task-priority-badge']}
              style={{ '--badge-bg': pri.color + '20', '--badge-color': pri.color }}
            >
              {pri.icon} {pri.label}
            </span>
            <span
              className={s['backlog-status-badge']}
              style={{ '--badge-bg': colInfo.color + '20', '--badge-color': colInfo.color }}
            >
              {colInfo.icon} {colInfo.label}
            </span>
            {isBacklogItem && <span className={s['backlog-badge']}>📦 Backlog</span>}
            {detailTask.date && (
              <span className={s['detail-date-badge']}>📅 {detailTask.date}</span>
            )}
          </div>
          <div className={s['detail-header-actions']}>
            {!detailEditing && (
              <>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => onStartEdit(detailTask)}
                >
                  ✏️ Edit
                </button>
                {currentUser?.id === detailTask?.user_id && (
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={() => onDelete(detailTask)}
                  >
                    🗑 Delete
                  </button>
                )}
              </>
            )}
            <button className={s['close-form-btn']} onClick={onClose}>
              ✕
            </button>
          </div>
        </div>

        {/* Body */}
        <div className={s['detail-modal-body']}>
          {detailEditing ? (
            /* ─── EDIT MODE ─── */
            <div className={s['detail-edit-section']}>
              <div className="form-group">
                <label>Title</label>
                <input
                  type="text"
                  value={detailEditTitle}
                  onChange={(e) => setDetailEditTitle(e.target.value)}
                  className={s['task-edit-input']}
                  autoFocus
                />
              </div>
              <div className={`form-group ${s['quill-wrapper']}`}>
                <label>Description</label>
                <ReactQuill
                  theme="snow"
                  value={detailEditDesc}
                  onChange={setDetailEditDesc}
                  placeholder="Description"
                />
              </div>
              <div className={s['form-extras']}>
                <div className={s['form-extra-group']}>
                  <label>Priority</label>
                  <select
                    value={detailEditPriority}
                    onChange={(e) => setDetailEditPriority(e.target.value)}
                  >
                    {PRIORITIES.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.icon} {p.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className={s['form-extra-group']}>
                  <label>Assign to</label>
                  <select
                    value={detailEditAssignedTo}
                    onChange={(e) => setDetailEditAssignedTo(e.target.value)}
                  >
                    <option value="">Unassigned</option>
                    {assignableUsers.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.full_name || u.username}
                      </option>
                    ))}
                  </select>
                </div>
                <div className={s['form-extra-group']}>
                  <label>Due date</label>
                  <input
                    type="date"
                    value={detailEditDueDate}
                    onChange={(e) => setDetailEditDueDate(e.target.value)}
                  />
                </div>
                <SprintSelector
                  sprints={availableSprints}
                  selected={detailEditSprintId}
                  onChange={(id) => {
                    setDetailEditSprintId(id);
                    if (!id) {
                      setDetailEditDueDate('');
                    } else {
                      const sp = availableSprints.find((sp) => sp.id === id);
                      if (sp) setDetailEditDueDate(sp.end_date);
                    }
                  }}
                />
                <LabelSelector
                  labels={orgLabels}
                  selected={detailEditLabels}
                  onToggle={(id) => onToggleLabel(id, detailEditLabels, setDetailEditLabels)}
                  open={detailEditLabelDropdownOpen}
                  setOpen={setDetailEditLabelDropdownOpen}
                />
              </div>
              <div className={s['detail-edit-buttons']}>
                {isBacklogItem || activeTab === 'backlog' ? (
                  <div className={s['detail-schedule-row']}>
                    <input
                      type="date"
                      value={scheduleDate}
                      onChange={(e) => setScheduleDate(e.target.value)}
                      className={s['date-input']}
                    />
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => onSchedule(detailTask.id, detailTask.title, onClose)}
                    >
                      📅 Schedule to Day
                    </button>
                  </div>
                ) : (
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => onUnschedule(detailTask.id, detailTask.title, onClose)}
                  >
                    📦 Move to Backlog
                  </button>
                )}
                <button className="btn btn-primary btn-sm" onClick={onSaveEdit}>
                  💾 Save Changes
                </button>
                <button className="btn btn-secondary btn-sm" onClick={onCancelEdit}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            /* ─── VIEW MODE ─── */
            <>
              <div className={s['detail-title-row']}>
                <span className={s['backlog-ticket-id']}>#{detailTask.id}</span>
                <h2 className={s['detail-title']}>{detailTask.title}</h2>
                {detailTask.labels && detailTask.labels.length > 0 && (
                  <div className={s['detail-labels']}>
                    {detailTask.labels.map((l) => (
                      <span
                        key={l.id}
                        className={s['label-pill']}
                        style={{ '--label-color': l.color }}
                      >
                        {l.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {detailTask.description && (
                <HighlightedHtml
                  html={detailTask.description}
                  className={s['detail-description']}
                />
              )}

              {/* Meta grid */}
              <div className={s['detail-meta-grid']}>
                {detailTask.assignee && (
                  <div className={s['detail-meta-item']}>
                    <span className={s['detail-meta-label']}>Assigned to</span>
                    <span className={s['detail-meta-value']}>
                      {detailTask.assignee.avatar ? (
                        <img
                          src={getAvatarUrl(detailTask.assignee.avatar)}
                          alt=""
                          className={s['detail-avatar']}
                        />
                      ) : (
                        <span className={s['detail-avatar-placeholder']}>
                          {(
                            detailTask.assignee.full_name ||
                            detailTask.assignee.username ||
                            '?'
                          )[0].toUpperCase()}
                        </span>
                      )}
                      {detailTask.assignee.full_name || detailTask.assignee.username}
                    </span>
                  </div>
                )}
                {detailTask.creator &&
                  detailTask.assigned_to &&
                  detailTask.user_id !== detailTask.assigned_to && (
                    <div className={s['detail-meta-item']}>
                      <span className={s['detail-meta-label']}>Created by</span>
                      <span className={s['detail-meta-value']}>
                        {detailTask.creator.avatar ? (
                          <img
                            src={getAvatarUrl(detailTask.creator.avatar)}
                            alt=""
                            className={s['detail-avatar']}
                          />
                        ) : (
                          <span className={s['detail-avatar-placeholder']}>
                            {(
                              detailTask.creator.full_name ||
                              detailTask.creator.username ||
                              '?'
                            )[0].toUpperCase()}
                          </span>
                        )}
                        {detailTask.creator.full_name || detailTask.creator.username}
                      </span>
                    </div>
                  )}
                {dueFmt && (
                  <div className={s['detail-meta-item']}>
                    <span className={s['detail-meta-label']}>Due date</span>
                    <span
                      className={`${s['detail-meta-value']} ${overdue ? s['overdue'] : ''}`}
                    >
                      📅 {dueFmt}
                    </span>
                  </div>
                )}
                {detailTask.created_at && (
                  <div className={s['detail-meta-item']}>
                    <span className={s['detail-meta-label']}>Created</span>
                    <span className={s['detail-meta-value']}>
                      {new Date(detailTask.created_at + 'Z').toLocaleString()}
                    </span>
                  </div>
                )}
                {detailTask.completed_at && (
                  <div className={s['detail-meta-item']}>
                    <span className={s['detail-meta-label']}>Completed</span>
                    <span className={s['detail-meta-value']}>
                      {new Date(detailTask.completed_at + 'Z').toLocaleString()}
                    </span>
                  </div>
                )}
                {detailTask.sprint_id && (
                  <div className={s['detail-meta-item']}>
                    <span className={s['detail-meta-label']}>Sprint</span>
                    <span className={s['detail-meta-value']}>
                      🏃{' '}
                      {availableSprints.find((sp) => sp.id === detailTask.sprint_id)?.name ||
                        `Sprint #${detailTask.sprint_id}`}
                    </span>
                  </div>
                )}
              </div>

              {/* Status buttons — sprint tickets only */}
              {detailTask.sprint_id && (
                <div className={s['detail-status-bar']}>
                  <span className={s['detail-status-label']}>Move to:</span>
                  {COLUMNS.map((col) => (
                    <button
                      key={col.id}
                      className={`${s['detail-status-btn']} ${detailTask.status === col.id ? s['detail-status-active'] : ''}`}
                      style={{ '--col-color': col.color }}
                      disabled={detailTask.status === col.id}
                      onClick={() => onStatusChange(detailTask, col)}
                    >
                      {col.icon} {col.label}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {/* Comments & History tabs */}
          <div className={s['detail-comments']}>
            <div className={s['detail-tab-switcher']}>
              <button
                className={`${s['detail-tab-btn']} ${detailTab === 'comments' ? s.active : ''}`}
                onClick={() => setDetailTab('comments')}
              >
                💬 Comments{' '}
                <span className={s['detail-tab-count']}>{detailComments.length}</span>
              </button>
              <button
                className={`${s['detail-tab-btn']} ${detailTab === 'history' ? s.active : ''}`}
                onClick={() => setDetailTab('history')}
              >
                📜 History{' '}
                <span className={s['detail-tab-count']}>{detailHistory.length}</span>
              </button>
            </div>

            {detailTab === 'comments' && (
              <CommentSection
                comments={detailComments}
                loading={detailLoading}
                currentUserId={currentUser?.id}
                users={assignableUsers}
                onAdd={onAddComment}
                onEdit={onEditComment}
                onDelete={onDeleteComment}
              />
            )}

            {detailTab === 'history' && (
              <div className={s['history-list']}>
                {detailHistory.length === 0 && (
                  <div className={s['history-empty']}>No history recorded yet.</div>
                )}
                {detailHistory.map((h) => {
                  const actionIcons = {
                    created: '✨',
                    status_change: '🔄',
                    updated: '✏️',
                    scheduled: '📅',
                    unscheduled: '📦',
                    comment_added: '💬',
                    deleted: '🗑️',
                  };
                  const fieldLabels = {
                    status: 'status',
                    title: 'title',
                    description: 'description',
                    priority: 'priority',
                    assigned_to: 'assignee',
                    due_date: 'due date',
                    date: 'schedule',
                    labels: 'labels',
                  };
                  const actionText = () => {
                    if (h.action === 'created') {
                      if (h.field === 'date' && h.old_value)
                        return (
                          <>
                            carried forward from{' '}
                            <span className={s['history-old']}>{h.old_value}</span>
                          </>
                        );
                      return 'created this task';
                    }
                    if (h.action === 'comment_added') return 'added a comment';
                    if (h.action === 'status_change')
                      return (
                        <>
                          changed status from{' '}
                          <span className={s['history-old']}>{h.old_value}</span> →{' '}
                          <span className={s['history-new']}>{h.new_value}</span>
                        </>
                      );
                    if (h.action === 'scheduled')
                      return (
                        <>
                          scheduled to{' '}
                          <span className={s['history-new']}>{h.new_value}</span>
                        </>
                      );
                    if (h.action === 'unscheduled') return 'moved to backlog';
                    if (h.action === 'updated' && h.field) {
                      const label = fieldLabels[h.field] || h.field;
                      if (h.field === 'description') return `updated ${label}`;
                      return (
                        <>
                          {`updated ${label}: `}
                          <span className={s['history-old']}>{h.old_value || '—'}</span>
                          {' → '}
                          <span className={s['history-new']}>{h.new_value || '—'}</span>
                        </>
                      );
                    }
                    return h.action;
                  };

                  return (
                    <div key={h.id} className={s['history-item']}>
                      <span className={s['history-icon']}>
                        {actionIcons[h.action] || '📝'}
                      </span>
                      <div className={s['history-content']}>
                        <span className={s['history-actor']}>
                          {h.full_name || h.username}
                        </span>{' '}
                        <span className={s['history-action']}>{actionText()}</span>
                      </div>
                      <span className={s['history-time']}>
                        {new Date(h.created_at + 'Z').toLocaleString()}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
