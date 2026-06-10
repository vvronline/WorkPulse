import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  CheckCircle2,
  Circle,
  Inbox,
  LifeBuoy,
  Play,
  Plus,
  Rocket,
  Square,
} from "lucide-react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { theme } from "../../src/theme";
import { taskStatusMeta, TASK_PRIORITY } from "../../src/constants";
import KanbanBoard from "../../src/components/KanbanBoard";
import ServiceDeskTab from "../../src/components/ServiceDeskTab";
import { useAuth } from "../../src/auth/AuthContext";
import {
  completeSprint,
  getAvailableSprints,
  getBacklog,
  getSprintStats,
  getSprintTasks,
  startSprint,
  updateTaskStatus,
  type Sprint,
  type SprintStats,
  type Task,
  type TaskStats,
} from "../../src/features";

type Tab = "backlog" | "sprint" | "service-desk";

const SPRINT_MANAGER_ROLES = [
  "team_lead",
  "manager",
  "super_admin",
  "hr_admin",
  "platform_admin",
];

export default function TasksScreen() {
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

  const canManageSprint = SPRINT_MANAGER_ROLES.includes(user?.role ?? "");

  const load = useCallback(async () => {
    try {
      const [bRes, spRes] = await Promise.allSettled([
        getBacklog({ assignee: "me", limit: "100" }),
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
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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
                {/* Sprint switcher */}
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.filterRow}
                >
                  {sprints.map((sp) => {
                    const active = sp.id === activeSprintId;
                    return (
                      <Pressable
                        key={sp.id}
                        style={[styles.filterChip, active && styles.filterChipActive]}
                        onPress={() => setActiveSprintId(sp.id)}
                      >
                        <Text
                          style={[styles.filterText, active && styles.filterTextActive]}
                        >
                          {sp.name}
                          {sp.status === "active" ? " ●" : ""}
                        </Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>

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
                            <Square size={14} color="#fff" />
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
      </View>
    );
  }

  /* ─── Backlog tab (default) ─── */
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
            <Text style={styles.backlogHint}>
              Unscheduled items waiting to be planned.
            </Text>
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
            <Text style={styles.emptyText}>Backlog is empty</Text>
            <Text style={styles.emptySub}>
              Create a ticket to organize work that doesn&apos;t have a scheduled date
              yet.
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

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { alignItems: "center", justifyContent: "center" },
  fab: {
    position: "absolute",
    right: 20,
    bottom: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
    elevation: 4,
  },
  list: { padding: 16, gap: 10, paddingBottom: 32 },
  heading: {
    fontSize: 24,
    fontWeight: "800",
    color: theme.text,
    letterSpacing: -0.5,
    marginBottom: 12,
  },
  tabRow: {
    flexDirection: "row",
    backgroundColor: theme.surface,
    borderRadius: theme.radiusSm,
    padding: 3,
    gap: 3,
    marginBottom: 12,
  },
  tabBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingVertical: 9,
    borderRadius: 5,
  },
  tabBtnActive: { backgroundColor: theme.primary },
  tabText: { fontSize: 12, color: theme.textSecondary, fontWeight: "600" },
  tabTextActive: { color: "#fff" },
  backlogHint: { color: theme.textMuted, fontSize: 13, marginBottom: 4 },
  filterRow: { gap: 8, paddingVertical: 4, marginBottom: 8 },
  filterChip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: theme.radiusFull,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
  },
  filterChipActive: { backgroundColor: theme.primary, borderColor: theme.primary },
  filterText: { fontSize: 13, color: theme.textSecondary, fontWeight: "500" },
  filterTextActive: { color: "#fff", fontWeight: "600" },
  progressCard: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radius,
    padding: 16,
    gap: 10,
    marginBottom: 8,
  },
  progressInfo: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  progressLabel: { color: theme.text, fontWeight: "600", fontSize: 14 },
  progressPct: { color: theme.primary, fontWeight: "800", fontSize: 16 },
  progressBar: {
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.surface,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: 4,
    backgroundColor: theme.primary,
  },
  progressPoints: { color: theme.textSecondary, fontSize: 12, fontWeight: "600" },
  lifecycleRow: { flexDirection: "row", gap: 8, marginTop: 4 },
  lifecycleBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  completeBtn: { backgroundColor: theme.success },
  lifecycleBtnText: { color: "#fff", fontWeight: "600", fontSize: 13 },
  disabled: { opacity: 0.5 },
  card: {
    flexDirection: "row",
    gap: 12,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radius,
    padding: 14,
  },
  check: { paddingTop: 1 },
  cardBody: { flex: 1, gap: 8 },
  title: { fontSize: 15, fontWeight: "600", color: theme.text, lineHeight: 20 },
  titleDone: { textDecorationLine: "line-through", color: theme.textMuted },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  badge: { borderRadius: theme.radiusSm, paddingHorizontal: 8, paddingVertical: 3 },
  badgeText: { fontSize: 11, fontWeight: "600" },
  priority: { flexDirection: "row", alignItems: "center", gap: 5 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  priorityText: { fontSize: 11, color: theme.textSecondary },
  empty: { alignItems: "center", gap: 10, paddingTop: 80, paddingHorizontal: 24 },
  emptyText: { color: theme.text, fontSize: 15, fontWeight: "600" },
  emptySub: { color: theme.textMuted, fontSize: 13, textAlign: "center" },
});