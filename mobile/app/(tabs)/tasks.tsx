import {
  useCallback,
  useEffect,
  useMemo,
  useState } from "react";
import { ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View
} from "react-native";
import {
  BarChart3,
  CheckCircle2,
  Circle,
  Download,
  Inbox,
  LifeBuoy,
  Play,
  Plus,
  Rocket,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import {
  taskStatusMeta,
  TASK_COLUMNS,
  TASK_PRIORITY,
} from "../../src/constants";
import KanbanBoard from "../../src/components/KanbanBoard";
import ServiceDeskTab from "../../src/components/ServiceDeskTab";
import { Dropdown } from "../../src/components/Dropdown";
import DatePicker from "../../src/components/DatePicker";
import { useAuth, userHasFeature } from "../../src/auth/AuthContext";
import {
  assignTaskToSprint,
  completeSprint,
  getAssignableUsers,
  getAvailableSprints,
  getBacklog,
  getSprintStats,
  getSprintTasks,
  startSprint,
  updateTaskAssignment,
  updateTaskStatus,
  type AssignableUser,
  type Sprint,
  type SprintStats,
  type Task,
  type TaskPriority,
  type TaskStats,
  type TaskStatus,
} from "../../src/features";
import { makeStyles } from "./tasks.styles";

type Tab = "backlog" | "sprint" | "service-desk";

const SPRINT_MANAGER_ROLES = [
  "team_lead",
  "manager",
  "super_admin",
  "hr_admin",
  "platform_admin",
];

const PRIORITY_FILTERS: { value: TaskPriority | ""; label: string }[] = [
  { value: "", label: "All priorities" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

const STATUS_FILTERS: { value: TaskStatus | ""; label: string }[] = [
  { value: "", label: "All statuses" },
  { value: "pending", label: "To Do" },
  { value: "in_progress", label: "In Progress" },
  { value: "in_review", label: "In Review" },
  { value: "done", label: "Done" },
];

// Whole days remaining until (and including) the sprint end date. Mirrors the
// web TasksHeader daysLeft calc — compared in UTC so DST never shifts the count.
function sprintDaysLeft(endDate?: string): number {
  if (!endDate) return 0;
  const today = new Date();
  const todayUTC = Date.UTC(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );
  const [y, m, d] = endDate.split("-").map((v) => Number(v));
  if (!y || !m || !d) return 0;
  const endUTC = Date.UTC(y, m - 1, d);
  return Math.max(0, Math.ceil((endUTC - todayUTC) / 86400000));
}

export default function TasksScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const { user } = useAuth();
  const params = useLocalSearchParams<{ tab?: string }>();
  const [tab, setTab] = useState<Tab>(
    params.tab === "sprint"
      ? "sprint"
      : params.tab === "service-desk"
        ? "service-desk"
        : "backlog",
  );
  const [backlog, setBacklog] = useState<Task[]>([]);
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [activeSprintId, setActiveSprintId] = useState<number | null>(null);
  const [sprintTasks, setSprintTasks] = useState<Task[]>([]);
  const [sprintTaskStats, setSprintTaskStats] = useState<TaskStats | null>(null);
  const [sprintStats, setSprintStats] = useState<SprintStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);

  // Backlog filters (mirror the web BacklogTab filter bar).
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterAssignee, setFilterAssignee] = useState<"me" | "all">("me");
  const [filterPriority, setFilterPriority] = useState<TaskPriority | "">("");
  const [filterStatus, setFilterStatus] = useState<TaskStatus | "">("");
  const [filterSearch, setFilterSearch] = useState("");

  // Sprint "import from backlog" panel.
  const [importOpen, setImportOpen] = useState(false);
  const [importConfigTask, setImportConfigTask] = useState<Task | null>(null);
  const [importAssignedTo, setImportAssignedTo] = useState<number | null>(null);
  const [importDueDate, setImportDueDate] = useState("");
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([]);

  const canManageSprint = SPRINT_MANAGER_ROLES.includes(user?.role ?? "");
  // Sprint Insights is an agile-plan feature (mirrors the web TasksHeader,
  // which gates the Insights link behind hasFeature("agile")).
  const agileEnabled = userHasFeature(user, "agile");

  const backlogQuery = useMemo(() => {
    const q: Record<string, string> = { limit: "100" };
    if (filterAssignee === "me") q.assignee = "me";
    if (filterPriority) q.priority = filterPriority;
    if (filterStatus) q.status = filterStatus;
    if (filterSearch.trim()) q.search = filterSearch.trim();
    return q;
  }, [filterAssignee, filterPriority, filterStatus, filterSearch]);

  const load = useCallback(async () => {
    try {
      const [bRes, spRes] = await Promise.allSettled([
        getBacklog(backlogQuery),
        getAvailableSprints(),
      ]);
      if (bRes.status === "fulfilled") setBacklog(bRes.value.data.tasks || []);
      if (spRes.status === "fulfilled") {
        const list = spRes.value.data || [];
        setSprints(list);
        setActiveSprintId((prev) => {
          if (prev && list.some((s) => s.id === prev)) return prev;
          const active = list.find((s) => s.status === "active") || list[0];
          return active?.id ?? null;
        });
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [backlogQuery]);

  useEffect(() => {
    load();
  }, [load]);

  // Assignable users power the import panel's assignee picker.
  useEffect(() => {
    getAssignableUsers()
      .then((r) => setAssignableUsers(r.data || []))
      .catch(() => {});
  }, []);

  // Load the selected sprint's tasks + stats whenever it changes.
  const reloadSprint = useCallback(() => {
    if (!activeSprintId) {
      setSprintTasks([]);
      setSprintTaskStats(null);
      setSprintStats(null);
      return;
    }
    getSprintTasks(activeSprintId)
      .then((r) => {
        setSprintTasks(r.data.tasks || []);
        setSprintTaskStats(r.data.stats || null);
      })
      .catch(() => {
        setSprintTasks([]);
        setSprintTaskStats(null);
      });
    getSprintStats(activeSprintId)
      .then((r) => setSprintStats(r.data))
      .catch(() => setSprintStats(null));
  }, [activeSprintId]);

  useEffect(() => {
    reloadSprint();
  }, [reloadSprint]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
    reloadSprint();
  }, [load, reloadSprint]);

  const toggle = useCallback(
    async (task: Task) => {
      const next = task.status === "done" ? "pending" : "done";
      setBacklog((prev) =>
        prev.map((t) => (t.id === task.id ? { ...t, status: next } : t)),
      );
      try {
        await updateTaskStatus(task.id, next);
        load();
      } catch {
        load();
      }
    },
    [load],
  );

  const activeSprint = sprints.find((s) => s.id === activeSprintId) || null;

  async function handleStartSprint() {
    if (!activeSprint) return;
    setBusy(true);
    try {
      await startSprint(activeSprint.id);
      await load();
      reloadSprint();
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to start sprint");
    } finally {
      setBusy(false);
    }
  }

  function handleCompleteSprint() {
    if (!activeSprint) return;
    Alert.alert(
      "Complete Sprint",
      `Complete "${activeSprint.name}"? Incomplete tickets will move back to the backlog.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Complete",
          style: "destructive",
          onPress: async () => {
            setBusy(true);
            try {
              await completeSprint(activeSprint.id, "backlog");
              await load();
              reloadSprint();
            } catch (e: any) {
              Alert.alert(
                "Error",
                e?.response?.data?.error || "Failed to complete sprint",
              );
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }

  // Backlog tickets that are importable into the active sprint (not already in
  // it, not done) — mirrors the web SprintImportPanel filter.
  const importableTasks = useMemo(
    () =>
      backlog.filter(
        (t) => t.sprint_id !== activeSprintId && t.status !== "done",
      ),
    [backlog, activeSprintId],
  );

  async function handleImportToSprint() {
    if (!importConfigTask || !activeSprintId) return;
    const importedId = importConfigTask.id;
    setBusy(true);
    try {
      await assignTaskToSprint(importedId, activeSprintId);
      if (importAssignedTo || importDueDate) {
        await updateTaskAssignment(importedId, {
          assigned_to: importAssignedTo ?? undefined,
          due_date: /^\d{4}-\d{2}-\d{2}$/.test(importDueDate)
            ? importDueDate
            : undefined,
        });
      }
      setImportConfigTask(null);
      setImportAssignedTo(null);
      setImportDueDate("");
      await load();
      reloadSprint();
    } catch (e: any) {
      Alert.alert(
        "Error",
        e?.response?.data?.error || "Failed to import task to sprint",
      );
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  const tabBar = (
    <View style={styles.tabRow}>
      <TabButton
        active={tab === "backlog"}
        onPress={() => setTab("backlog")}
        icon={
          <Inbox size={15} color={tab === "backlog" ? "#fff" : theme.textSecondary} />
        }
        label={`Backlog${backlog.length > 0 ? ` (${backlog.length})` : ""}`}
      />
      <TabButton
        active={tab === "sprint"}
        onPress={() => setTab("sprint")}
        icon={
          <Rocket size={15} color={tab === "sprint" ? "#fff" : theme.textSecondary} />
        }
        label="Sprint"
      />
      <TabButton
        active={tab === "service-desk"}
        onPress={() => setTab("service-desk")}
        icon={
          <LifeBuoy
            size={15}
            color={tab === "service-desk" ? "#fff" : theme.textSecondary}
          />
        }
        label="Service Desk"
      />
    </View>
  );

  /* ─── Service Desk tab ─── */
  if (tab === "service-desk") {
    return (
      <View style={styles.screen}>
        <ScrollView contentContainerStyle={styles.list}>
          <Text style={styles.heading}>Tasks</Text>
          {tabBar}
          <ServiceDeskTab />
        </ScrollView>
      </View>
    );
  }

  /* ─── Sprint tab ─── */
  if (tab === "sprint") {
    const stats = sprintTaskStats;
    const percent = stats?.percent ?? 0;
    // Per-column status counts for the progress card (○ ◐ ◑ ●).
    const statusCounts = TASK_COLUMNS.map((col) => ({
      ...col,
      count: sprintTasks.filter((t) => t.status === col.id).length,
    }));
    return (
      <View style={styles.screen}>
        <ScrollView
          contentContainerStyle={{ paddingBottom: 90 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={theme.primary}
            />
          }
        >
          <View style={styles.list}>
            <Text style={styles.heading}>Tasks</Text>
            {tabBar}

            {sprints.length === 0 ? (
              <Text style={styles.backlogHint}>
                No active sprints. Sprints appear here once your team has one.
              </Text>
            ) : (
              <>
                {/* Active sprint header — mirrors the web TasksHeader:
                    "🏃 Team — Sprint #N" + date range • days remaining. */}
                {activeSprint ? (
                  <View style={styles.sprintHeader}>
                    <Text style={styles.sprintHeaderTitle}>
                      🏃 {activeSprint.team_name || user?.team_name || "Team"} —{" "}
                      {activeSprint.name}
                    </Text>
                    <Text style={styles.sprintHeaderSub}>
                      {activeSprint.start_date && activeSprint.end_date
                        ? `${activeSprint.start_date} → ${activeSprint.end_date}` +
                          (activeSprint.status === "active"
                            ? ` • ${sprintDaysLeft(activeSprint.end_date)}d remaining`
                            : ` • ${activeSprint.status}`)
                        : activeSprint.status}
                    </Text>
                  </View>
                ) : null}

                {/* Sprint selector dropdown with active marker (like web) */}
                {sprints.length > 1 ? (
                  <Dropdown
                    label="Sprint"
                    value={activeSprintId}
                    placeholder="Select a sprint"
                    onChange={(v) =>
                      setActiveSprintId(v == null ? null : Number(v))
                    }
                    options={sprints.map((sp) => ({
                      value: sp.id,
                      label: `${sp.name}${sp.status === "active" ? " (Active)" : ""}`,
                    }))}
                  />
                ) : null}

                {/* Sprint toolbar: Insights + Import from Backlog */}
                {activeSprintId ? (
                  <View style={styles.sprintToolbar}>
                    {agileEnabled ? (
                      <Pressable
                        style={styles.toolbarBtn}
                        onPress={() =>
                          router.push({
                            pathname: "/sprints/insights",
                            params: { sprint_id: String(activeSprintId) },
                          })
                        }
                      >
                        <BarChart3 size={15} color={theme.primary} />
                        <Text style={styles.toolbarBtnText}>Insights</Text>
                      </Pressable>
                    ) : null}
                    <Pressable
                      style={[
                        styles.toolbarBtn,
                        importOpen && styles.toolbarBtnActive,
                      ]}
                      onPress={() => {
                        setImportOpen((v) => !v);
                        setImportConfigTask(null);
                      }}
                    >
                      <Download size={15} color={theme.primary} />
                      <Text style={styles.toolbarBtnText}>Import from Backlog</Text>
                    </Pressable>
                  </View>
                ) : null}

                {/* Import from Backlog panel */}
                {importOpen && activeSprintId ? (
                  <View style={styles.importPanel}>
                    <View style={styles.importHeader}>
                      <Text style={styles.importHeaderText}>
                        Import tickets from Backlog
                      </Text>
                      <Pressable
                        onPress={() => {
                          setImportOpen(false);
                          setImportConfigTask(null);
                        }}
                        hitSlop={8}
                      >
                        <X size={16} color={theme.textSecondary} />
                      </Pressable>
                    </View>
                    {importableTasks.length === 0 ? (
                      <Text style={styles.importEmpty}>
                        No backlog tickets available to import.
                      </Text>
                    ) : (
                      importableTasks.map((t) => {
                        const pr = TASK_PRIORITY[t.priority];
                        const configuring = importConfigTask?.id === t.id;
                        return (
                          <View
                            key={t.id}
                            style={[
                              styles.importItem,
                              configuring && styles.importItemActive,
                            ]}
                          >
                            <View style={styles.importItemTop}>
                              <Text style={styles.importItemKey}>
                                {t.issue_key || `#${t.id}`}
                              </Text>
                              {pr ? (
                                <View
                                  style={[
                                    styles.importPriBadge,
                                    { backgroundColor: pr.color + "22" },
                                  ]}
                                >
                                  <Text
                                    style={[styles.importPriText, { color: pr.color }]}
                                  >
                                    {pr.label}
                                  </Text>
                                </View>
                              ) : null}
                              <Text style={styles.importItemTitle} numberOfLines={1}>
                                {t.title}
                              </Text>
                              {!configuring ? (
                                <Pressable
                                  style={styles.importBtn}
                                  onPress={() => {
                                    setImportConfigTask(t);
                                    setImportAssignedTo(t.assigned_to ?? null);
                                    const sp = sprints.find(
                                      (x) => x.id === activeSprintId,
                                    );
                                    setImportDueDate(
                                      sp?.end_date || t.due_date || "",
                                    );
                                  }}
                                >
                                  <Text style={styles.importBtnText}>Import</Text>
                                </Pressable>
                              ) : null}
                            </View>

                            {configuring ? (
                              <View style={styles.importConfig}>
                                <Text style={styles.label}>Assignee</Text>
                                <Dropdown
                                  label="Assignee"
                                  value={importAssignedTo}
                                  placeholder="Unassigned"
                                  onChange={(v) =>
                                    setImportAssignedTo(
                                      v == null ? null : Number(v),
                                    )
                                  }
                                  options={[
                                    { value: null, label: "Unassigned" },
                                    ...assignableUsers.map((u) => ({
                                      value: u.id,
                                      label: u.full_name,
                                    })),
                                  ]}
                                />
                                <Text style={styles.label}>Due Date</Text>
                                <DatePicker
                                  value={importDueDate}
                                  onChange={setImportDueDate}
                                />
                                <View style={styles.importConfigActions}>
                                  <Pressable
                                    style={[
                                      styles.importConfirmBtn,
                                      busy && styles.disabled,
                                    ]}
                                    onPress={handleImportToSprint}
                                    disabled={busy}
                                  >
                                    <CheckCircle2 size={14} color="#fff" />
                                    <Text style={styles.importConfirmText}>
                                      Confirm Import
                                    </Text>
                                  </Pressable>
                                  <Pressable
                                    style={styles.importCancelBtn}
                                    onPress={() => {
                                      setImportConfigTask(null);
                                      setImportAssignedTo(null);
                                      setImportDueDate("");
                                    }}
                                  >
                                    <Text style={styles.importCancelText}>Cancel</Text>
                                  </Pressable>
                                </View>
                              </View>
                            ) : null}
                          </View>
                        );
                      })
                    )}
                  </View>
                ) : null}

                {/* Progress card */}
                {stats ? (
                  <View style={styles.progressCard}>
                    <View style={styles.progressInfo}>
                      <Text style={styles.progressLabel}>
                        {stats.done}/{stats.total} completed
                      </Text>
                      <Text style={styles.progressPct}>{percent}%</Text>
                    </View>
                    <View style={styles.progressBar}>
                      <View
                        style={[styles.progressFill, { width: `${percent}%` }]}
                      />
                    </View>

                    {/* Per-column status counts (○ To Do / ◐ In Progress / …) */}
                    <View style={styles.statusCounts}>
                      {statusCounts.map((c) => (
                        <Text
                          key={c.id}
                          style={[styles.statusCount, { color: c.color }]}
                        >
                          {c.icon} {c.count} {c.label}
                        </Text>
                      ))}
                    </View>

                    {sprintStats && sprintStats.totals.points > 0 ? (
                      <Text style={styles.progressPoints}>
                        📊 {sprintStats.totals.donePoints} /{" "}
                        {sprintStats.totals.points} pts (
                        {sprintStats.totals.percentByPoints}%)
                        {sprintStats.totals.blockedTasks > 0
                          ? `  ⛔ ${sprintStats.totals.blockedTasks} blocked`
                          : ""}
                      </Text>
                    ) : null}

                    {/* Sprint lifecycle controls */}
                    {canManageSprint && activeSprint ? (
                      <View style={styles.lifecycleRow}>
                        {activeSprint.status === "planned" ? (
                          <Pressable
                            style={[styles.lifecycleBtn, busy && styles.disabled]}
                            onPress={handleStartSprint}
                            disabled={busy}
                          >
                            <Play size={14} color="#fff" />
                            <Text style={styles.lifecycleBtnText}>Start Sprint</Text>
                          </Pressable>
                        ) : null}
                        {activeSprint.status === "active" ? (
                          <Pressable
                            style={[
                              styles.lifecycleBtn,
                              styles.completeBtn,
                              busy && styles.disabled,
                            ]}
                            onPress={handleCompleteSprint}
                            disabled={busy}
                          >
                            <CheckCircle2 size={14} color="#fff" />
                            <Text style={styles.lifecycleBtnText}>
                              Complete Sprint
                            </Text>
                          </Pressable>
                        ) : null}
                      </View>
                    ) : null}
                  </View>
                ) : null}
              </>
            )}
          </View>

          {sprints.length === 0 ? null : sprintTasks.length === 0 ? (
            <View style={styles.empty}>
              <Rocket size={40} color={theme.textMuted} />
              <Text style={styles.emptyText}>No items in this sprint</Text>
              <Text style={styles.emptySub}>
                Assign tickets from the Backlog to this sprint.
              </Text>
            </View>
          ) : (
            <KanbanBoard tasks={sprintTasks} onChanged={reloadSprint} />
          )}
        </ScrollView>

        {/* FAB: create a new ticket (defaults to backlog; importable into sprint). */}
        <Pressable
          style={styles.fab}
          onPress={() =>
            router.push({ pathname: "/tasks/new", params: { backlog: "1" } })
          }
        >
          <Plus size={24} color="#fff" />
        </Pressable>
      </View>
    );
  }

  /* ─── Backlog tab (default) ─── */
  const activeFilterCount =
    (filterAssignee === "all" ? 1 : 0) +
    (filterPriority ? 1 : 0) +
    (filterStatus ? 1 : 0) +
    (filterSearch.trim() ? 1 : 0);

  return (
    <View style={styles.screen}>
      <FlatList
        data={backlog}
        keyExtractor={(t) => String(t.id)}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.primary}
          />
        }
        ListHeaderComponent={
          <View>
            <Text style={styles.heading}>Tasks</Text>
            {tabBar}

            {/* Filter toggle row */}
            <View style={styles.backlogToolbar}>
              <Text style={styles.backlogHint}>
                Unscheduled items waiting to be planned.
              </Text>
              <Pressable
                style={[
                  styles.filterToggle,
                  (filterOpen || activeFilterCount > 0) &&
                    styles.filterToggleActive,
                ]}
                onPress={() => setFilterOpen((v) => !v)}
              >
                <SlidersHorizontal
                  size={14}
                  color={
                    filterOpen || activeFilterCount > 0
                      ? "#fff"
                      : theme.textSecondary
                  }
                />
                <Text
                  style={[
                    styles.filterToggleText,
                    (filterOpen || activeFilterCount > 0) &&
                      styles.filterToggleTextActive,
                  ]}
                >
                  Filter{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
                </Text>
              </Pressable>
            </View>

            {/* Filter panel */}
            {filterOpen ? (
              <View style={styles.filterPanel}>
                <View style={styles.searchRow}>
                  <Search size={15} color={theme.textMuted} />
                  <TextInput
                    style={styles.searchInput}
                    placeholder="Search tickets…"
                    placeholderTextColor={theme.textMuted}
                    value={filterSearch}
                    onChangeText={setFilterSearch}
                    returnKeyType="search"
                  />
                  {filterSearch ? (
                    <Pressable onPress={() => setFilterSearch("")} hitSlop={8}>
                      <X size={15} color={theme.textMuted} />
                    </Pressable>
                  ) : null}
                </View>

                <Text style={styles.label}>Assignee</Text>
                <View style={styles.segment}>
                  {(["me", "all"] as const).map((v) => {
                    const active = filterAssignee === v;
                    return (
                      <Pressable
                        key={v}
                        style={[styles.segmentBtn, active && styles.segmentBtnActive]}
                        onPress={() => setFilterAssignee(v)}
                      >
                        <Text
                          style={[
                            styles.segmentText,
                            active && styles.segmentTextActive,
                          ]}
                        >
                          {v === "me" ? "My tickets" : "All"}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                <Text style={styles.label}>Priority</Text>
                <Dropdown
                  label="Priority"
                  value={filterPriority || null}
                  placeholder="All priorities"
                  onChange={(v) =>
                    setFilterPriority((v as TaskPriority | null) ?? "")
                  }
                  options={PRIORITY_FILTERS.map((p) => ({
                    value: p.value || null,
                    label: p.label,
                  }))}
                />

                <Text style={styles.label}>Status</Text>
                <Dropdown
                  label="Status"
                  value={filterStatus || null}
                  placeholder="All statuses"
                  onChange={(v) =>
                    setFilterStatus((v as TaskStatus | null) ?? "")
                  }
                  options={STATUS_FILTERS.map((p) => ({
                    value: p.value || null,
                    label: p.label,
                  }))}
                />

                {activeFilterCount > 0 ? (
                  <Pressable
                    style={styles.clearFiltersBtn}
                    onPress={() => {
                      setFilterAssignee("me");
                      setFilterPriority("");
                      setFilterStatus("");
                      setFilterSearch("");
                    }}
                  >
                    <Text style={styles.clearFiltersText}>Clear filters</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </View>
        }
        renderItem={({ item }) => {
          const st = taskStatusMeta(item.status);
          const pr = TASK_PRIORITY[item.priority];
          const done = item.status === "done";
          return (
            <Pressable
              style={styles.card}
              onPress={() =>
                router.push({ pathname: "/tasks/[id]", params: { id: String(item.id) } })
              }
              android_ripple={{ color: theme.surfaceHover }}
            >
              <Pressable onPress={() => toggle(item)} hitSlop={8} style={styles.check}>
                {done ? (
                  <CheckCircle2 size={22} color={theme.success} />
                ) : (
                  <Circle size={22} color={theme.textMuted} />
                )}
              </Pressable>
              <View style={styles.cardBody}>
                <Text style={[styles.title, done && styles.titleDone]} numberOfLines={2}>
                  {item.issue_key ? `${item.issue_key}  ` : ""}
                  {item.title}
                </Text>
                <View style={styles.metaRow}>
                  <View style={[styles.badge, { backgroundColor: st.bg }]}>
                    <Text style={[styles.badgeText, { color: st.color }]}>
                      {st.label}
                    </Text>
                  </View>
                  {pr ? (
                    <View style={styles.priority}>
                      <View style={[styles.dot, { backgroundColor: pr.color }]} />
                      <Text style={styles.priorityText}>{pr.label}</Text>
                    </View>
                  ) : null}
                </View>
              </View>
            </Pressable>
          );
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Inbox size={40} color={theme.textMuted} />
            <Text style={styles.emptyText}>
              {activeFilterCount > 0 ? "No matching tickets" : "Backlog is empty"}
            </Text>
            <Text style={styles.emptySub}>
              {activeFilterCount > 0
                ? "Try adjusting or clearing your filters."
                : "Create a ticket to organize work that doesn't have a scheduled date yet."}
            </Text>
          </View>
        }
      />
      <Pressable
        style={styles.fab}
        onPress={() =>
          router.push({ pathname: "/tasks/new", params: { backlog: "1" } })
        }
      >
        <Plus size={24} color="#fff" />
      </Pressable>
    </View>
  );
}

function TabButton({
  active,
  onPress,
  icon,
  label,
}: {
  active: boolean;
  onPress: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <Pressable
      style={[styles.tabBtn, active && styles.tabBtnActive]}
      onPress={onPress}
    >
      {icon}
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
    </Pressable>
  );
}
