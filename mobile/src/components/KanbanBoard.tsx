import { useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type View as RNView,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
import {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  MessageSquare,
} from "../icons";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import type { Theme } from "../theme";
import { useTheme } from "../theme/ThemeProvider";
import { TASK_PRIORITY, TASK_STATUS } from "../constants";
import {
  getAgileConfig,
  updateTaskStatus,
  type Task,
  type TaskStatus,
  type WorkflowState,
  type WorkItemType,
} from "../features";

const DEFAULT_COLUMNS: { key: TaskStatus; name: string; color: string }[] = [
  { key: "pending", name: "To Do", color: TASK_STATUS.pending.color },
  { key: "in_progress", name: "In Progress", color: TASK_STATUS.in_progress.color },
  { key: "in_review", name: "In Review", color: TASK_STATUS.in_review.color },
  { key: "done", name: "Done", color: TASK_STATUS.done.color },
];

type Col = { key: string; name: string; color: string; wip_limit?: number | null };

/**
 * Vertical Kanban board: columns are stacked one below another (mirrors the web
 * mobile view). Each card shows the full ticket metadata — issue key, work-item
 * type, story points, blocked status, priority, labels, assignee, due date and
 * comment count. Long-press a card to pick it up and drag it onto another
 * column to change its status; ▲ ▼ arrows remain as an accessibility fallback.
 */
export default function KanbanBoard({
  tasks,
  onChanged,
}: {
  tasks: Task[];
  onChanged: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const [columns, setColumns] = useState<Col[]>(DEFAULT_COLUMNS);
  const [wipLimits, setWipLimits] = useState(false);
  const [typeMap, setTypeMap] = useState<Record<string, WorkItemType>>({});
  const [storyPointsEnabled, setStoryPointsEnabled] = useState(true);
  // Which column is currently under the dragged card (for highlight).
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // Column screen y-ranges for hit-testing during drag.
  const colRanges = useRef<{ key: string; y: number; height: number }[]>([]);
  // Refs to each column View so we can re-measure their window position at the
  // start of every drag — `measureInWindow` is reliable on web, unlike
  // measuring inside onLayout which often returns stale/empty values there.
  const colRefs = useRef<Record<string, RNView | null>>({});

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
        const types = (r.data.workItemTypes || []).filter(Boolean);
        const map: Record<string, WorkItemType> = {};
        for (const t of types) {
          map[String(t.id)] = t;
          if (t.key) map[String(t.key)] = t;
        }
        setTypeMap(map);
        setWipLimits(!!r.data.features?.wipLimits);
        setStoryPointsEnabled(r.data.features?.storyPoints !== false);
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

  // Re-measure every column's window rect. Called when a drag begins so the
  // hit-test ranges are always fresh (accounts for scroll position, layout
  // shifts, and works on web where onLayout measuring is unreliable).
  function measureColumns() {
    const next: { key: string; y: number; height: number }[] = [];
    for (const c of columns) {
      const node = colRefs.current[c.key];
      if (!node?.measureInWindow) continue;
      node.measureInWindow((_x, y, _w, height) => {
        // Replace any existing entry for this key, then keep sorted by y.
        const idx = next.findIndex((r) => r.key === c.key);
        const entry = { key: c.key, y, height };
        if (idx >= 0) next[idx] = entry;
        else next.push(entry);
        colRanges.current = next;
      });
    }
  }

  // Resolve which column an absolute screen-y falls into.
  function columnAtY(absY: number): string | null {
    for (const r of colRanges.current) {
      if (absY >= r.y && absY <= r.y + r.height) return r.key;
    }
    return null;
  }

  return (
    <View style={styles.board}>
      {columns.map((col) => {
        const items = grouped[col.key] || [];
        const wipExceeded = !!(
          wipLimits &&
          col.wip_limit &&
          items.length > col.wip_limit
        );
        return (
          <View
            key={col.key}
            ref={(node) => {
              colRefs.current[col.key] = node;
            }}
            style={[
              styles.column,
              wipExceeded && styles.wipExceeded,
              dropTarget === col.key && styles.dropTarget,
            ]}
            onLayout={() => measureColumns()}
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
            <View style={styles.colBody}>
              {items.length === 0 ? (
                <Text style={styles.colEmpty}>No tasks</Text>
              ) : (
                items.map((t) => (
                  <DraggableCard
                    key={t.id}
                    task={t}
                    typeMap={typeMap}
                    storyPointsEnabled={storyPointsEnabled}
                    isFirst={keys.indexOf(t.status) === 0}
                    isLast={keys.indexOf(t.status) === keys.length - 1}
                    onOpen={() =>
                      router.push({
                        pathname: "/tasks/[id]",
                        params: { id: String(t.id) },
                      })
                    }
                    onComment={() =>
                      router.push({
                        pathname: "/tasks/[id]",
                        params: { id: String(t.id), focus: "comments" },
                      })
                    }
                    onArrow={(dir) => moveArrow(t, dir)}
                    onDragBegin={() => measureColumns()}
                    onDragMove={(absY) => setDropTarget(columnAtY(absY))}
                    onDrop={(absY) => {
                      const target = columnAtY(absY);
                      setDropTarget(null);
                      if (target) moveTo(t, target);
                    }}
                  />
                ))
              )}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function formatPoints(value: number | string | null | undefined): string {
  if (value == null || value === "") return "";
  const num = typeof value === "number" ? value : parseFloat(value);
  if (Number.isNaN(num)) return String(value);
  if (Number.isInteger(num)) return String(num);
  return num.toFixed(2).replace(/\.?0+$/, "");
}

function formatDueDate(due?: string | null): string {
  if (!due) return "";
  const d = new Date(due);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function DraggableCard({
  task,
  typeMap,
  storyPointsEnabled,
  isFirst,
  isLast,
  onOpen,
  onComment,
  onArrow,
  onDragBegin,
  onDragMove,
  onDrop,
}: {
  task: Task;
  typeMap: Record<string, WorkItemType>;
  storyPointsEnabled: boolean;
  isFirst: boolean;
  isLast: boolean;
  onOpen: () => void;
  onComment: () => void;
  onArrow: (dir: -1 | 1) => void;
  onDragBegin: () => void;
  onDragMove: (absY: number) => void;
  onDrop: (absY: number) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const pr = TASK_PRIORITY[task.priority];
  // Issue key chip — falls back to "#id" when the ticket has no project key
  // (mirrors the web TaskCard). Tap to copy to the clipboard.
  const issueKey = task.issue_key || `#${task.id}`;
  const [copied, setCopied] = useState(false);

  async function copyKey() {
    try {
      await Clipboard.setStringAsync(issueKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }
  const wit = task.work_item_type_id != null
    ? typeMap[String(task.work_item_type_id)]
    : undefined;
  const points = storyPointsEnabled ? formatPoints(task.story_points) : "";
  const due = formatDueDate(task.due_date);
  const assigneeName =
    task.assignee?.full_name || task.assignee?.username || "";
  const labels = task.labels || [];

  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const dragging = useSharedValue(0);

  const pan = Gesture.Pan()
    .activateAfterLongPress(220)
    .onStart(() => {
      dragging.value = 1;
      runOnJS(onDragBegin)();
    })
    .onUpdate((e) => {
      tx.value = e.translationX;
      ty.value = e.translationY;
      runOnJS(onDragMove)(e.absoluteY);
    })
    .onEnd((e) => {
      runOnJS(onDrop)(e.absoluteY);
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
        {/* Top row: issue-key copy chip (left) + actions (right) */}
        <View style={styles.cardTopRow}>
          <Pressable
            style={styles.keyChip}
            onPress={copyKey}
            hitSlop={6}
          >
            {copied ? (
              <Check size={11} color={theme.success} />
            ) : (
              <Copy size={11} color={theme.primaryLight} />
            )}
            <Text style={styles.keyChipText}>{issueKey}</Text>
          </Pressable>
          <Pressable
            style={styles.commentBtn}
            onPress={onComment}
            hitSlop={6}
          >
            <MessageSquare size={13} color={theme.textSecondary} />
            {task.comment_count && task.comment_count > 0 ? (
              <Text style={styles.commentBtnText}>{task.comment_count}</Text>
            ) : null}
          </Pressable>
        </View>

        {/* Header badges row */}
        <View style={styles.badgeRow}>
          {wit ? (
            <View
              style={[
                styles.witBadge,
                { borderColor: (wit.color || theme.primary) + "66" },
              ]}
            >
              <View
                style={[
                  styles.witDot,
                  { backgroundColor: wit.color || theme.primary },
                ]}
              />
              <Text style={styles.witText}>{wit.name}</Text>
            </View>
          ) : null}
          {points ? (
            <View style={styles.spBadge}>
              <Text style={styles.spText}>{points}</Text>
            </View>
          ) : null}
          {task.is_blocked ? (
            <View style={styles.blockedBadge}>
              <Text style={styles.blockedText}>⛔ Blocked</Text>
            </View>
          ) : null}
        </View>

        <Text style={styles.cardTitle} numberOfLines={3}>
          {task.title}
        </Text>

        {/* Labels */}
        {labels.length > 0 ? (
          <View style={styles.labelRow}>
            {labels.map((l) => (
              <View
                key={l.id}
                style={[
                  styles.labelPill,
                  { backgroundColor: (l.color || theme.primary) + "22" },
                ]}
              >
                <Text
                  style={[styles.labelPillText, { color: l.color || theme.primary }]}
                  numberOfLines={1}
                >
                  {l.name}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        {/* Meta footer */}
        <View style={styles.metaRow}>
          {assigneeName ? (
            <View style={styles.metaChip}>
              <View style={styles.avatarPlaceholder}>
                <Text style={styles.avatarText}>
                  {assigneeName[0]?.toUpperCase()}
                </Text>
              </View>
              <Text style={styles.metaText} numberOfLines={1}>
                {assigneeName}
              </Text>
            </View>
          ) : null}
          {due ? (
            <View style={styles.metaChip}>
              <CalendarDays size={11} color={theme.textMuted} />
              <Text style={styles.metaText}>{due}</Text>
            </View>
          ) : null}
        </View>

        {/* Priority + move controls */}
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
              <ChevronUp size={16} color={theme.textSecondary} />
            </Pressable>
            <Pressable
              style={[styles.moveBtn, isLast && styles.moveDisabled]}
              onPress={() => onArrow(1)}
              disabled={isLast}
              hitSlop={6}
            >
              <ChevronDown size={16} color={theme.textSecondary} />
            </Pressable>
          </View>
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
  board: { gap: 14, paddingHorizontal: 16, paddingBottom: 16 },
  column: {
    backgroundColor: theme.bgSecondary,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.glassBorder,
  },
  wipExceeded: { borderColor: theme.danger },
  dropTarget: {
    borderColor: theme.primary,
    backgroundColor: theme.primaryGlow,
  },
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
    gap: 7,
  },
  cardTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  keyChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: theme.surface,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  keyChipText: { fontSize: 11, fontWeight: "700", color: theme.primaryLight },
  commentBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: theme.surface,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  commentBtnText: { fontSize: 11, fontWeight: "600", color: theme.textSecondary },
  badgeRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
  witBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderRadius: theme.radiusFull,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  witDot: { width: 7, height: 7, borderRadius: 4 },
  witText: { fontSize: 10, fontWeight: "600", color: theme.textSecondary },
  spBadge: {
    backgroundColor: theme.surface,
    borderRadius: theme.radiusFull,
    minWidth: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  spText: { fontSize: 11, fontWeight: "700", color: theme.text },
  blockedBadge: {
    backgroundColor: "rgba(224,62,62,0.15)",
    borderRadius: theme.radiusFull,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  blockedText: { fontSize: 10, fontWeight: "700", color: theme.danger },
  cardTitle: { fontSize: 14, color: theme.text, lineHeight: 19 },
  labelRow: { flexDirection: "row", flexWrap: "wrap", gap: 5 },
  labelPill: {
    borderRadius: theme.radiusFull,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  labelPillText: { fontSize: 10, fontWeight: "600" },
  metaRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 },
  metaChip: { flexDirection: "row", alignItems: "center", gap: 4 },
  avatarPlaceholder: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontSize: 9, fontWeight: "700", color: "#fff" },
  metaText: { fontSize: 11, color: theme.textSecondary },
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