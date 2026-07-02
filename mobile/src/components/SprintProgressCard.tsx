import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Inbox, Zap } from "lucide-react-native";
import type { Theme } from "../theme";
import { useTheme } from "../theme/ThemeProvider";
import { useAuth, userHasFeature } from "../auth/AuthContext";
import {
  getActiveSprint,
  getBacklog,
  getSprintTasksFull,
  type Sprint,
  type Task,
} from "../features";

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

export default function SprintProgressCard() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const { user } = useAuth();
  const [sprint, setSprint] = useState<Sprint | null>(null);
  const [tasks, setTasks] = useState<(Task & { assigned_to?: number })[]>([]);
  const [backlog, setBacklog] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [noSprint, setNoSprint] = useState(false);

  // "Agile & Sprints" plan gating: when the feature is off for the tenant,
  // skip the (403-gated) active-sprint lookup entirely and render the
  // backlog fallback view — mirrors the Tasks screen which hides its
  // Sprint tab under the same flag.
  const agileEnabled = userHasFeature(user, "agile");

  const loadBacklogFallback = useCallback(async () => {
    setNoSprint(true);
    setSprint(null);
    try {
      const bl = await getBacklog({ assignee: "me" });
      const my = (bl.data.tasks || [])
        .filter((t) => t.status !== "done")
        .sort(
          (a, b) =>
            (PRIORITY_ORDER[a.priority] ?? 3) -
            (PRIORITY_ORDER[b.priority] ?? 3),
        )
        .slice(0, 5);
      setBacklog(my);
    } catch {
      /* ignore */
    }
  }, []);

  const load = useCallback(async () => {
    try {
      if (!agileEnabled) {
        await loadBacklogFallback();
        return;
      }
      const { data } = await getActiveSprint();
      if (!data.sprint) {
        await loadBacklogFallback();
        return;
      }
      setNoSprint(false);
      setSprint(data.sprint);
      const tr = await getSprintTasksFull(data.sprint.id);
      setTasks(tr.data.tasks || []);
    } catch (e: any) {
      // Mid-session feature toggle: the endpoint 403s once the override lands
      // server-side — degrade to the backlog view instead of a broken card.
      if (e?.response?.status === 403) await loadBacklogFallback();
      else setNoSprint(true);
    } finally {
      setLoading(false);
    }
  }, [agileEnabled, loadBacklogFallback]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <View style={styles.card}>
        <View style={styles.skeleton} />
      </View>
    );
  }

  if (noSprint) {
    return (
      <Pressable
        style={({ pressed }) => [styles.card, pressed && { opacity: 0.6 }]}
        onPress={() => router.push({ pathname: "/tasks", params: { tab: "backlog" } })}
      >
        <View style={styles.header}>
          <View style={styles.titleRow}>
            <Inbox size={16} color={theme.primary} />
            <Text style={styles.title}>Backlog</Text>
            {backlog.length > 0 ? (
              <View style={styles.countBadge}>
                <Text style={styles.countText}>{backlog.length}</Text>
              </View>
            ) : null}
          </View>
          <Text style={styles.chevron}>›</Text>
        </View>
        {backlog.length === 0 ? (
          <Text style={styles.muted}>No backlog tickets assigned to you.</Text>
        ) : (
          backlog.map((t) => (
            <View key={t.id} style={styles.taskRow}>
              <View
                style={[
                  styles.dot,
                  {
                    backgroundColor:
                      t.priority === "high"
                        ? theme.danger
                        : t.priority === "medium"
                          ? theme.warning
                          : theme.success,
                  },
                ]}
              />
              <Text style={styles.taskTitle} numberOfLines={1}>
                {t.title}
              </Text>
            </View>
          ))
        )}
      </Pressable>
    );
  }

  if (!sprint) return null;

  const start = sprint.start_date ? new Date(sprint.start_date) : new Date();
  const end = sprint.end_date ? new Date(sprint.end_date) : new Date();
  const now = new Date();
  const totalDays = Math.max(
    1,
    Math.ceil((end.getTime() - start.getTime()) / 86400000),
  );
  const elapsedDays = Math.min(
    totalDays,
    Math.max(0, Math.ceil((now.getTime() - start.getTime()) / 86400000)),
  );
  const timelinePct = Math.min(100, (elapsedDays / totalDays) * 100);

  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "done").length;
  const completionPct = total > 0 ? Math.round((done / total) * 100) : 0;

  const myTasks = tasks.filter((t) => t.assigned_to === user?.id);
  const myDone = myTasks.filter((t) => t.status === "done").length;

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.6 }]}
      onPress={() =>
        router.push({ pathname: "/tasks", params: { tab: "sprint" } })
      }
    >
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Zap size={16} color={theme.primary} />
          <Text style={styles.title} numberOfLines={1}>
            {sprint.name}
          </Text>
        </View>
        <Text style={styles.chevron}>›</Text>
      </View>

      <View style={styles.timelineLabel}>
        <Text style={styles.muted}>
          Day {elapsedDays} of {totalDays}
        </Text>
        <Text style={styles.timelinePct}>{Math.round(timelinePct)}%</Text>
      </View>
      <View style={styles.barTrack}>
        <View
          style={[
            styles.barFill,
            { width: `${timelinePct}%`, backgroundColor: theme.warning },
          ]}
        />
      </View>

      <View style={styles.statsRow}>
        <Stat label="Tasks Done" value={`${done}/${total}`} />
        <View style={styles.statDivider} />
        <Stat label="Complete" value={`${completionPct}%`} />
        <View style={styles.statDivider} />
        <Stat label="My Tasks" value={`${myDone}/${myTasks.length}`} highlight />
      </View>

      <View style={styles.barTrack}>
        <View style={[styles.barFill, { width: `${completionPct}%` }]} />
      </View>
    </Pressable>
  );
}

function Stat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, highlight && { color: theme.primaryLight }]}>
        {value}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
  card: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusLg,
    padding: 16,
    gap: 10,
  },
  skeleton: {
    height: 60,
    borderRadius: theme.radius,
    backgroundColor: theme.surface,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1 },
  title: { fontSize: 15, fontWeight: "700", color: theme.text, flexShrink: 1 },
  chevron: { fontSize: 20, color: theme.textMuted },
  countBadge: {
    backgroundColor: theme.primaryGlow,
    borderRadius: theme.radiusFull,
    paddingHorizontal: 8,
    paddingVertical: 1,
  },
  countText: { color: theme.primaryLight, fontSize: 11, fontWeight: "700" },
  muted: { color: theme.textMuted, fontSize: 13 },
  timelineLabel: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  timelinePct: { fontSize: 12, color: theme.textSecondary, fontWeight: "600" },
  barTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.surface,
    overflow: "hidden",
  },
  barFill: { height: "100%", borderRadius: 4, backgroundColor: theme.primary },
  statsRow: { flexDirection: "row", alignItems: "center" },
  stat: { flex: 1, alignItems: "center", gap: 2 },
  statValue: { fontSize: 16, fontWeight: "800", color: theme.text },
  statLabel: {
    fontSize: 9,
    color: theme.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  statDivider: { width: 1, height: 26, backgroundColor: theme.border },
  taskRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  taskTitle: { flex: 1, fontSize: 13, color: theme.textSecondary },
});