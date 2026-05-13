import React, { useState, useEffect } from 'react';
import ReactQuill from 'react-quill-new';
import 'react-quill-new/dist/quill.snow.css';
import CommentSection from '../../components/profile/CommentSection';
import SprintSelector from '../../components/common/SprintSelector';
import LabelSelector from './LabelSelector.jsx';
import { PRIORITIES, COLUMNS } from './constants.js';
import { HighlightedHtml, formatDueDate, isDueOverdue, getAvatarUrl } from './utils.jsx';
import { useTaskCtx } from './TaskContext.jsx';
import {
  StoryPointPicker, WorkItemTypePicker, StoryPointBadge,
  WorkItemTypeBadge, BlockerBadge,
} from '../../components/agile/AgilePickers.jsx';
import AcceptanceCriteria from '../../components/agile/AcceptanceCriteria.jsx';
import { BlockerControl, DependenciesPanel, ParentChildPanel } from '../../components/agile/AgileWorkflowPanels.jsx';
import { CustomFieldsEditor, CustomFieldsSummary } from '../../components/customFields/CustomFieldRenderer.jsx';
import { useAgileConfig } from '../../AgileConfigContext';
import { useCustomFields } from '../../CustomFieldsContext';
import { getTaskDetail, getTaskCustomFieldValues } from '../../api';
import { X, Package, CalendarDays, Save, Pencil, MessageSquare, Clock, Trash2 } from 'lucide-react';
import s from './TaskDetailModal.module.css';

export default function TaskDetailModal({
  detailTask,
  detailComments,
  detailLoading,
  detailEditing,
  detailTab,
  setDetailTab,
  detailHistory,
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
  showConfirm,
  closeConfirm,
  fetchTasks,
  fetchBacklog,
  setError,
}) {
  const { assignableUsers, orgLabels, availableSprints, currentUser, activeTab } = useTaskCtx();
  const { typeById } = useAgileConfig();
  const { fields: customFields } = useCustomFields();
  // Pull the task's custom-field values once when the modal opens so the
  // read-only summary in view mode has data to render.
  const [customValues, setCustomValues] = useState({});
  useEffect(() => {
    if (!detailTask?.id || customFields.length === 0) {
      setCustomValues({});
      return;
    }
    let cancelled = false;
    getTaskCustomFieldValues(detailTask.id)
      .then((r) => { if (!cancelled) setCustomValues(r.data?.values || {}); })
      .catch(() => { if (!cancelled) setCustomValues({}); });
    return () => { cancelled = true; };
  }, [detailTask?.id, customFields.length]);
  // Used to swap the dependencies panel for the Epic↔children panel and vice-versa.
  const isEpic = !!(detailTask?.work_item_type_id && typeById[detailTask.work_item_type_id]?.is_epic);

  // Helper used by the Parent/Child links — replaces the modal contents with
  // the linked ticket so users can navigate parent ↔ child without losing
  // context. Falls back to a query-string nav if the parent didn't supply
  // an opener via the `detail` prop.
  const swapToTask = (id) => {
    getTaskDetail(id)
      .then((res) => {
        if (window.__openTaskDetail) window.__openTaskDetail(res.data);
        else window.location.href = `/tasks?task=${id}`;
      })
      .catch(() => { window.location.href = `/tasks?task=${id}`; });
  };

  // Edit state lives here — co-located with the form that uses it.
  const [editTitle, setEditTitle] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editPriority, setEditPriority] = useState('medium');
  const [editAssignedTo, setEditAssignedTo] = useState('');
  const [editDueDate, setEditDueDate] = useState('');
  const [editSprintId, setEditSprintId] = useState('');
  const [editLabels, setEditLabels] = useState([]);
  const [editLabelDropdownOpen, setEditLabelDropdownOpen] = useState(false);
  const [editStoryPoints, setEditStoryPoints] = useState(null);
  const [editWorkItemType, setEditWorkItemType] = useState('');

  // Initialise edit fields from detailTask whenever edit mode is entered.
  useEffect(() => {
    if (detailEditing && detailTask) {
      setEditTitle(detailTask.title);
      setEditDesc(detailTask.description || '');
      setEditPriority(detailTask.priority || 'medium');
      setEditAssignedTo(String(detailTask.assigned_to || ''));
      setEditDueDate(detailTask.due_date || '');
      setEditSprintId(detailTask.sprint_id || '');
      setEditLabels(detailTask.labels?.map(l => l.id) || []);
      setEditLabelDropdownOpen(false);
      setEditStoryPoints(detailTask.story_points ?? null);
      setEditWorkItemType(detailTask.work_item_type_id || '');
    }
  }, [detailEditing]);

  const handleSaveEdit = () => {
    onSaveEdit({
      title: editTitle,
      description: editDesc,
      priority: editPriority,
      assignedTo: editAssignedTo,
      dueDate: editDueDate,
      sprintId: editSprintId,
      labels: editLabels,
      storyPoints: editStoryPoints,
      workItemType: editWorkItemType,
    });
  };

  const toggleLabel = (id) => {
    setEditLabels(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };
  if (!detailTask) return null;

  const pri = (PRIORITIES.find(pr => pr.value === detailTask.priority) || PRIORITIES[1]);
  const colInfo = COLUMNS.find(c => c.id === detailTask.status) || COLUMNS[0];
  const dueFmt = formatDueDate(detailTask.due_date);
  const overdue = isDueOverdue(detailTask.due_date) && detailTask.status !== 'done';
  // A task is "backlog" only if it has neither a scheduled date nor a sprint
  // assignment. Sprint tickets without a daily-planner date are NOT backlog.
  const isBacklogItem = !detailTask.date && !detailTask.sprint_id;

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
            {isBacklogItem && <span className={s['backlog-badge']}><Package size={12} style={{marginRight:3,verticalAlign:'middle'}} />Backlog</span>}
            {detailTask.date && (
              <span className={s['detail-date-badge']}><CalendarDays size={12} style={{marginRight:3,verticalAlign:'middle'}} />{detailTask.date}</span>
            )}
          </div>
          <div className={s['detail-header-actions']}>
            {!detailEditing && (
              <>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={onStartEdit}
                >
                  <Pencil size={13} style={{marginRight:4,verticalAlign:'middle'}} />Edit
                </button>
                {currentUser?.id === detailTask?.user_id && (
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={() => onDelete(detailTask)}
                  >
                    <Trash2 size={13} style={{marginRight:4,verticalAlign:'middle'}} />Delete
                  </button>
                )}
              </>
            )}
            {detailEditing && (
              <>
                <button className="btn btn-primary btn-sm" onClick={handleSaveEdit}>
                  <Save size={13} style={{marginRight:4,verticalAlign:'middle'}} />Save Changes
                </button>
                <button className="btn btn-secondary btn-sm" onClick={onCancelEdit}>
                  Cancel Edit
                </button>
              </>
            )}
            <button className={s['close-form-btn']} onClick={onClose}>
              <X size={16} />
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
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className={s['task-edit-input']}
                  autoFocus
                />
              </div>
              <div className={`form-group ${s['quill-wrapper']}`}>
                <label>Description</label>
                <ReactQuill
                  theme="snow"
                  value={editDesc}
                  onChange={setEditDesc}
                  placeholder="Description"
                />
              </div>
              <div className={s['form-extras']}>
                <div className={s['form-extra-group']}>
                  <label>Priority</label>
                  <select
                    value={editPriority}
                    onChange={(e) => setEditPriority(e.target.value)}
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
                    value={editAssignedTo}
                    onChange={(e) => setEditAssignedTo(e.target.value)}
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
                  <label>{(isBacklogItem || activeTab === 'backlog') ? 'Due date / Schedule to' : 'Due date'}</label>
                  <input
                    type="date"
                    value={editDueDate}
                    onChange={(e) => setEditDueDate(e.target.value)}
                  />
                </div>
                <SprintSelector
                  sprints={availableSprints}
                  selected={editSprintId}
                  onChange={(id) => {
                    setEditSprintId(id);
                    if (!id) {
                      setEditDueDate('');
                    } else {
                      const sp = availableSprints.find((sp) => sp.id === id);
                      if (sp) setEditDueDate(sp.end_date);
                    }
                  }}
                />
                <LabelSelector
                  labels={orgLabels}
                  selected={editLabels}
                  onToggle={toggleLabel}
                  open={editLabelDropdownOpen}
                  setOpen={setEditLabelDropdownOpen}
                />
                <div className={s['form-extra-group']}>
                  <label>Type</label>
                  <WorkItemTypePicker value={editWorkItemType} onChange={setEditWorkItemType} />
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <StoryPointPicker value={editStoryPoints} onChange={setEditStoryPoints} />
              </div>
                <div className={s['detail-edit-buttons']}>
                {isBacklogItem || activeTab === 'backlog' ? (
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => onSchedule(detailTask.id, detailTask.title, onClose, editDueDate)}
                  >
                    <CalendarDays size={13} style={{marginRight:4,verticalAlign:'middle'}} />Schedule to Day
                  </button>
                ) : (
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => onUnschedule(detailTask.id, detailTask.title, onClose)}
                  >
                    <Package size={13} style={{marginRight:4,verticalAlign:'middle'}} />Move to Backlog
                  </button>
                )}
              </div>

              {/* Pass 2 editors — only available while editing the ticket so
                  the read-only view stays clean and changes are clustered with
                  other edits. Clicking Save Changes closes edit mode (parent
                  refresh re-fetches detail), so any saves done here also persist. */}
              <BlockerControl
                task={detailTask}
                onChanged={() => fetchTasks && fetchTasks()}
              />
              <AcceptanceCriteria taskId={detailTask.id} />
              {/* Epics show their child tickets; everything else shows its
                  parent + dependencies. The panel decides what to render
                  based on the work item type's is_epic flag. */}
              <ParentChildPanel
                task={detailTask}
                onOpenTask={swapToTask}
                onChanged={() => fetchTasks && fetchTasks()}
              />
              {!isEpic && <DependenciesPanel task={detailTask} />}
              <CustomFieldsEditor
                taskId={detailTask.id}
                workItemTypeId={detailTask.work_item_type_id}
                onSaved={(v) => setCustomValues(v)}
              />
            </div>
          ) : (
            /* ─── VIEW MODE ─── */
            <>
              <div className={s['detail-title-row']}>
                <span className={s['backlog-ticket-id']}>#{detailTask.id}</span>
                <WorkItemTypeBadge value={detailTask.work_item_type_id} />
                <h2 className={s['detail-title']}>{detailTask.title}</h2>
                <StoryPointBadge value={detailTask.story_points} />
                <BlockerBadge task={detailTask} />
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

              {/* Read-only summaries of Pass 2 fields. Editing these (toggle
                  blocker, change criteria/dependencies) is gated to Edit mode
                  so users batch their changes and the view stays scannable. */}
              {detailTask.is_blocked && (
                <div style={{ marginTop: 8 }}>
                  <span className={s['detail-blocker-readonly']} title={detailTask.blocked_reason || 'Blocked'}>
                    ⛔ Blocked{detailTask.blocked_reason ? `: ${detailTask.blocked_reason}` : ''}
                  </span>
                </div>
              )}
              {customFields.length > 0 && Object.keys(customValues).length > 0 && (
                <CustomFieldsSummary values={customValues} />
              )}

              {Array.isArray(detailTask.acceptance_criteria) && detailTask.acceptance_criteria.length > 0 && (
                <div className={s['detail-readonly-section']}>
                  <div className={s['detail-readonly-title']}>
                    Acceptance Criteria
                    {' '}
                    <span className={s['detail-readonly-progress']}>
                      ({detailTask.acceptance_criteria.filter(c => c.done).length}/{detailTask.acceptance_criteria.length})
                    </span>
                  </div>
                  <ul className={s['detail-readonly-list']}>
                    {detailTask.acceptance_criteria.map((c, i) => (
                      <li key={c.id || i} className={c.done ? s['ac-done'] : ''}>
                        <span className={s['ac-check']}>{c.done ? '☑' : '☐'}</span> {c.text}
                      </li>
                    ))}
                  </ul>
                </div>
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
                      <CalendarDays size={12} style={{marginRight:3,verticalAlign:'middle'}} />{dueFmt}
                    </span>
                  </div>
                )}
                {detailTask.created_at && (
                  <div className={s['detail-meta-item']}>
                    <span className={s['detail-meta-label']}>Created</span>
                    <span className={s['detail-meta-value']}>
                      {new Date(detailTask.created_at).toLocaleString()}
                    </span>
                  </div>
                )}
                {detailTask.completed_at && (
                  <div className={s['detail-meta-item']}>
                    <span className={s['detail-meta-label']}>Completed</span>
                    <span className={s['detail-meta-value']}>
                      {new Date(detailTask.completed_at).toLocaleString()}
                    </span>
                  </div>
                )}
                {detailTask.sprint_id && (
                  <div className={s['detail-meta-item']}>
                    <span className={s['detail-meta-label']}>Sprint</span>
                    <span className={s['detail-meta-value']}>
                      <span style={{fontWeight:600,fontSize:'0.85em'}}>Sprint</span>{' '}
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
                <MessageSquare size={13} style={{marginRight:4,verticalAlign:'middle'}} />Comments{' '}
                <span className={s['detail-tab-count']}>{detailComments.length}</span>
              </button>
              <button
                className={`${s['detail-tab-btn']} ${detailTab === 'history' ? s.active : ''}`}
                onClick={() => setDetailTab('history')}
              >
                <Clock size={13} style={{marginRight:4,verticalAlign:'middle'}} />History{' '}
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
                    created: '+',
                    status_change: '\u21d4',
                    updated: '\u270e',
                    scheduled: '\u25b8',
                    unscheduled: '\u25a1',
                    comment_added: '\u2022',
                    deleted: '\u00d7',
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
                        {actionIcons[h.action] || '✎'}
                      </span>
                      <div className={s['history-content']}>
                        <span className={s['history-actor']}>
                          {h.full_name || h.username}
                        </span>{' '}
                        <span className={s['history-action']}>{actionText()}</span>
                      </div>
                      <span className={s['history-time']}>
                        {new Date(h.created_at).toLocaleString()}
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
