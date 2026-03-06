import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  getTasks, updateTaskStatus, deleteTask, carryForwardTasks,
  getAssignableUsers, getTaskLabels, addTaskComment, updateTaskComment,
  getLocalToday, getTaskDetail, getTeamSprintConfig, getAvailableSprints,
} from '../api';
import ConfirmDialog from '../components/ConfirmDialog';
import { useAuth } from '../AuthContext';
import { useAutoDismiss } from '../hooks/useAutoDismiss';
import 'highlight.js/styles/github-dark.css';

import { COLUMNS } from './tasks/constants.js';
import KanbanBoard from './tasks/KanbanBoard.jsx';
import MyDayPanel from './tasks/MyDayPanel.jsx';
import SprintImportPanel from './tasks/SprintImportPanel.jsx';
import BacklogTab from './tasks/BacklogTab.jsx';
import TasksHeader from './tasks/TasksHeader.jsx';
import TaskDetailModal from './tasks/TaskDetailModal.jsx';
import InlineCommentPanel from './tasks/InlineCommentPanel.jsx';

import { useConfirmDialog } from './tasks/hooks/useConfirmDialog.js';
import { useFilters } from './tasks/hooks/useFilters.js';
import { useGlobalSearch } from './tasks/hooks/useGlobalSearch.js';
import { useComments } from './tasks/hooks/useComments.js';
import { useBacklog } from './tasks/hooks/useBacklog.js';
import { useTaskDetail } from './tasks/hooks/useTaskDetail.js';
import { useDragDrop } from './tasks/hooks/useDragDrop.js';

import s from './Tasks.module.css';

export default function Tasks() {
  const { user: currentUser } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tasks, setTasks] = useState([]);
  const [stats, setStats] = useState({ total: 0, done: 0, inProgress: 0, percent: 0 });
  const [loading, setLoading] = useState(true);
  const [date, setDate] = useState(() => getLocalToday());
  const [error, setError] = useAutoDismiss('');
  const [taskToDelete, setTaskToDelete] = useState(null);
  const [carriedCount, setCarriedCount] = useState(0);
  const [activeTab, setActiveTab] = useState('myday');
  const [backlogOpen] = useState(false);
  const [availableSprints, setAvailableSprints] = useState([]);
  const [selectedSprintId, setSelectedSprintId] = useState(null);
  const [sprintImportOpen, setSprintImportOpen] = useState(false);
  const [assignableUsers, setAssignableUsers] = useState([]);
  const [orgLabels, setOrgLabels] = useState([]);
  const autoCarriedRef = useRef(false);

  const { confirmDialog, showConfirm, closeConfirm } = useConfirmDialog();
  const filters = useFilters({ activeTab });
  const globalSearch = useGlobalSearch();

  const fetchTasks = useCallback(async () => {
    try {
      const params = { ...filters.plannerFilters };
      if (activeTab === 'sprint' && selectedSprintId) {
        params.sprint_id = selectedSprintId;
        const res = await getTasks(undefined, params);
        setTasks(res.data.tasks);
        setStats(res.data.stats);
      } else if (activeTab === 'sprint' && !selectedSprintId) {
        setTasks([]);
        setStats({ total: 0, done: 0, inProgress: 0, percent: 0 });
      } else if (activeTab === 'myday') {
        params.scope = 'personal';
        params.include_due = '1';
        const res = await getTasks(date, params);
        setTasks(res.data.tasks);
        setStats(res.data.stats);
      }
      setError('');
    } catch {
      setError('Failed to load tasks');
    } finally {
      setLoading(false);
    }
  }, [date, activeTab, selectedSprintId, filters.plannerFilters]);

  const backlog = useBacklog({
    activeTab, backlogOpen, date,
    backlogFilters: filters.backlogFilters,
    selectedSprintId, showConfirm, closeConfirm, fetchTasks, setError,
  });
  const detail = useTaskDetail({
    activeTab, backlogOpen, showConfirm, closeConfirm,
    setTasks, setBacklogTasks: backlog.setBacklogTasks,
    fetchTasks, fetchBacklog: backlog.fetchBacklog, setError,
  });
  const comments = useComments({ showConfirm, closeConfirm, setTasks, setError });
  const drag = useDragDrop({ tasks, setTasks, showConfirm, closeConfirm, setError });

  useEffect(() => {
    getAssignableUsers().then((r) => setAssignableUsers(r.data)).catch(() => {});
    getTaskLabels().then((r) => setOrgLabels(r.data)).catch(() => {});
    if (currentUser?.team_id) {
      getAvailableSprints().then((r) => {
        setAvailableSprints(r.data);
        const active = r.data.find((sp) => sp.status === 'active');
        if (active) setSelectedSprintId(active.id);
      }).catch(() => {});
    }
  }, [currentUser?.team_id]);

  useEffect(() => {
    const taskId = searchParams.get('task');
    if (!taskId) return;
    setSearchParams({}, { replace: true });
    getTaskDetail(taskId).then((res) => detail.openTaskDetail(res.data)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  useEffect(() => {
    if (activeTab === 'backlog') return;
    const controller = new AbortController();
    setLoading(true);
    fetchTasks().finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [fetchTasks, activeTab]);

  useEffect(() => {
    if (!currentUser?.team_id) {
      if (activeTab === 'sprint') setActiveTab('myday');
      return;
    }
    getTeamSprintConfig(currentUser.team_id).catch(() => {
      if (activeTab === 'sprint') setActiveTab('myday');
    });
  }, [currentUser?.team_id]);

  useEffect(() => {
    const today = getLocalToday();
    if (date !== today || autoCarriedRef.current) return;
    autoCarriedRef.current = true;
    carryForwardTasks()
      .then((res) => {
        if (res.data.carried > 0) {
          setCarriedCount(res.data.carried);
          fetchTasks();
          setTimeout(() => setCarriedCount(0), 4000);
        }
      })
      .catch((e) => console.error(e));
  }, [date, fetchTasks]);

  useEffect(() => {
    if (activeTab === 'backlog' || backlogOpen) backlog.fetchBacklog();
  }, [activeTab, backlogOpen, backlog.fetchBacklog]);

  const handleDelete = (task) => setTaskToDelete(task);
  const confirmDeleteWithRefresh = async () => {
    if (!taskToDelete) return;
    try {
      await deleteTask(taskToDelete.id);
      setTaskToDelete(null);
      if (comments.commentTaskId === taskToDelete.id) comments.closeComments();
      if (detail.detailTask?.id === taskToDelete.id) detail.closeTaskDetail();
      fetchTasks();
      if (backlogOpen || activeTab === 'backlog') backlog.fetchBacklog();
    } catch {
      setError('Failed to delete item');
    }
  };

  const handleToggleDone = (task) => {
    const newStatus = task.status === 'done' ? 'pending' : 'done';
    const label = newStatus === 'done' ? 'Mark as done' : 'Mark as incomplete';
    showConfirm(label, `${label}: "${task.title}"?`, async () => {
      closeConfirm();
      try {
        await updateTaskStatus(task.id, newStatus);
        fetchTasks();
      } catch { setError('Failed to update task'); }
    }, { confirmText: label });
  };

  const handleSummaryTotal = () => {
    filters.setFiltersOpen(true); filters.setFilterPriority(''); filters.setFilterStatus('');
  };
  const handleSummaryPriority = (value) => {
    filters.setFiltersOpen(true);
    filters.setFilterPriority((prev) => (prev === value ? '' : value));
  };
  const toggleLabel = (labelId, list, setter) => {
    setter((prev) => prev.includes(labelId) ? prev.filter((id) => id !== labelId) : [...prev, labelId]);
  };
  const getColTasks = (colId) => tasks.filter((t) => t.status === colId);
  const isToday = date === getLocalToday();
  const sprintMode = activeTab === 'sprint';
  const summaryAllActive = !filters.filterPriority;

  return (
    <div className={s['tasks-page']}>
      <TasksHeader
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        date={date}
        setDate={setDate}
        isToday={isToday}
        availableSprints={availableSprints}
        selectedSprintId={selectedSprintId}
        setSelectedSprintId={setSelectedSprintId}
        currentUser={currentUser}
        backlogTasks={backlog.backlogTasks}
        filterCount={filters.filterCount}
        filtersOpen={filters.filtersOpen}
        setFiltersOpen={filters.setFiltersOpen}
        filterAssignee={filters.filterAssignee}
        setFilterAssignee={filters.setFilterAssignee}
        filterLabel={filters.filterLabel}
        setFilterLabel={filters.setFilterLabel}
        filterPriority={filters.filterPriority}
        setFilterPriority={filters.setFilterPriority}
        filterStatus={filters.filterStatus}
        setFilterStatus={filters.setFilterStatus}
        filterSearch={filters.filterSearch}
        setFilterSearch={filters.setFilterSearch}
        assignableUsers={assignableUsers}
        orgLabels={orgLabels}
        globalSearch={globalSearch.globalSearch}
        globalResults={globalSearch.globalResults}
        globalSearching={globalSearch.globalSearching}
        globalSearchOpen={globalSearch.globalSearchOpen}
        globalSearchRef={globalSearch.globalSearchRef}
        onGlobalSearch={globalSearch.handleGlobalSearch}
        setGlobalSearchOpen={globalSearch.setGlobalSearchOpen}
        onOpenDetail={detail.openTaskDetail}
        setBacklogFormOpen={backlog.setBacklogFormOpen}
        setSprintImportOpen={setSprintImportOpen}
        fetchBacklog={backlog.fetchBacklog}
        clearFilters={filters.clearFilters}
      />

      {activeTab === 'sprint' && (
        <>
          <div className={s['tasks-progress-card']}>
            <div className={s['tasks-progress-info']}>
              <span className={s['tasks-progress-label']}>{stats.done}/{stats.total} completed</span>
              <span className={s['tasks-progress-pct']}>{stats.percent}%</span>
            </div>
            <div className={s['tasks-progress-bar']}>
              <div className={s['tasks-progress-fill']} style={{ '--fill-width': `${stats.percent}%` }} />
            </div>
            <div className={s['tasks-progress-counts']}>
              {COLUMNS.map((col) => (
                <span key={col.id} style={{ color: col.color }}>
                  {col.icon} {getColTasks(col.id).length} {col.label}
                </span>
              ))}
            </div>
          </div>

          {carriedCount > 0 && (
            <div className={s['carry-banner']}>
              📥 {carriedCount} incomplete item{carriedCount > 1 ? 's' : ''} from yesterday carried forward automatically.
            </div>
          )}
          {error && <div className="error-msg error-msg-mb">{error}</div>}

          {sprintImportOpen && (
            <SprintImportPanel
              backlogTasks={backlog.backlogTasks}
              backlogLoading={backlog.backlogLoading}
              selectedSprintId={selectedSprintId}
              availableSprints={availableSprints}
              assignableUsers={assignableUsers}
              importConfigTask={backlog.importConfigTask}
              importAssignedTo={backlog.importAssignedTo}
              importDueDate={backlog.importDueDate}
              onSetImportConfigTask={backlog.setImportConfigTask}
              onSetImportAssignedTo={backlog.setImportAssignedTo}
              onSetImportDueDate={backlog.setImportDueDate}
              onImportToSprint={backlog.handleImportToSprint}
              onClose={() => { setSprintImportOpen(false); backlog.setImportConfigTask(null); }}
            />
          )}

          {loading ? (
            <div className="loading-spinner"><div className="spinner" /></div>
          ) : (
            <KanbanBoard
              tasks={tasks}
              dragOverCol={drag.dragOverCol}
              sprintMode={sprintMode}
              onDragOver={drag.onDragOver}
              onDragLeave={drag.onDragLeave}
              onDrop={drag.onDrop}
              onDragStart={drag.onDragStart}
              onDragEnd={drag.onDragEnd}
              onOpenDetail={detail.openTaskDetail}
              onOpenComments={comments.openComments}
            />
          )}

          {tasks.length === 0 && !loading && (
            <div className={s['tasks-empty']}>
              <div className={s['tasks-empty-icon']}>📋</div>
              <p>No items in this sprint</p>
              <span>Assign tickets from the Backlog to this sprint.</span>
            </div>
          )}
        </>
      )}

      {activeTab === 'myday' && (
        <MyDayPanel
          tasks={tasks}
          loading={loading}
          stats={stats}
          currentUser={currentUser}
          error={error}
          onOpenDetail={detail.openTaskDetail}
          onToggleDone={handleToggleDone}
          onDelete={handleDelete}
        />
      )}

      {activeTab === 'backlog' && (
        <BacklogTab
          backlogTasks={backlog.backlogTasks}
          sortedBacklogTasks={backlog.sortedBacklogTasks}
          backlogLoading={backlog.backlogLoading}
          backlogSummary={backlog.backlogSummary}
          backlogSort={backlog.backlogSort}
          setBacklogSort={backlog.setBacklogSort}
          backlogFormOpen={backlog.backlogFormOpen}
          setBacklogFormOpen={backlog.setBacklogFormOpen}
          backlogTitle={backlog.backlogTitle}
          setBacklogTitle={backlog.setBacklogTitle}
          backlogDesc={backlog.backlogDesc}
          setBacklogDesc={backlog.setBacklogDesc}
          backlogPriority={backlog.backlogPriority}
          setBacklogPriority={backlog.setBacklogPriority}
          backlogAssignedTo={backlog.backlogAssignedTo}
          setBacklogAssignedTo={backlog.setBacklogAssignedTo}
          backlogDueDate={backlog.backlogDueDate}
          setBacklogDueDate={backlog.setBacklogDueDate}
          backlogLabels={backlog.backlogLabels}
          setBacklogLabels={backlog.setBacklogLabels}
          backlogLabelDropdownOpen={backlog.backlogLabelDropdownOpen}
          setBacklogLabelDropdownOpen={backlog.setBacklogLabelDropdownOpen}
          backlogSprintId={backlog.backlogSprintId}
          setBacklogSprintId={backlog.setBacklogSprintId}
          scheduleTaskId={backlog.scheduleTaskId}
          setScheduleTaskId={backlog.setScheduleTaskId}
          scheduleDate={backlog.scheduleDate}
          setScheduleDate={backlog.setScheduleDate}
          assignableUsers={assignableUsers}
          orgLabels={orgLabels}
          availableSprints={availableSprints}
          filterPriority={filters.filterPriority}
          summaryAllActive={summaryAllActive}
          error={error}
          onHandleAddBacklog={backlog.handleAddBacklog}
          onOpenDetail={detail.openTaskDetail}
          onScheduleTask={backlog.handleScheduleTask}
          onHandleSummaryTotal={handleSummaryTotal}
          onHandleSummaryPriority={handleSummaryPriority}
          onToggleLabel={toggleLabel}
        />
      )}

      <InlineCommentPanel
        task={tasks.find((t) => t.id === comments.commentTaskId) || null}
        comments={comments.comments}
        commentsLoading={comments.commentsLoading}
        commentText={comments.commentText}
        setCommentText={comments.setCommentText}
        editingCommentId={comments.editingCommentId}
        setEditingCommentId={comments.setEditingCommentId}
        editCommentText={comments.editCommentText}
        setEditCommentText={comments.setEditCommentText}
        currentUser={currentUser}
        onClose={comments.closeComments}
        onAddComment={comments.handleAddComment}
        onEditComment={comments.handleEditComment}
        onDeleteComment={comments.handleDeleteComment}
      />

      <TaskDetailModal
        detailTask={detail.detailTask}
        detailComments={detail.detailComments}
        detailLoading={detail.detailLoading}
        detailEditing={detail.detailEditing}
        detailTab={detail.detailTab}
        setDetailTab={detail.setDetailTab}
        detailHistory={detail.detailHistory}
        detailEditTitle={detail.detailEditTitle}
        setDetailEditTitle={detail.setDetailEditTitle}
        detailEditDesc={detail.detailEditDesc}
        setDetailEditDesc={detail.setDetailEditDesc}
        detailEditPriority={detail.detailEditPriority}
        setDetailEditPriority={detail.setDetailEditPriority}
        detailEditAssignedTo={detail.detailEditAssignedTo}
        setDetailEditAssignedTo={detail.setDetailEditAssignedTo}
        detailEditDueDate={detail.detailEditDueDate}
        setDetailEditDueDate={detail.setDetailEditDueDate}
        detailEditSprintId={detail.detailEditSprintId}
        setDetailEditSprintId={detail.setDetailEditSprintId}
        detailEditLabels={detail.detailEditLabels}
        setDetailEditLabels={detail.setDetailEditLabels}
        detailEditLabelDropdownOpen={detail.detailEditLabelDropdownOpen}
        setDetailEditLabelDropdownOpen={detail.setDetailEditLabelDropdownOpen}
        scheduleDate={backlog.scheduleDate}
        setScheduleDate={backlog.setScheduleDate}
        assignableUsers={assignableUsers}
        orgLabels={orgLabels}
        availableSprints={availableSprints}
        currentUser={currentUser}
        activeTab={activeTab}
        backlogOpen={backlogOpen}
        onClose={detail.closeTaskDetail}
        onStartEdit={detail.startDetailEdit}
        onSaveEdit={detail.saveDetailEdit}
        onCancelEdit={() => detail.setDetailEditing(false)}
        onDelete={handleDelete}
        onAddComment={async (content) => {
          try {
            const res = await addTaskComment(detail.detailTask.id, content);
            detail.setDetailComments((prev) => [...prev, res.data]);
            setTasks((prev) => prev.map((t) => t.id === detail.detailTask.id ? { ...t, comment_count: (t.comment_count || 0) + 1 } : t));
            backlog.setBacklogTasks((prev) => prev.map((t) => t.id === detail.detailTask.id ? { ...t, comment_count: (t.comment_count || 0) + 1 } : t));
          } catch { setError('Failed to add comment'); }
        }}
        onEditComment={async (commentId, content) => {
          try {
            const res = await updateTaskComment(detail.detailTask.id, commentId, content);
            detail.setDetailComments((prev) => prev.map((c) => (c.id === commentId ? res.data : c)));
          } catch { setError('Failed to update comment'); }
        }}
        onDeleteComment={detail.handleDetailDeleteComment}
        onSchedule={backlog.handleScheduleTask}
        onUnschedule={backlog.handleUnscheduleTask}
        onStatusChange={detail.handleDetailStatusChange}
        onToggleLabel={toggleLabel}
        showConfirm={showConfirm}
        closeConfirm={closeConfirm}
        fetchTasks={fetchTasks}
        fetchBacklog={backlog.fetchBacklog}
        setError={setError}
      />

      <ConfirmDialog
        isOpen={!!taskToDelete}
        title="Delete Item"
        message={`Are you sure you want to delete "${taskToDelete?.title}"? This cannot be undone.`}
        confirmText="Delete"
        isDanger
        onConfirm={confirmDeleteWithRefresh}
        onCancel={() => setTaskToDelete(null)}
      />

      <ConfirmDialog
        isOpen={confirmDialog.open}
        title={confirmDialog.title}
        message={confirmDialog.message}
        confirmText={confirmDialog.confirmText}
        isDanger={confirmDialog.isDanger}
        onConfirm={() => { if (confirmDialog.onConfirm) confirmDialog.onConfirm(); }}
        onCancel={closeConfirm}
      />
    </div>
  );
}
