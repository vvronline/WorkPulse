import React from 'react';
import ReactQuill from 'react-quill-new';
import 'react-quill-new/dist/quill.snow.css';
import SprintSelector from '../../components/SprintSelector';
import LabelSelector from './LabelSelector.jsx';
import { PRIORITIES, COLUMNS } from './constants.js';
import { formatDueDate, formatRelativeTime, isDueOverdue, stripHtml, getAvatarUrl } from './utils.jsx';
import { getLocalToday } from '../../api';
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
  scheduleTaskId,
  setScheduleTaskId,
  scheduleDate,
  setScheduleDate,
  assignableUsers,
  orgLabels,
  availableSprints,
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
            <h3>➕ New Backlog Ticket</h3>
            <button
              className={s['close-form-btn']}
              onClick={() => setBacklogFormOpen(false)}
              title="Close"
            >
              ✕
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
                <label>👤 Assign to</label>
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
                <label>📅 Due date</label>
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
              <button type="submit" className="btn btn-primary">
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
              <div className={s['tasks-empty-icon']}>📦</div>
              <p>Backlog is empty</p>
              <span>
                Create a ticket to organize work that doesn't have a scheduled date yet.
              </span>
            </div>
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
                    <span className={s['backlog-ticket-id']}>#{task.id}</span>
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
                        📅 {dueFmt}
                      </span>
                    )}
                    {task.comment_count > 0 && (
                      <span className={s['backlog-meta-chip']}>
                        💬 {task.comment_count}
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
                            ✕
                          </button>
                        </div>
                      ) : (
                        <button
                          className={s['backlog-action-btn']}
                          onClick={() => {
                            setScheduleTaskId(task.id);
                            setScheduleDate(getLocalToday());
                          }}
                          title="Schedule to a day"
                        >
                          📅 Schedule
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
