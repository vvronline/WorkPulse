import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { theme } from "../../src/theme";
import { TASK_PRIORITY, TASK_STATUS } from "../../src/constants";
import {
  getSprintCycleTime,
  getSprints,
  getSprintStats,
  getSprintTasks,
  type Sprint,
  type SprintCycleTime,
  type SprintStats,
  type Task,
} from "../../src/features";
import { Dropdown } from "../../src/components/Dropdown";

const STATUS_LABEL: Record<string, string> = {
  pending: "To Do",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
};

function fmtDays(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${v} d`;
}

export default function SprintInsights() {
  const params = useLocalSearchParams<{ sprint_id?: string }>();
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(
    params.sprint_id ? Number(params.sprint_id) : null,
  );
  const [stats, setStats] = useState<SprintStats | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [cycle, setCycle] = useState<SprintCycleTime | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Fetch the sprint list once; default the selection to the deep-linked sprint
  // (when valid), else the active sprint, else the first.
  useEffect(() => {
    getSprints()
      .then((r) => {
        const list = r.data?.sprints || [];
        setSprints(list);
        setSelectedId((prev) => {
          if (prev && list.some((s) => s.id === prev)) return prev;
          const active = list.find((s) => s.status === "active");
          return active?.id ?? list[0]?.id ?? null;
        });
      })
      .catch(() => setSprints([]));
  }, []);

  const reload = useCallback(() => {
    if (!selectedId) {
      setStats(null);
      setTasks([]);
      setCycle(null);
      setLoading(false);
      setRefreshing(false);
      return;
    }
    setLoading(true);
    Promise.allSettled([
      getSprintStats(selectedId),
      getSprintTasks(selectedId),
      getSprintCycleTime(selectedId),
    ]).then(([stRes, tkRes, cyRes]) => {
      setStats(stRes.status === "fulfilled" ? stRes.value.data : null);
      setTasks(
        tkRes.status === "fulfilled" ? tkRes.value.data.tasks || [] : [],
      );
      setCycle(cyRes.status === "fulfilled" ? cyRes.value.data : null);
      setLoading(false);
      setRefreshing(false);
    });
  }, [selectedId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    reload();
  }, [reload]);

  const selectedSprint = sprints.find((s) => s.id === selectedId) || null;

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Sprint Insights" }} />
      <ScrollView
        contentContainerStyle={styles.container}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.primary}
          />
        }
      >
        <Text style={styles.subtitle}>
          Burndown, velocity, cycle time and sprint progress.
        </Text>

        {/* Sprint selector */}
        {sprints.length > 0 ? (
          <Dropdown
            label="Sprint"
            value={selectedId}
            placeholder="Select a sprint"
            onChange={(v) => setSelectedId(v == null ? null : Number(v))}
            options={sprints.map((sp) => ({
              value: sp.id,
              label: `${sp.name}${sp.status === "active" ? " ●" : ""}`,
            }))}
          />
        ) : (
          <Text style={styles.empty}>No sprints available.</Text>
        )}

        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={theme.primary} />
          </View>
        ) : !selectedId ? null : (
          <>
            {/* Summary stats */}
            {stats ? (
              <View style={styles.statGrid}>
                <StatCard
                  label="Tickets"
                  value={`${stats.totals.doneTasks}/${stats.totals.tasks}`}
                  sub={`${stats.totals.percentByTasks}% complete`}
                />
                <StatCard
                  label="Points"
                  value={`${stats.totals.donePoints}/${stats.totals.points}`}
                  sub={`${stats.totals.percentByPoints}% complete`}
                />
                <StatCard
                  label="Unestimated"
                  value={String(stats.totals.unestimatedTasks)}
                  kind={stats.totals.unestimatedTasks > 0 ? "warning" : "ok"}
                />
                <StatCard
                  label="Blocked"
                  value={String(stats.totals.blockedTasks)}
                  kind={stats.totals.blockedTasks > 0 ? "danger" : "ok"}
                />
                {selectedSprint ? (
                  <StatCard
                    label="Status"
                    value={selectedSprint.status}
                    sub={
                      selectedSprint.start_date && selectedSprint.end_date
                        ? `${selectedSprint.start_date} → ${selectedSprint.end_date}`
                        : undefined
                    }
                  />
                ) : null}
              </View>
            ) : (
              <Text style={styles.empty}>No stats for this sprint yet.</Text>
            )}

            {/* Sprint tickets */}
            <Text style={styles.sectionTitle}>Sprint Tickets</Text>
            {tasks.length === 0 ? (
              <Text style={styles.empty}>No tickets in this sprint.</Text>
            ) : (
              <View style={styles.ticketList}>
                {tasks.map((t) => {
                  const pr = TASK_PRIORITY[t.priority];
                  const stMeta = TASK_STATUS[t.status];
                  return (
                    <View key={t.id} style={styles.ticketRow}>
                      <View style={styles.ticketMain}>
                        <Text style={styles.ticketKey}>
                          {t.issue_key || `#${t.id}`}
                        </Text>
                        <Text style={styles.ticketTitle} numberOfLines={1}>
                          {t.title}
                        </Text>
                      </View>
                      <View style={styles.ticketMeta}>
                        <View
                          style={[
                            styles.statusBadge,
                            { backgroundColor: stMeta?.bg },
                          ]}
                        >
                          <Text
                            style={[
                              styles.statusBadgeText,
                              { color: stMeta?.color },
                            ]}
                          >
                            {STATUS_LABEL[t.status] || t.status}
                          </Text>
                        </View>
                        {pr ? (
                          <View
                            style={[styles.prDot, { backgroundColor: pr.color }]}
                          />
                        ) : null}
                        <Text style={styles.ticketPoints}>
                          {t.story_points != null && t.story_points !== ""
                            ? `${t.story_points} pts`
                            : "—"}
                        </Text>
                      </View>
                    </View>
                  );
                })}
              </View>
            )}

            {/* Cycle / Lead time */}
            <Text style={styles.sectionTitle}>Cycle &amp; Lead Time</Text>
            {!cycle || cycle.tasks.length === 0 ? (
              <Text style={styles.empty}>No completed tickets yet.</Text>
            ) : (
              <>
                <View style={styles.statGrid}>
                  <StatCard
                    label="Cycle (avg)"
                    value={fmtDays(cycle.cycle.avg)}
                    sub={`median ${cycle.cycle.median ?? "—"} · p90 ${cycle.cycle.p90 ?? "—"}`}
                  />
                  <StatCard
                    label="Lead (avg)"
                    value={fmtDays(cycle.lead.avg)}
                    sub={`median ${cycle.lead.median ?? "—"} · p90 ${cycle.lead.p90 ?? "—"}`}
                  />
                  <StatCard
                    label="Sampled"
                    value={String(cycle.cycle.n)}
                  />
                </View>
                <View style={styles.ticketList}>
                  {cycle.tasks.map((t) => (
                    <View key={t.id} style={styles.cycleRow}>
                      <View style={styles.ticketMain}>
                        <Text style={styles.ticketKey}>#{t.id}</Text>
                        <Text style={styles.ticketTitle} numberOfLines={1}>
                          {t.title}
                        </Text>
                      </View>
                      <View style={styles.cycleMeta}>
                        <Text style={styles.cycleStat}>
                          C {t.cycle_days ?? "—"}d
                        </Text>
                        <Text style={styles.cycleStat}>
                          L {t.lead_days ?? "—"}d
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>
              </>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function StatCard({
  label,
  value,
  sub,
  kind = "default",
}: {
  label: string;
  value: string;
  sub?: string;
  kind?: "default" | "ok" | "warning" | "danger";
}) {
  const accent =
    kind === "warning"
      ? "#f59e0b"
      : kind === "danger"
        ? theme.danger
        : kind === "ok"
          ? theme.success
          : theme.primary;
  return (
    <View style={styles.statCard}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, { color: accent }]}>{value}</Text>
      {sub ? <Text style={styles.statSub}>{sub}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  container: { padding: 16, gap: 12, paddingBottom: 40 },
  subtitle: { color: theme.textMuted, fontSize: 13 },
  center: { alignItems: "center", justifyContent: "center", paddingVertical: 40 },
  empty: { color: theme.textMuted, fontSize: 14, fontStyle: "italic", paddingVertical: 8 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: theme.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 12,
  },
  statGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  statCard: {
    flexGrow: 1,
    flexBasis: "30%",
    minWidth: 100,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radius,
    padding: 12,
    gap: 4,
  },
  statLabel: {
    fontSize: 11,
    color: theme.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    fontWeight: "600",
  },
  statValue: { fontSize: 18, fontWeight: "800" },
  statSub: { fontSize: 11, color: theme.textSecondary },
  ticketList: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radius,
    overflow: "hidden",
  },
  ticketRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  ticketMain: { flex: 1, gap: 2 },
  ticketKey: { fontSize: 11, fontWeight: "700", color: theme.primaryLight },
  ticketTitle: { fontSize: 13, color: theme.text },
  ticketMeta: { flexDirection: "row", alignItems: "center", gap: 8 },
  statusBadge: {
    borderRadius: theme.radiusSm,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  statusBadgeText: { fontSize: 10, fontWeight: "700" },
  prDot: { width: 8, height: 8, borderRadius: 4 },
  ticketPoints: { fontSize: 11, color: theme.textSecondary, minWidth: 36, textAlign: "right" },
  cycleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  cycleMeta: { flexDirection: "row", gap: 10 },
  cycleStat: { fontSize: 12, color: theme.textSecondary, fontWeight: "600" },
});