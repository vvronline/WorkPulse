import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dimensions,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { theme } from "../theme";
import { TASK_PRIORITY, TASK_STATUS } from "../constants";
import {
  getAgileConfig,
  updateTaskStatus,
  type Task,
  type TaskStatus,
  type WorkflowState,
} from "../features";

const DEFAULT_COLUMNS: { key: TaskStatus; name: string; color: string }[] = [
  { key: "pending", name: "To Do", color: TASK_STATUS.pending.color },
  { key: "in_progress", name: "In Progress", color: TASK_STATUS.in_progress.color },
  { key: "in_review", name: "In Review", color: TASK_STATUS.in_review.color },
  { key: "done", name: "Done", color: TASK_STATUS.done.color },
];

const COLUMN_WIDTH = Math.min(300, Dimensions.get("window").width * 0.8);
const COLUMN_GAP = 12;

type Col = { key: string; name: string; color: string; wip_limit?: number | null };

/**
 * Horizontal Kanban board with long-press drag-and-drop (mirrors the web board).
 * - Columns come from the tenant's agile workflow states (falls back to the 4
 *   defaults). WIP limits are surfaced like the web.
 * - Long-press a card to pick it up, drag it over another column, release to
 *   change its status. ‹ › arrows remain as an accessibility fallback.
 */
export default function KanbanBoard({
  tasks,
  onChanged,
}: {
  tasks: Task[];
  onChanged: () => void;
}) {
  const router = useRouter();
  const [columns, setColumns] = useState<Col[]>(DEFAULT_COLUMNS);
  const [wipLimits, setWipLimits] = useState(false);
  // Column screen x-ranges for hit-testing during drag.
  const colRanges = useRef<{ key: string; x: number; width: number }[]>([]);
  const scrollX = useRef(0);

  useEffect(() => {
    getAgileConfig()
      .then((r) => {
        const states = (r.data.workflowStates || []).filter(Boolean);
        if (states.length > 0) {
          setColumns(
            states
              .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))
              .map((s: WorkflowState) => ({
                key: s.key || String(s.id),
                name: s.name,
                color: s.color || theme.primary,
                wip_limit: s.wip_limit,
              })),
          );
        }
        setWipLimits(!!r.data.features?.wipLimits);
      })
      .catch(() => {
        /* keep defaults */
      });
  }, []);

  const keys = useMemo(() => columns.map((c) => c.key), [columns]);

  const grouped = useMemo(() => {
    const g: Record<string, Task[]> = {};
    for (const c of columns) g[c.key] = [];
    for (const t of tasks) {
      (g[t.status] ?? (g[keys[0]] ||= [])).push(t);
    }
    return g;
  }, [tasks, columns, keys]);

  async function moveTo(task: Task, statusKey: string) {
    if (task.status === statusKey) return;
    try {
      await updateTaskStatus(task.id, statusKey as TaskStatus);
      onChanged();
    } catch {
      /* ignore */
    }
  }

  function moveArrow(task: Task, dir: -1 | 1) {
    const idx = keys.indexOf(task.status);
    const nextIdx = idx + dir;
    if (nextIdx < 0 || nextIdx >= keys.length) return;
    moveTo(task, keys[nextIdx]);
  }

  // Resolve which column an absolute screen-x falls into.
  function columnAtX(absX: number): string | null {
    for (const r of colRanges.current) {
      if (absX >= r.x && absX <= r.x + r.width) return r.key;
    }
    return null;
  }

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.board}
      scrollEventThrottle={16}
      onScroll={(e) => {
        scrollX.current = e.nativeEvent.contentOffset.x;
      }}
    >
      {columns.map((col, ci) => {
        const items = grouped[col.key] || [];
        const wipExceeded = !!(
          wipLimits &&
          col.wip_limit &&
          items.length > col.wip_limit
        );
        return (
          <View
            key={col.key}
            style={[styles.column, wipExceeded && styles.wipExceeded]}
            onLayout={(e) => {
              // Store absolute x of each column for drag hit-testing.
              e.target.measure?.((_x, _y, width, _h, pageX) => {
                colRanges.current[ci] = { key: col.key, x: pageX, width };
              });
            }}
          >
            <View style={styles.colHeader}>
              <View style={[styles.colDot, { backgroundColor: col.color }]} />
              <Text style={styles.colTitle}>{col.name}</Text>
              <View style={styles.colCount}>
                <Text style={styles.colCountText}>
                  {items.length}
                  {wipLimits && col.wip_limit ? ` / ${col.wip_limit}` : ""}
                </Text>
              </View>
            </View>
            <ScrollView
              style={styles.colScroll}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.colBody}
            >
              {items.length === 0 ? (
                <Text style={styles.colEmpty}>No tasks</Text>
              ) : (
                items.map((t) => (
                  <DraggableCard
                    key={t.id}
                    task={t}
                    isFirst={keys.indexOf(t.status) === 0}
                    isLast={keys.indexOf(t.status) === keys.length - 1}
                    onOpen={() =>
                      router.push({
                        pathname: "/tasks/[id]",
                        params: { id: String(t.id) },
                      })
                    }
                    onArrow={(dir) => moveArrow(t, dir)}
                    onDrop={(absX) => {
                      const target = columnAtX(absX);
                      if (target) moveTo(t, target);
                    }}
                  />
                ))
              )}
            </ScrollView>
          </View>
        );
      })}
    </ScrollView>
  );
}

function DraggableCard({
  task,
  isFirst,
  isLast,
  onOpen,
  onArrow,
  onDrop,
}: {
  task: Task;
  isFirst: boolean;
  isLast: boolean;
  onOpen: () => void;
  onArrow: (dir: -1 | 1) => void;
  onDrop: (absX: number) => void;
}) {
  const pr = TASK_PRIORITY[task.priority];
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const dragging = useSharedValue(0);

  const pan = Gesture.Pan()
    .activateAfterLongPress(220)
    .onStart(() => {
      dragging.value = 1;
    })
    .onUpdate((e) => {
      tx.value = e.translationX;
      ty.value = e.translationY;
    })
    .onEnd((e) => {
      runOnJS(onDrop)(e.absoluteX);
    })
    .onFinalize(() => {
      tx.value = withSpring(0);
      ty.value = withSpring(0);
      dragging.value = 0;
    });

  const tap = Gesture.Tap().maxDuration(220).onEnd(() => {
    runOnJS(onOpen)();
  });

  const composed = Gesture.Simultaneous(tap, pan);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }],
    zIndex: dragging.value ? 999 : 0,
    elevation: dragging.value ? 8 : 0,
    opacity: dragging.value ? 0.92 : 1,
    borderColor: dragging.value ? theme.primary : theme.glassBorder,
  }));

  return (
    <GestureDetector gesture={composed}>
      <Animated.View style={[styles.card, animStyle]}>
        {task.issue_key ? (
          <Text style={styles.cardKey}>{task.issue_key}</Text>
        ) : null}
        <Text style={styles.cardTitle} numberOfLines={3}>
          {task.title}
        </Text>
        <View style={styles.cardFooter}>
          {pr ? (
            <View style={styles.priority}>
              <View style={[styles.prDot, { backgroundColor: pr.color }]} />
              <Text style={styles.prText}>{pr.label}</Text>
            </View>
          ) : (
            <View />
          )}
          <View style={styles.moveBtns}>
            <Pressable
              style={[styles.moveBtn, isFirst && styles.moveDisabled]}
              onPress={() => onArrow(-1)}
              disabled={isFirst}
              hitSlop={6}
            >
              <ChevronLeft size={16} color={theme.textSecondary} />
            </Pressable>
            <Pressable
              style={[styles.moveBtn, isLast && styles.moveDisabled]}
              onPress={() => onArrow(1)}
              disabled={isLast}
              hitSlop={6}
            >
              <ChevronRight size={16} color={theme.textSecondary} />
            </Pressable>
          </View>
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  board: { gap: COLUMN_GAP, paddingHorizontal: 16, paddingBottom: 16 },
  column: {
    width: COLUMN_WIDTH,
    backgroundColor: theme.bgSecondary,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    maxHeight: 560,
  },
  wipExceeded: { borderColor: theme.danger },
  colHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  colDot: { width: 8, height: 8, borderRadius: 4 },
  colTitle: { flex: 1, fontSize: 14, fontWeight: "700", color: theme.text },
  colCount: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: theme.surface,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  colCountText: { fontSize: 12, color: theme.textSecondary, fontWeight: "600" },
  colScroll: { flexGrow: 0 },
  colBody: { padding: 10, gap: 10 },
  colEmpty: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: "center",
    paddingVertical: 16,
  },
  card: {
    backgroundColor: theme.glass,
    borderRadius: theme.radiusSm,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    padding: 12,
    gap: 6,
  },
  cardKey: { fontSize: 11, fontWeight: "700", color: theme.primaryLight },
  cardTitle: { fontSize: 14, color: theme.text, lineHeight: 19 },
  cardFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 2,
  },
  priority: { flexDirection: "row", alignItems: "center", gap: 5 },
  prDot: { width: 8, height: 8, borderRadius: 4 },
  prText: { fontSize: 11, color: theme.textSecondary },
  moveBtns: { flexDirection: "row", gap: 4 },
  moveBtn: {
    width: 28,
    height: 28,
    borderRadius: 6,
    backgroundColor: theme.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  moveDisabled: { opacity: 0.3 },
});