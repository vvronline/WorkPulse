import React, { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  getTasks,
  updateTaskStatus,
  deleteTask,
  carryForwardTasks,
  getAssignableUsers,
  getTaskLabels,
  addTaskComment,
  updateTaskComment,
  getLocalToday,
  getTaskDetail,
  getTeamSprintConfig,
  getAvailableSprints,
  getSprintStats,
  getProjects,
} from "../api";
import { useAgileConfig } from "../AgileConfigContext";
import { SprintLifecycleControls } from "../components/agile/AgileWorkflowPanels";
import { ArrowDownCircle, ClipboardList } from "lucide-react";
import ConfirmDialog from "../components/common/ConfirmDialog";
import { useAuth } from "../AuthContext";
import { useAutoDismiss } from "../hooks/useAutoDismiss";
import "highlight.js/styles/github-dark.css";

import { COLUMNS } from "./tasks/constants";
import KanbanBoard from "./tasks/KanbanBoard";
import SprintImportPanel from "./tasks/SprintImportPanel";
import BacklogTab from "./tasks/BacklogTab";
import TasksHeader from "./tasks/TasksHeader";
import TaskDetailModal from "./tasks/TaskDetailModal";
import InlineCommentPanel from "./tasks/InlineCommentPanel";
import ServiceDeskTab from "./tasks/ServiceDeskTab";
import { TaskProvider } from "./tasks/TaskContext";

import { useConfirmDialog } from "./tasks/hooks/useConfirmDialog";
import { useFilters } from "./tasks/hooks/useFilters";
import { useGlobalSearch } from "./tasks/hooks/useGlobalSearch";
import { useComments } from "./tasks/hooks/useComments";
import { useBacklog } from "./tasks/hooks/useBacklog";
import { useTaskDetail } from "./tasks/hooks/useTaskDetail";
import { useDragDrop } from "./tasks/hooks/useDragDrop";

import s from "./Tasks.module.css";

const EMPTY: any[] = [];

export default function Tasks() {
  const { user: currentUser } = useAuth() as any;
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tasks, setTasks] = useState<any[]>([]);
  const [stats, setStats] = useState<any>({
    total: 0,
    done: 0,
    inProgress: 0,
    percent: 0,
  });
  const [loading, setLoading] = useState(true);
  const [date, setDate] = useState(() => getLocalToday());
  const [error, setError] = useAutoDismiss("") as [string, (v: string) => void];
  const [taskToDelete, setTaskToDelete] = useState<any>(null);
  const [carriedCount, setCarriedCount] = useState(0);
  const [activeTab, setActiveTab] = useState("backlog");
  const [selectedSprintId, setSelectedSprintId] = useState<any>(null);
  const [sprintImportOpen, setSprintImportOpen] = useState(false);
  const { data: assignableUsers = EMPTY } = useQuery({
    queryKey: ["tasks", "assignableUsers"],
    queryFn: async () => (await getAssignableUsers()).data as any[],
  });
  const { data: orgLabels = EMPTY } = useQuery({
    queryKey: ["tasks", "labels"],
    queryFn: async () => (await getTaskLabels()).data as any[],
  });
  // Stage 3: project list powers the "Project" picker in backlog create and
  // task edit. Active projects only — archived ones can't accept new tickets.
  const { data: availableProjects = EMPTY } = useQuery({
    queryKey: ["tasks", "projects"],
    queryFn: async () => {
      const r = await getProjects(false);
      return Array.isArray(r.data) ? (r.data as any[]) : [];
    },
  });
  // Always ask the backend — it knows about platform_admin / super_admin /
  // hr_admin who can see every team's sprints, and will correctly return []
  // for users with no team. Don't gate on currentUser.team_id: the cached
  // profile may be stale (especially in the desktop app where the renderer
  // doesn't auto-reload after a team is assigned).
  const { data: availableSprints = EMPTY } = useQuery({
    queryKey: ["tasks", "availableSprints"],
    queryFn: async () => (await getAvailableSprints()).data as any[],
  });
  const [sprintStats, setSprintStats] = useState<any>(null);
  const { unitLabel, features } = useAgileConfig() as any;
  const autoCarriedRef = useRef<string | null>(null); // stores the last date carry-forward ran

  // backlogOpen was always false — removed dead state

  const { confirmDialog, showConfirm, closeConfirm } =
    useConfirmDialog() as any;
  const filters = useFilters({ activeTab }) as any;
  const globalSearch = useGlobalSearch() as any;

  const fetchTasks = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const params: any = { ...filters.plannerFilters };
        if (activeTab === "sprint" && selectedSprintId) {
          params.sprint_id = selectedSprintId;
          const res = await getTasks(undefined as any, params, signal as any);
          setTasks((res.data as any).tasks);
          setStats((res.data as any).stats);
        } else {
          setTasks([]);
          setStats({ total: 0, done: 0, inProgress: 0, percent: 0 });
        }
        setError("");
      } catch {
        setError("Failed to load tasks");
      } finally {
        setLoading(false);
      }
    },
    [date, activeTab, selectedSprintId, filters.plannerFilters],
  );

  const backlog = useBacklog({
    activeTab,
    backlogOpen: false,
    date,
    backlogFilters: filters.backlogFilters,
    selectedSprintId,
    showConfirm,
    closeConfirm,
    fetchTasks,
    setError,
  }) as any;
  const detail = useTaskDetail({
    activeTab,
    backlogOpen: false,
    showConfirm,
    closeConfirm,
    setTasks,
    setBacklogTasks: backlog.setBacklogTasks,
    fetchTasks,
    fetchBacklog: backlog.fetchBacklog,
    setError,
  } as any) as any;
  const comments = useComments({
    showConfirm,
    closeConfirm,
    setTasks,
    setError,
  }) as any;
  const drag = useDragDrop({
    tasks,
    setTasks,
    showConfirm,
    closeConfirm,
    setError,
  }) as any;

  // Keep a valid sprint selected once the sprint list resolves: preserve the
  // current pick if it still exists, otherwise default to the active sprint
  // (or the first one).
  useEffect(() => {
    if (!availableSprints.length) return;
    setSelectedSprintId((prev: any) =>
      prev && availableSprints.some((sp) => sp.id === prev)
        ? prev
        : (availableSprints.find((sp) => sp.status === "active")?.id ??
          availableSprints[0].id),
    );
  }, [availableSprints]);

  useEffect(() => {
    const taskId = searchParams.get("task");
    const tabParam = searchParams.get("tab");
    const sprintIdParam = searchParams.get("sprint_id");

    let consumed = false;
    if (tabParam && ["backlog", "sprint", "service-desk"].includes(tabParam)) {
      setActiveTab(tabParam);
      consumed = true;
    }
    if (sprintIdParam) {
      const parsed = Number(sprintIdParam);
      setSelectedSprintId(Number.isNaN(parsed) ? sprintIdParam : parsed);
      consumed = true;
    }
    if (taskId) {
      consumed = true;
      getTaskDetail(taskId as any)
        .then((res) => detail.openTaskDetail(res.data))
        .catch(() => {});
    }
    if (consumed) setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Expose the detail-opener globally so deep-linked components (e.g. Epic
  // child-ticket links inside the task detail modal) can swap the modal
  // contents without unmounting / re-routing. Cleared on unmount so we
  // don't leak across page-reloads.
  useEffect(() => {
    (window as any).__openTaskDetail = (task: any) =>
      detail.openTaskDetail(task);
    return () => {
      try {
        delete (window as any).__openTaskDetail;
      } catch {
        /* ignore */
      }
    };
  }, [detail.openTaskDetail]);

  useEffect(() => {
    if (activeTab === "backlog") return;
    const controller = new AbortController();
    setLoading(true);
    fetchTasks(controller.signal).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [fetchTasks, activeTab]);

  useEffect(() => {
    if (!currentUser?.team_id) {
      if (activeTab === "sprint") setActiveTab("backlog");
      return;
    }
    getTeamSprintConfig(currentUser.team_id).catch(() => {
      if (activeTab === "sprint") setActiveTab("backlog");
    });
  }, [currentUser?.team_id]);

  useEffect(() => {
    const today = getLocalToday();
    if (date !== today || autoCarriedRef.current === today) return;
    autoCarriedRef.current = today;
    carryForwardTasks()
      .then((res) => {
        if ((res.data as any).carried > 0) {
          setCarriedCount((res.data as any).carried);
          fetchTasks();
          setTimeout(() => setCarriedCount(0), 4000);
        }
      })
      .catch(() => setError("Failed to carry forward tasks"));
  }, [date, fetchTasks]);

  useEffect(() => {
    if (activeTab === "backlog") backlog.fetchBacklog();
  }, [activeTab, backlog.fetchBacklog]);

  // Refresh sprint stats whenever the sprint changes or its tasks update.
  useEffect(() => {
    if (activeTab !== "sprint" || !selectedSprintId) {
      setSprintStats(null);
      return;
    }
    getSprintStats(selectedSprintId)
      .then((r) => setSprintStats(r.data))
      .catch(() => setSprintStats(null));
  }, [activeTab, selectedSprintId, tasks.length, stats.done]);

  const handleDelete = (task: any) => setTaskToDelete(task);
  const confirmDeleteWithRefresh = async () => {
    if (!taskToDelete) return;
    try {
      await deleteTask(taskToDelete.id);
      setTaskToDelete(null);
      if (comments.commentTaskId === taskToDelete.id) comments.closeComments();
      if (detail.detailTask?.id === taskToDelete.id) detail.closeTaskDetail();
      fetchTasks();
      if (activeTab === "backlog") backlog.fetchBacklog();
    } catch {
      setError("Failed to delete item");
    }
  };

  const handleToggleDone = (task: any) => {
    const newStatus = task.status === "done" ? "pending" : "done";
    const label = newStatus === "done" ? "Mark as done" : "Mark as incomplete";
    showConfirm(
      label,
      `${label}: "${task.title}"?`,
      async () => {
        closeConfirm();
        try {
          await updateTaskStatus(task.id, newStatus);
          fetchTasks();
        } catch {
          setError("Failed to update task");
        }
      },
      { confirmText: label },
    );
  };

  const handleSummaryTotal = () => {
    filters.setFiltersOpen(true);
    filters.setFilterPriority("");
    filters.setFilterStatus("");
  };
  const handleSummaryPriority = (value: string) => {
    filters.setFiltersOpen(true);
    filters.setFilterPriority((prev: string) => (prev === value ? "" : value));
  };
  const toggleLabel = (labelId: any, list: any, setter: any) => {
    setter((prev: any[]) =>
      prev.includes(labelId)
        ? prev.filter((id) => id !== labelId)
        : [...prev, labelId],
    );
  };
  const getColTasks = (colId: string) =>
    tasks.filter((t) => t.status === colId);
  const isToday = date === getLocalToday();
  const sprintMode = activeTab === "sprint";
  const summaryAllActive = !filters.filterPriority;

  return (
    <TaskProvider
      assignableUsers={assignableUsers}
      orgLabels={orgLabels}
      availableSprints={availableSprints}
      availableProjects={availableProjects}
      currentUser={currentUser}
      activeTab={activeTab}
    >
      <div className={s["tasks-page"]}>
        <TasksHeader
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          date={date}
          setDate={setDate}
          isToday={isToday}
          selectedSprintId={selectedSprintId}
          setSelectedSprintId={setSelectedSprintId}
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

        {activeTab === "sprint" && (
          <>
            <div className={s["tasks-progress-card"]}>
              <div className={s["tasks-progress-info"]}>
                <span className={s["tasks-progress-label"]}>
                  {stats.done}/{stats.total} completed
                </span>
                <span className={s["tasks-progress-pct"]}>
                  {stats.percent}%
                </span>
              </div>
              <div className={s["tasks-progress-bar"]}>
                <div
                  className={s["tasks-progress-fill"]}
                  style={
                    {
                      "--fill-width": `${stats.percent}%`,
                    } as React.CSSProperties
                  }
                />
              </div>
              <div className={s["tasks-progress-counts"]}>
                {COLUMNS.map((col: any) => (
                  <span key={col.id} style={{ color: col.color }}>
                    {col.icon} {getColTasks(col.id).length} {col.label}
                  </span>
                ))}
              </div>
              {features.storyPoints &&
                sprintStats &&
                sprintStats.totals.points > 0 && (
                  <div
                    className={s["tasks-progress-counts"]}
                    style={{ marginTop: 6, fontWeight: 600 }}
                  >
                    <span title="Story points: done / total">
                      📊 {sprintStats.totals.donePoints} /{" "}
                      {sprintStats.totals.points} {unitLabel} (
                      {sprintStats.totals.percentByPoints}%)
                    </span>
                    {sprintStats.totals.unestimatedTasks > 0 && (
                      <span style={{ color: "var(--warning, #f59e0b)" }}>
                        ⚠ {sprintStats.totals.unestimatedTasks} unestimated
                      </span>
                    )}
                    {sprintStats.totals.blockedTasks > 0 && (
                      <span style={{ color: "var(--danger, #ef4444)" }}>
                        ⛔ {sprintStats.totals.blockedTasks} blocked
                      </span>
                    )}
                  </div>
                )}
              {/* Sprint lifecycle controls (Start / Complete) — Pass 2 */}
              {(() => {
                const sp = availableSprints.find(
                  (x) => x.id === selectedSprintId,
                );
                if (!sp) return null;
                const canManageSprint = [
                  "team_lead",
                  "manager",
                  "super_admin",
                  "hr_admin",
                  "platform_admin",
                ].includes(currentUser?.role);
                return (
                  <div style={{ marginTop: 10 }}>
                    <SprintLifecycleControls
                      sprint={sp}
                      canEdit={canManageSprint}
                      onChanged={() => {
                        // Refresh the sprint list + active selection so the badge / lifecycle controls update.
                        // Also force a fresh stats fetch.
                        queryClient.invalidateQueries({
                          queryKey: ["tasks", "availableSprints"],
                        });
                        fetchTasks();
                        if (selectedSprintId) {
                          getSprintStats(selectedSprintId)
                            .then((r) => setSprintStats(r.data))
                            .catch(() => {});
                        }
                      }}
                    />
                  </div>
                );
              })()}
            </div>

            {/* The Sprint Insights link previously rendered here was removed —
              the toolbar's "Insights" button already opens the same view, so
              the inline link was redundant noise on the Sprint board. */}

            {carriedCount > 0 && (
              <div className={s["carry-banner"]}>
                <ArrowDownCircle
                  size={14}
                  style={{ marginRight: 5, verticalAlign: "middle" }}
                />
                {carriedCount} incomplete item{carriedCount > 1 ? "s" : ""} from
                yesterday carried forward automatically.
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
                onClose={() => {
                  setSprintImportOpen(false);
                  backlog.setImportConfigTask(null);
                }}
              />
            )}

            {loading ? (
              <div className="loading-spinner">
                <div className="spinner" />
              </div>
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
              <div className={s["tasks-empty"]}>
                <div className={s["tasks-empty-icon"]}>
                  <ClipboardList size={36} strokeWidth={1.5} />
                </div>
                <p>No items in this sprint</p>
                <span>Assign tickets from the Backlog to this sprint.</span>
              </div>
            )}
          </>
        )}

        {activeTab === "backlog" && (
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
            backlogStoryPoints={backlog.backlogStoryPoints}
            setBacklogStoryPoints={backlog.setBacklogStoryPoints}
            backlogWorkItemType={backlog.backlogWorkItemType}
            setBacklogWorkItemType={backlog.setBacklogWorkItemType}
            backlogProjectId={backlog.backlogProjectId}
            setBacklogProjectId={backlog.setBacklogProjectId}
            backlogLimit={backlog.backlogLimit}
            setBacklogLimit={backlog.setBacklogLimit}
            backlogOffset={backlog.backlogOffset}
            setBacklogOffset={backlog.setBacklogOffset}
            backlogTotal={backlog.backlogTotal}
            scheduleTaskId={backlog.scheduleTaskId}
            setScheduleTaskId={backlog.setScheduleTaskId}
            scheduleDate={backlog.scheduleDate}
            setScheduleDate={backlog.setScheduleDate}
            filterPriority={filters.filterPriority}
            summaryAllActive={summaryAllActive}
            error={error}
            onHandleAddBacklog={backlog.handleAddBacklog}
            onOpenDetail={detail.openTaskDetail}
            onScheduleTask={backlog.handleScheduleTask}
            onHandleSummaryTotal={handleSummaryTotal}
            onHandleSummaryPriority={handleSummaryPriority}
            onToggleLabel={toggleLabel as any}
          />
        )}

        {activeTab === "service-desk" && <ServiceDeskTab />}

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
          onClose={detail.closeTaskDetail}
          onStartEdit={detail.startDetailEdit}
          onSaveEdit={detail.saveDetailEdit}
          onCancelEdit={() => detail.setDetailEditing(false)}
          onDelete={handleDelete}
          onAddComment={detail.handleAddDetailComment}
          onEditComment={detail.handleEditDetailComment}
          onDeleteComment={detail.handleDetailDeleteComment}
          onSchedule={backlog.handleScheduleTask}
          onUnschedule={backlog.handleUnscheduleTask}
          onStatusChange={detail.handleDetailStatusChange}
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
          onConfirm={() => {
            if (confirmDialog.onConfirm) confirmDialog.onConfirm();
          }}
          onCancel={closeConfirm}
        />
      </div>
    </TaskProvider>
  );
}
