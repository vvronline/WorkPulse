import React from 'react';
import ReactQuill from 'react-quill-new';
import 'react-quill-new/dist/quill.snow.css';
import { Plus, X, User, CalendarDays, MessageSquare, Package, Folder } from 'lucide-react';
import SprintSelector from '../../components/common/SprintSelector';
import Pagination from '../../components/common/Pagination';
import LabelSelector from './LabelSelector.jsx';
import { PRIORITIES, COLUMNS } from './constants.js';
import { formatDueDate, formatRelativeTime, isDueOverdue, stripHtml, getAvatarUrl } from './utils.jsx';
import {
  StoryPointPicker, WorkItemTypePicker, StoryPointBadge,
  WorkItemTypeBadge, BlockerBadge,
} from '../../components/agile/AgilePickers.jsx';
import { getLocalToday } from '../../api';
import { useTaskCtx } from './TaskContext.jsx';
import s from './BacklogTab.module.css';

function getPriority(p) {
  return PRIORITIES.find((pr) => pr.value === p) || PRIORITIES[1];
}

export default function BacklogTab({
  backlogTasks,
  sortedBacklogTasks,
  backlogLoading,
  backlogSummary,
  backlogSort,
  setBacklogSort,
  backlogFormOpen,
  setBacklogFormOpen,
  backlogTitle,
  setBacklogTitle,
  backlogDesc,
  setBacklogDesc,
  backlogPriority,
  setBacklogPriority,
  backlogAssignedTo,
  setBacklogAssignedTo,
  backlogDueDate,
  setBacklogDueDate,
  backlogLabels,
  setBacklogLabels,
  backlogLabelDropdownOpen,
  setBacklogLabelDropdownOpen,
  backlogSprintId,
  setBacklogSprintId,
  backlogStoryPoints,
  setBacklogStoryPoints,
  backlogWorkItemType,
  setBacklogWorkItemType,
  backlogProjectId,
  setBacklogProjectId,
  backlogLimit,
  setBacklogLimit,
  backlogOffset,
  setBacklogOffset,
  backlogTotal,
  scheduleTaskId,
  setScheduleTaskId,
  scheduleDate,
  setScheduleDate,
  filterPriority,
  summaryAllActive,
  error,
  onHandleAddBacklog,
  onOpenDetail,
  onScheduleTask,
  onHandleSummaryTotal,
  onHandleSummaryPriority,
  onToggleLabel,
}) {
  const { assignableUsers, orgLabels, availableSprints, availableProjects } = useTaskCtx();
  return (
    <>
      {error && <div className="error-msg error-msg-mb">{error}</div>}

      {/* Backlog Summary Bar */}
      {!backlogLoading && backlogTasks.length > 0 && (
        <div className={s['backlog-summary']}>
          <button
            type="button"
            className={`${s['backlog-summary-chip']} ${s['chip-all']} ${summaryAllActive ? s['backlog-summary-chip-active'] : ''}`}
            onClick={onHandleSummaryTotal}
            aria-pressed={summaryAllActive}
          >
            <span className={s['backlog-summary-value']}>
              {backlogSummary.total || backlogTasks.length}
            </span>
            <span className={s['backlog-summary-text']}>Total</span>
          </button>

          <div className={s['backlog-summary-group']}>
            {PRIORITIES.map((p) => (
              <button
                key={p.value}
                type="button"
                className={`${s['backlog-summary-chip']} ${filterPriority === p.value ? s['backlog-summary-chip-active'] : ''}`}
                onClick={() => onHandleSummaryPriority(p.value)}
                aria-pressed={filterPriority === p.value}
                style={{ '--chip-accent': p.color }}
              >
                <span className={s['backlog-summary-value']}>
                  {backlogSummary.byPriority?.[p.value] || 0}
                </span>
                <span className={s['backlog-summary-text']}>
                  {p.icon} {p.label}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Sort + Controls Bar */}
      {!backlogLoading && backlogTasks.length > 0 && (
        <div className={s['backlog-toolbar']}>
          <div className={s['backlog-toolbar-left']}>
            <span className={s['backlog-toolbar-label']}>Sort by</span>
            <select
              value={backlogSort}
              onChange={(e) => setBacklogSort(e.target.value)}
              className={s['backlog-sort-select']}
            >
              <option value="priority">Priority</option>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="due_date">Due date</option>
              <option value="title">Title A-Z</option>
            </select>
          </div>
          <span className={s['backlog-toolbar-count']}>
            {backlogTasks.length} ticket{backlogTasks.length !== 1 ? 's' : ''}
          </span>
        </div>
      )}

      {/* Add Backlog Form */}
      {backlogFormOpen && (
        <div className={s['tasks-form-card']}>
          <div className={s['form-card-header']}>
            <h3><Plus size={16} style={{marginRight:5,verticalAlign:'middle'}} />New Backlog Ticket</h3>
            <button
              className={s['close-form-btn']}
              onClick={() => setBacklogFormOpen(false)}
              title="Close"
            >
              <X size={14} />
            </button>
          </div>
          <form onSubmit={onHandleAddBacklog} className={s['add-form']}>
            <div className="form-group">
              <input
                type="text"
                value={backlogTitle}
                onChange={(e) => setBacklogTitle(e.target.value)}
                placeholder="Ticket title..."
                required
                autoFocus
              />
            </div>
            <div className={`form-group ${s['quill-wrapper']}`}>
              <ReactQuill
                theme="snow"
                value={backlogDesc}
                onChange={setBacklogDesc}
                placeholder="Description (optional)"
              />
            </div>
            <div className={s['form-extras']}>
              <div className={s['form-extra-group']}>
                <label><User size={13} style={{marginRight:4,verticalAlign:'middle'}} />Assign to</label>
                <select
                  value={backlogAssignedTo}
                  onChange={(e) => setBacklogAssignedTo(e.target.value)}
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
                <label><CalendarDays size={13} style={{marginRight:4,verticalAlign:'middle'}} />Due date</label>
                <input
                  type="date"
                  value={backlogDueDate}
                  onChange={(e) => setBacklogDueDate(e.target.value)}
                />
              </div>
              <SprintSelector
                sprints={availableSprints}
                selected={backlogSprintId}
                onChange={(id) => {
                  setBacklogSprintId(id);
                  if (!id) {
                    setBacklogDueDate('');
                  } else {
                    const sp = availableSprints.find((sp) => sp.id === id);
                    if (sp) setBacklogDueDate(sp.end_date);
                  }
                }}
              />
              <LabelSelector
                labels={orgLabels}
                selected={backlogLabels}
                onToggle={(id) => onToggleLabel(id, backlogLabels, setBacklogLabels)}
                open={backlogLabelDropdownOpen}
                setOpen={setBacklogLabelDropdownOpen}
              />
              <div className={s['form-extra-group']}>
                <label>Type</label>
                <WorkItemTypePicker value={backlogWorkItemType} onChange={setBacklogWorkItemType} />
              </div>
              {availableProjects && availableProjects.length > 0 && (
                <div className={s['form-extra-group']}>
                  <label>
                    <Folder size={13} style={{marginRight:4,verticalAlign:'middle'}} />Project
                  </label>
                  <select
                    value={backlogProjectId || ''}
                    onChange={(e) => setBacklogProjectId(e.target.value)}
                    title="Assign to a project to get a stable issue key (e.g. WEB-123)"
                  >
                    <option value="">— No project —</option>
                    {availableProjects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.key} · {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <div className={s['form-extras']} style={{ marginTop: 4 }}>
              <StoryPointPicker value={backlogStoryPoints} onChange={setBacklogStoryPoints} />
            </div>
            <div className={s['form-bottom']}>
              <div className={s['priority-selector']}>
                {PRIORITIES.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    className={`${s['priority-btn']} ${backlogPriority === p.value ? s.active : ''}`}
                    style={{ '--pri-color': p.color }}
                    onClick={() => setBacklogPriority(p.value)}
                  >
                    {p.icon} {p.label}
                  </button>
                ))}
              </div>
              <button type="submit" className="btn btn-primary btn-fullwidth">
                Create Ticket
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Backlog List */}
      {backlogLoading ? (
        <div className="loading-spinner">
          <div className="spinner" />
        </div>
      ) : (
        <div className={s['backlog-list']}>
          {backlogTasks.length === 0 && (
            <div className={s['tasks-empty']}>
              <div className={s['tasks-empty-icon']}><Package size={36} strokeWidth={1.5} /></div>
              <p>Backlog is empty</p>
              <span>
                Create a ticket to organize work that doesn't have a scheduled date yet.
              </span>
            </div>
          )}
          {/* Top pagination bar — also visible above the list so users with
              many tickets don't have to scroll to switch pages. */}
          {backlogTasks.length > 0 && (
            <Pagination
              total={backlogTotal || backlogTasks.length}
              limit={backlogLimit}
              offset={backlogOffset}
              onPageChange={setBacklogOffset}
              onLimitChange={setBacklogLimit}
              pageSizeOptions={[10, 25, 50, 100]}
              itemLabel="ticket"
            />
          )}
          {sortedBacklogTasks.map((task) => {
            const pri = getPriority(task.priority);
            const dueFmt = formatDueDate(task.due_date);
            const overdue = isDueOverdue(task.due_date) && task.status !== 'done';
            const colInfo = COLUMNS.find((c) => c.id === task.status) || COLUMNS[0];
            const descPreview = stripHtml(task.description);

            return (
              <div
                key={task.id}
                className={`${s['backlog-card']} ${s.clickable} ${task.status === 'done' ? s['backlog-card-done'] : ''}`}
                onClick={(e) => {
                  if (e.target.closest(`.${s['backlog-actions']}`)) return;
                  onOpenDetail(task);
                }}
              >
                <div
                  className={s['backlog-priority-bar']}
                  style={{ '--pri-color': pri.color }}
                />
                <div className={s['backlog-card-body']}>
                  <div className={s['backlog-card-header']}>
                    <span className={s['backlog-ticket-id']}>
                      {task.issue_key || `#${task.id}`}
                    </span>
                    <span
                      className={s['backlog-status-badge']}
                      style={{
                        '--badge-bg': colInfo.color + '20',
                        '--badge-color': colInfo.color,
                      }}
                    >
                      {colInfo.icon} {colInfo.label}
                    </span>
                    <span
                      className={s['task-priority-badge']}
                      style={{
                        '--badge-bg': pri.color + '20',
                        '--badge-color': pri.color,
                      }}
                    >
                      {pri.icon} {pri.label}
                    </span>
                    <WorkItemTypeBadge value={task.work_item_type_id} />
                    <StoryPointBadge value={task.story_points} />
                    <BlockerBadge task={task} />
                    {task.labels &&
                      task.labels.length > 0 &&
                      task.labels.map((l) => (
                        <span
                          key={l.id}
                          className={s['label-pill']}
                          style={{ '--label-color': l.color }}
                        >
                          {l.name}
                        </span>
                      ))}
                  </div>
                  <span className={s['backlog-card-title']}>{task.title}</span>
                  {descPreview && (
                    <div className={s['backlog-desc-preview']}>{descPreview}</div>
                  )}
                  <div className={s['backlog-card-footer']}>
                    {task.assignee && (
                      <span className={s['backlog-meta-chip']}>
                        {task.assignee.avatar ? (
                          <img
                            src={getAvatarUrl(task.assignee.avatar)}
                            alt=""
                            className={s['backlog-meta-avatar']}
                          />
                        ) : (
                          <span className={s['backlog-meta-avatar-placeholder']}>
                            {(
                              task.assignee.full_name ||
                              task.assignee.username ||
                              '?'
                            )[0].toUpperCase()}
                          </span>
                        )}
                        {task.assignee.full_name || task.assignee.username}
                      </span>
                    )}
                    {dueFmt && (
                      <span
                        className={`${s['backlog-meta-chip']} ${overdue ? s['overdue'] : ''}`}
                      >
                        <CalendarDays size={11} style={{marginRight:3,verticalAlign:'middle'}} />{dueFmt}
                      </span>
                    )}
                    {task.comment_count > 0 && (
                      <span className={s['backlog-meta-chip']}>
                        <MessageSquare size={11} style={{marginRight:3,verticalAlign:'middle'}} />{task.comment_count}
                      </span>
                    )}
                    <span className={s['backlog-meta-time']}>
                      {formatRelativeTime(task.created_at)}
                    </span>
                    <div className={s['backlog-actions']}>
                      {scheduleTaskId === task.id ? (
                        <div className={s['schedule-popover']}>
                          <input
                            type="date"
                            value={scheduleDate}
                            onChange={(e) => setScheduleDate(e.target.value)}
                            className={s['date-input']}
                          />
                          <button
                            className="btn btn-primary btn-sm"
                            onClick={() => onScheduleTask(task.id, task.title)}
                          >
                            Go
                          </button>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => setScheduleTaskId(null)}
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => {
                            setScheduleTaskId(task.id);
                            setScheduleDate(getLocalToday());
                          }}
                          title="Schedule to a day"
                        >
                          <CalendarDays size={13} style={{marginRight:4,verticalAlign:'middle'}} />Schedule
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
