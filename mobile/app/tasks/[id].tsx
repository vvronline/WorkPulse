import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import {
  CalendarPlus,
  CalendarX,
  Check,
  Pencil,
  Send,
  Trash2,
  X,
} from "lucide-react-native";
import { theme } from "../../src/theme";
import { taskStatusMeta, TASK_STATUS, TASK_PRIORITY } from "../../src/constants";
import {
  addTaskComment,
  deleteTask,
  getTaskDetail,
  getTaskHistory,
  scheduleTask,
  unscheduleTask,
  updateTaskFull,
  updateTaskStatus,
  type Task,
  type TaskComment,
  type TaskHistoryEntry,
  type TaskPriority,
  type TaskStatus,
} from "../../src/features";

const STATUSES: TaskStatus[] = ["pending", "in_progress", "in_review", "done"];
const PRIORITIES: TaskPriority[] = ["low", "medium", "high"];

function timeAgo(iso: string) {
  const then = new Date(iso).getTime();
  if (isNaN(then)) return "";
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function TaskDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const taskId = Number(id);
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [task, setTask] = useState<(Task & { comments?: TaskComment[] }) | null>(null);
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [saving, setSaving] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [posting, setPosting] = useState(false);
  const [detailTab, setDetailTab] = useState<"comments" | "history">("comments");
  const [history, setHistory] = useState<TaskHistoryEntry[]>([]);
  const [scheduling, setScheduling] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await getTaskDetail(taskId);
      setTask(data);
      setComments(data.comments || []);
      setTitle(data.title);
      setDescription(data.description || "");
      setPriority(data.priority);
    } catch {
      Alert.alert("Error", "Failed to load task");
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (detailTab !== "history") return;
    getTaskHistory(taskId)
      .then((r) => setHistory(r.data || []))
      .catch(() => setHistory([]));
  }, [detailTab, taskId]);

  async function handleSchedule() {
    // Schedule to today by default; web uses a date picker — mobile keeps it
    // simple with a today/clear toggle.
    const today = new Date().toISOString().slice(0, 10);
    setScheduling(true);
    try {
      await scheduleTask(taskId, today);
      await load();
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to schedule task");
    } finally {
      setScheduling(false);
    }
  }

  async function handleUnschedule() {
    setScheduling(true);
    try {
      await unscheduleTask(taskId);
      await load();
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to move to backlog");
    } finally {
      setScheduling(false);
    }
  }

  async function changeStatus(status: TaskStatus) {
    if (!task || task.status === status) return;
    setTask({ ...task, status });
    try {
      await updateTaskStatus(taskId, status);
    } catch {
      load();
    }
  }

  async function saveEdits() {
    setSaving(true);
    try {
      await updateTaskFull(taskId, {
        title: title.trim(),
        description: description.trim(),
        priority,
      });
      setEditing(false);
      load();
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  function confirmDelete() {
    Alert.alert("Delete Task", `Delete "${task?.title}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await deleteTask(taskId);
            router.back();
          } catch (e: any) {
            Alert.alert("Error", e?.response?.data?.error || "Failed to delete");
          }
        },
      },
    ]);
  }

  async function postComment() {
    const content = commentText.trim();
    if (!content) return;
    setPosting(true);
    try {
      const { data } = await addTaskComment(taskId, content);
      setComments((prev) => [...prev, data]);
      setCommentText("");
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to post comment");
    } finally {
      setPosting(false);
    }
  }

  if (loading || !task) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Stack.Screen options={{ title: "Task" }} />
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  const st = taskStatusMeta(task.status);

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          title: task.issue_key || "Task",
          headerRight: () => (
            <View style={styles.headerActions}>
              <Pressable onPress={() => setEditing((v) => !v)} hitSlop={8}>
                {editing ? (
                  <X size={20} color={theme.textSecondary} />
                ) : (
                  <Pencil size={18} color={theme.primary} />
                )}
              </Pressable>
              <Pressable onPress={confirmDelete} hitSlop={8}>
                <Trash2 size={18} color={theme.danger} />
              </Pressable>
            </View>
          ),
        }}
      />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={90}
      >
        <ScrollView contentContainerStyle={styles.container}>
          {/* Title / edit */}
          {editing ? (
            <>
              <Text style={styles.label}>Title</Text>
              <TextInput
                style={styles.input}
                value={title}
                onChangeText={setTitle}
                placeholderTextColor={theme.textMuted}
              />
              <Text style={styles.label}>Description</Text>
              <TextInput
                style={[styles.input, styles.textarea]}
                value={description}
                onChangeText={setDescription}
                multiline
                placeholder="Add details"
                placeholderTextColor={theme.textMuted}
              />
              <Text style={styles.label}>Priority</Text>
              <View style={styles.segment}>
                {PRIORITIES.map((p) => {
                  const active = p === priority;
                  const meta = TASK_PRIORITY[p];
                  return (
                    <Pressable
                      key={p}
                      style={[styles.segmentBtn, active && { backgroundColor: meta.color }]}
                      onPress={() => setPriority(p)}
                    >
                      <Text
                        style={[styles.segmentText, active && styles.segmentTextActive]}
                      >
                        {meta.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Pressable
                style={[styles.saveBtn, saving && styles.disabled]}
                onPress={saveEdits}
                disabled={saving}
              >
                {saving ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.saveText}>Save Changes</Text>
                )}
              </Pressable>
            </>
          ) : (
            <>
              <Text style={styles.taskTitle}>{task.title}</Text>
              <View style={styles.metaRow}>
                <View style={[styles.badge, { backgroundColor: st.bg }]}>
                  <Text style={[styles.badgeText, { color: st.color }]}>{st.label}</Text>
                </View>
                <View style={styles.priorityChip}>
                  <View
                    style={[
                      styles.dot,
                      { backgroundColor: TASK_PRIORITY[task.priority]?.color },
                    ]}
                  />
                  <Text style={styles.priorityText}>
                    {TASK_PRIORITY[task.priority]?.label} priority
                  </Text>
                </View>
              </View>
              {task.description ? (
                <Text style={styles.description}>{task.description}</Text>
              ) : (
                <Text style={styles.noDesc}>No description</Text>
              )}

              {/* Status workflow */}
              <Text style={styles.sectionTitle}>Status</Text>
              <View style={styles.statusGrid}>
                {STATUSES.map((s) => {
                  const meta = TASK_STATUS[s];
                  const active = task.status === s;
                  return (
                    <Pressable
                      key={s}
                      style={[
                        styles.statusBtn,
                        active && { backgroundColor: meta.bg, borderColor: meta.color },
                      ]}
                      onPress={() => changeStatus(s)}
                    >
                      {active ? <Check size={14} color={meta.color} /> : null}
                      <Text
                        style={[
                          styles.statusBtnText,
                          active && { color: meta.color, fontWeight: "700" },
                        ]}
                      >
                        {meta.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {/* Schedule / Unschedule */}
              <Text style={styles.sectionTitle}>Schedule</Text>
              {task.due_date ? (
                <Text style={styles.dueText}>
                  Scheduled for {new Date(task.due_date).toLocaleDateString()}
                </Text>
              ) : (
                <Text style={styles.noDesc}>In backlog (unscheduled)</Text>
              )}
              <View style={styles.scheduleRow}>
                <Pressable
                  style={[styles.scheduleBtn, scheduling && styles.disabled]}
                  onPress={handleSchedule}
                  disabled={scheduling}
                >
                  <CalendarPlus size={15} color={theme.primary} />
                  <Text style={styles.scheduleBtnText}>Schedule Today</Text>
                </Pressable>
                <Pressable
                  style={[styles.scheduleBtn, scheduling && styles.disabled]}
                  onPress={handleUnschedule}
                  disabled={scheduling}
                >
                  <CalendarX size={15} color={theme.textSecondary} />
                  <Text style={styles.scheduleBtnText}>To Backlog</Text>
                </Pressable>
              </View>
            </>
          )}

          {/* Comments / History tabs */}
          <View style={styles.detailTabs}>
            <Pressable
              style={[styles.detailTab, detailTab === "comments" && styles.detailTabActive]}
              onPress={() => setDetailTab("comments")}
            >
              <Text
                style={[
                  styles.detailTabText,
                  detailTab === "comments" && styles.detailTabTextActive,
                ]}
              >
                Comments {comments.length > 0 ? `(${comments.length})` : ""}
              </Text>
            </Pressable>
            <Pressable
              style={[styles.detailTab, detailTab === "history" && styles.detailTabActive]}
              onPress={() => setDetailTab("history")}
            >
              <Text
                style={[
                  styles.detailTabText,
                  detailTab === "history" && styles.detailTabTextActive,
                ]}
              >
                History
              </Text>
            </Pressable>
          </View>

          {detailTab === "comments" ? (
            comments.length === 0 ? (
              <Text style={styles.noDesc}>No comments yet</Text>
            ) : (
              comments.map((c) => (
                <View key={c.id} style={styles.comment}>
                  <View style={styles.commentAvatar}>
                    <Text style={styles.commentAvatarText}>
                      {(c.full_name || c.username || "?")[0]?.toUpperCase()}
                    </Text>
                  </View>
                  <View style={styles.commentBody}>
                    <View style={styles.commentTop}>
                      <Text style={styles.commentName}>
                        {c.full_name || c.username}
                      </Text>
                      <Text style={styles.commentTime}>{timeAgo(c.created_at)}</Text>
                    </View>
                    <Text style={styles.commentText}>{c.content}</Text>
                  </View>
                </View>
              ))
            )
          ) : history.length === 0 ? (
            <Text style={styles.noDesc}>No history yet</Text>
          ) : (
            history.map((h) => (
              <View key={h.id} style={styles.historyRow}>
                <View style={styles.historyDot} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.historyText}>
                    <Text style={styles.historyName}>{h.full_name || "Someone"}</Text>{" "}
                    {h.action.replace(/_/g, " ")}
                    {h.new_value ? `: ${h.new_value}` : ""}
                  </Text>
                  <Text style={styles.commentTime}>{timeAgo(h.created_at)}</Text>
                </View>
              </View>
            ))
          )}
        </ScrollView>

        {/* Comment composer */}
        <View style={[styles.composer, { paddingBottom: insets.bottom + 8 }]}>
          <TextInput
            style={styles.commentInput}
            placeholder="Add a comment"
            placeholderTextColor={theme.textMuted}
            value={commentText}
            onChangeText={setCommentText}
            multiline
          />
          <Pressable
            style={[styles.sendBtn, !commentText.trim() && styles.disabled]}
            onPress={postComment}
            disabled={!commentText.trim() || posting}
          >
            <Send size={18} color="#fff" />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { alignItems: "center", justifyContent: "center" },
  container: { padding: 16, gap: 10, paddingBottom: 24 },
  headerActions: { flexDirection: "row", gap: 18, alignItems: "center" },
  taskTitle: { fontSize: 20, fontWeight: "700", color: theme.text, lineHeight: 26 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" },
  badge: { borderRadius: theme.radiusSm, paddingHorizontal: 10, paddingVertical: 4 },
  badgeText: { fontSize: 12, fontWeight: "600" },
  priorityChip: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 9, height: 9, borderRadius: 4.5 },
  priorityText: { fontSize: 13, color: theme.textSecondary },
  dueText: { fontSize: 14, color: theme.text },
  scheduleRow: { flexDirection: "row", gap: 8 },
  scheduleBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusSm,
    paddingVertical: 12,
  },
  scheduleBtnText: { fontSize: 13, color: theme.text, fontWeight: "600" },
  detailTabs: {
    flexDirection: "row",
    backgroundColor: theme.surface,
    borderRadius: theme.radiusSm,
    padding: 3,
    gap: 3,
    marginTop: 16,
  },
  detailTab: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 5,
    alignItems: "center",
  },
  detailTabActive: { backgroundColor: theme.primary },
  detailTabText: { fontSize: 13, color: theme.textSecondary, fontWeight: "600" },
  detailTabTextActive: { color: "#fff" },
  historyRow: { flexDirection: "row", gap: 10, marginTop: 6, alignItems: "flex-start" },
  historyDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.primary,
    marginTop: 5,
  },
  historyText: { fontSize: 13, color: theme.textSecondary, lineHeight: 18 },
  historyName: { color: theme.text, fontWeight: "600" },
  description: { fontSize: 15, color: theme.text, lineHeight: 22, marginTop: 4 },
  noDesc: { fontSize: 14, color: theme.textMuted, fontStyle: "italic" },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: theme.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 16,
  },
  statusGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  statusBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    backgroundColor: theme.glass,
    borderRadius: theme.radiusFull,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  statusBtnText: { fontSize: 13, color: theme.textSecondary, fontWeight: "500" },
  label: {
    fontSize: 11,
    fontWeight: "600",
    color: theme.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 8,
  },
  input: {
    backgroundColor: theme.inputBg,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: theme.text,
    fontSize: 15,
  },
  textarea: { minHeight: 90, textAlignVertical: "top" },
  segment: {
    flexDirection: "row",
    backgroundColor: theme.surface,
    borderRadius: theme.radiusSm,
    padding: 3,
    gap: 3,
  },
  segmentBtn: { flex: 1, paddingVertical: 9, borderRadius: 5, alignItems: "center" },
  segmentText: { fontSize: 13, color: theme.textSecondary, fontWeight: "600" },
  segmentTextActive: { color: "#fff" },
  saveBtn: {
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 16,
  },
  saveText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  disabled: { opacity: 0.5 },
  comment: { flexDirection: "row", gap: 10, marginTop: 4 },
  commentAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  commentAvatarText: { color: "#fff", fontSize: 13, fontWeight: "700" },
  commentBody: {
    flex: 1,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radius,
    padding: 12,
    gap: 4,
  },
  commentTop: { flexDirection: "row", justifyContent: "space-between" },
  commentName: { fontSize: 13, fontWeight: "600", color: theme.text },
  commentTime: { fontSize: 11, color: theme.textMuted },
  commentText: { fontSize: 14, color: theme.textSecondary, lineHeight: 19 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: theme.border,
    backgroundColor: theme.bgSecondary,
  },
  commentInput: {
    flex: 1,
    maxHeight: 100,
    backgroundColor: theme.inputBg,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    color: theme.text,
    fontSize: 15,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
  },
});
