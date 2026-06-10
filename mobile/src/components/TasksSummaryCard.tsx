import { useEffect, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ClipboardList } from "lucide-react-native";
import { theme } from "../theme";
import { TASK_PRIORITY } from "../constants";
import type { TaskSummary } from "../features";

const SLIDE_INTERVAL = 4000;
const ROW_HEIGHT = 38;

/**
 * Mirrors client/src/components/dashboard/TasksSummary.tsx ("Today's Planner").
 * 4 stats (Done / In Progress / In Review / Pending), a 2-segment progress bar
 * (done + in-progress), and a rotating carousel of active tasks.
 */
export default function TasksSummaryCard({
  taskSummary,
}: {
  taskSummary: TaskSummary | null;
}) {
  const router = useRouter();
  const [slideIndex, setSlideIndex] = useState(0);
  const translateY = useRef(new Animated.Value(0)).current;

  const activeTasks = taskSummary?.activeTasks ?? [];

  useEffect(() => {
    if (activeTasks.length <= 1) return;
    setSlideIndex((prev) => (prev >= activeTasks.length ? 0 : prev));
    const id = setInterval(() => {
      setSlideIndex((prev) => (prev + 1) % activeTasks.length);
    }, SLIDE_INTERVAL);
    return () => clearInterval(id);
  }, [activeTasks.length]);

  useEffect(() => {
    Animated.timing(translateY, {
      toValue: -slideIndex * ROW_HEIGHT,
      duration: 320,
      useNativeDriver: true,
    }).start();
  }, [slideIndex, translateY]);

  if (!taskSummary || taskSummary.total === 0) return null;

  const donePct = (taskSummary.done / taskSummary.total) * 100;
  const progressPct = (taskSummary.inProgress / taskSummary.total) * 100;

  return (
    <Pressable
      style={styles.card}
      onPress={() => router.push("/tasks")}
      android_ripple={{ color: theme.surfaceHover }}
    >
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <ClipboardList size={16} color={theme.primary} />
          <Text style={styles.title}>Today&apos;s Planner</Text>
        </View>
        <Text style={styles.chevron}>›</Text>
      </View>

      {/* 4-stat row */}
      <View style={styles.statsRow}>
        <Stat label="Done" value={taskSummary.done} color={theme.success} />
        <View style={styles.statDivider} />
        <Stat label="In Progress" value={taskSummary.inProgress} color={theme.primary} />
        <View style={styles.statDivider} />
        <Stat label="In Review" value={taskSummary.inReview ?? 0} color={theme.warning} />
        <View style={styles.statDivider} />
        <Stat label="Pending" value={taskSummary.pending} color={theme.textSecondary} />
      </View>

      {/* 2-segment progress bar (done + in-progress) */}
      <View style={styles.barTrack}>
        <View
          style={[styles.barSeg, { width: `${donePct}%`, backgroundColor: theme.success }]}
        />
        <View
          style={[styles.barSeg, { width: `${progressPct}%`, backgroundColor: theme.primary }]}
        />
      </View>

      {/* Rotating active-task carousel */}
      {activeTasks.length > 0 ? (
        <View style={styles.carouselWindow}>
          <Animated.View style={{ transform: [{ translateY }] }}>
            {activeTasks.map((task, i) => {
              const pr = TASK_PRIORITY[task.priority];
              const label =
                task.status === "in_progress"
                  ? "Doing:"
                  : task.status === "in_review"
                    ? "Review:"
                    : "Next:";
              return (
                <View key={i} style={styles.carouselRow}>
                  <Text style={styles.carouselLabel}>{label}</Text>
                  <Text style={styles.carouselTitle} numberOfLines={1}>
                    {task.title}
                  </Text>
                  {pr ? (
                    <View style={[styles.prChip, { backgroundColor: pr.color + "22" }]}>
                      <Text style={[styles.prChipText, { color: pr.color }]}>
                        {pr.label}
                      </Text>
                    </View>
                  ) : null}
                </View>
              );
            })}
          </Animated.View>
        </View>
      ) : null}
    </Pressable>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusLg,
    padding: 16,
    gap: 12,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { fontSize: 15, fontWeight: "700", color: theme.text },
  chevron: { fontSize: 20, color: theme.textMuted },
  statsRow: { flexDirection: "row", alignItems: "center" },
  stat: { flex: 1, alignItems: "center", gap: 2 },
  statValue: { fontSize: 18, fontWeight: "800" },
  statLabel: {
    fontSize: 9,
    color: theme.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  statDivider: { width: 1, height: 26, backgroundColor: theme.border },
  barTrack: {
    flexDirection: "row",
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.surface,
    overflow: "hidden",
  },
  barSeg: { height: "100%" },
  carouselWindow: { height: ROW_HEIGHT, overflow: "hidden" },
  carouselRow: {
    height: ROW_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  carouselLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: theme.textMuted,
    textTransform: "uppercase",
  },
  carouselTitle: { flex: 1, fontSize: 13, color: theme.text },
  prChip: { borderRadius: theme.radiusSm, paddingHorizontal: 8, paddingVertical: 3 },
  prChipText: { fontSize: 10, fontWeight: "700", textTransform: "capitalize" },
});