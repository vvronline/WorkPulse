import {
  useCallback,
  useEffect,
  useMemo,
  useState } from "react";
import { ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import * as DocumentPicker from "expo-document-picker";
import * as Linking from "expo-linking";
import {
  CalendarPlus,
  CalendarX,
  Check,
  FileText,
  Paperclip,
  Pencil,
  Send,
  Trash2,
  X,
} from "../../src/icons";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import { uploadUrl } from "../../src/config";
import { AuthedImage } from "../../src/components/AuthedImage";
import { taskStatusMeta, TASK_STATUS, TASK_PRIORITY } from "../../src/constants";
import { Dropdown, MultiDropdown } from "../../src/components/Dropdown";
import DatePicker from "../../src/components/DatePicker";
import StoryPointPicker from "../../src/components/StoryPointPicker";
import {
  addTaskComment,
  deleteTask,
  getAgileConfig,
  getAssignableUsers,
  getAvailableSprints,
  getTaskDetail,
  getTaskHistory,
  getTaskLabels,
  scheduleTask,
  unscheduleTask,
  updateTaskFull,
  updateTaskStatus,
  type AssignableUser,
  type CommentAttachment,
  type Sprint,
  type Task,
  type TaskComment,
  type TaskHistoryEntry,
  type TaskLabel,
  type TaskPriority,
  type TaskStatus,
  type WorkItemType,
} from "../../src/features";
import {
  useKeyboardInset,
  scrollFocusedIntoView,
} from "../../src/hooks/useKeyboardInset";
import { makeStyles } from "./[id].styles";

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

// Format a story-point value for display: 1.00 → "1", 0.50 → "0.5",
// "S"/"M"/"L" → unchanged.
function formatPoints(value: number | string | null | undefined): string {
  if (value == null || value === "") return "";
  const num = typeof value === "number" ? value : parseFloat(value);
  if (Number.isNaN(num)) return String(value);
  if (Number.isInteger(num)) return String(num);
  return num.toFixed(2).replace(/\.?0+$/, "");
}

// Whether a comment's attachment is an image (renders an inline thumbnail vs a
// downloadable file card — mirrors the web CommentAttachment/FilePreview).
function isImageAttachment(c: TaskComment): boolean {
  if (c.file_type && c.file_type.startsWith("image/")) return true;
  const name = (c.file_name || c.file_url || "").toLowerCase();
  return /\.(png|jpe?g|gif|webp|heic|bmp)$/.test(name);
}

// Open a comment attachment in the device's default handler (image viewer,
// PDF reader, browser download, etc.).
function openAttachment(fileUrl?: string | null) {
  const u = uploadUrl(fileUrl);
  if (u) Linking.openURL(u);
}

export default function TaskDetail() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { id, focus } = useLocalSearchParams<{ id: string; focus?: string }>();
  const taskId = Number(id);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const kbInset = useKeyboardInset();

  const [task, setTask] = useState<
    (Task & { comments?: TaskComment[] }) | null
  >(null);
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  // Extended edit fields (mirror the web TaskDetailModal edit mode).
  const [assignedTo, setAssignedTo] = useState<number | null>(null);
  const [dueDate, setDueDate] = useState("");
  const [sprintId, setSprintId] = useState<number | null>(null);
  const [selectedLabels, setSelectedLabels] = useState<number[]>([]);
  const [workItemType, setWorkItemType] = useState<string | number | null>(null);
  const [storyPoints, setStoryPoints] = useState<number | string | null>(null);
  const [saving, setSaving] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [attachment, setAttachment] = useState<CommentAttachment | null>(null);
  const [posting, setPosting] = useState(false);
  const [detailTab, setDetailTab] = useState<"comments" | "history">("comments");
  const [history, setHistory] = useState<TaskHistoryEntry[]>([]);
  const [scheduling, setScheduling] = useState(false);

  // Reference data for the edit form (loaded once on first edit).
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [labels, setLabels] = useState<TaskLabel[]>([]);
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [workItemTypes, setWorkItemTypes] = useState<WorkItemType[]>([]);
  const [refLoaded, setRefLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await getTaskDetail(taskId);
      setTask(data);
      setComments(data.comments || []);
      setTitle(data.title);
      setDescription(data.description || "");
      setPriority(data.priority);
      setAssignedTo(data.assigned_to ?? null);
      setDueDate(data.due_date || "");
      setSprintId(data.sprint_id ?? null);
      setSelectedLabels((data.labels || []).map((l) => l.id));
      setWorkItemType(data.work_item_type_id ?? null);
      setStoryPoints(data.story_points ?? null);
    } catch {
      Alert.alert("Error", "Failed to load task");
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    load();
  }, [load]);

  // Load reference data (users / labels / sprints / types) up front so the
  // read-only view can resolve sprint + work-item-type names and the edit form
  // is ready instantly. Cheap, cached endpoints — mirrors the web TaskContext.
  useEffect(() => {
    if (refLoaded) return;
    getAssignableUsers()
      .then((r) => setUsers(r.data || []))
      .catch(() => {});
    getTaskLabels()
      .then((r) => setLabels(r.data || []))
      .catch(() => {});
    getAvailableSprints()
      .then((r) => setSprints(r.data || []))
      .catch(() => {});
    getAgileConfig()
      .then((r) => setWorkItemTypes((r.data.workItemTypes || []).filter(Boolean)))
      .catch(() => {});
    setRefLoaded(true);
  }, [refLoaded]);

  // When deep-linked from a Kanban card's "Add comment" button, default the
  // detail view to the Comments tab.
  useEffect(() => {
    if (focus === "comments") setDetailTab("comments");
  }, [focus]);

  useEffect(() => {
    if (detailTab !== "history") return;
    getTaskHistory(taskId)
      .then((r) => setHistory(r.data || []))
      .catch(() => setHistory([]));
  }, [detailTab, taskId]);

  // Reference data is loaded on mount; entering edit mode just flips the flag.
  const startEdit = useCallback(() => {
    setEditing(true);
  }, []);

  // Reset edit fields back to the loaded task and exit edit mode.
  function cancelEdit() {
    if (task) {
      setTitle(task.title);
      setDescription(task.description || "");
      setPriority(task.priority);
      setAssignedTo(task.assigned_to ?? null);
      setDueDate(task.due_date || "");
      setSprintId(task.sprint_id ?? null);
      setSelectedLabels((task.labels || []).map((l) => l.id));
      setWorkItemType(task.work_item_type_id ?? null);
      setStoryPoints(task.story_points ?? null);
    }
    setEditing(false);
  }

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
        assigned_to: assignedTo,
        due_date: /^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? dueDate : null,
        sprint_id: sprintId,
        label_ids: selectedLabels,
        story_points: storyPoints,
        work_item_type_id: workItemType,
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

  // Pick a single document to attach to the next comment (mirrors the web
  // InlineCommentPanel paperclip → file input). Uses expo-document-picker, the
  // same flow the chat composer uses for non-image files.
  async function pickAttachment() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled || !result.assets?.[0]?.uri) return;
      const asset = result.assets[0];
      setAttachment({
        uri: asset.uri,
        name: asset.name || undefined,
        mimeType: asset.mimeType || undefined,
      });
    } catch {
      Alert.alert("Error", "Could not pick this file.");
    }
  }

  async function postComment() {
    const content = commentText.trim();
    // A comment must carry text, a file, or both (matches the server rule).
    if (!content && !attachment) return;
    setPosting(true);
    try {
      const { data } = await addTaskComment(taskId, content, attachment);
      setComments((prev) => [...prev, data]);
      setCommentText("");
      setAttachment(null);
    } catch (e: any) {
      // The server may fail AFTER committing the comment (e.g. a post-insert
      // side effect throws) — historically this surfaced as "Failed to add
      // comment" even though the comment WAS added. Verify against the
      // server before alarming the user.
      try {
        const { data: fresh } = await getTaskDetail(taskId);
        const freshComments = fresh.comments || [];
        const saved = freshComments.some(
          (c) =>
            (content ? c.content === content : true) &&
            (attachment ? !!c.file_url : true) &&
            c.user_id != null,
        );
        if (saved) {
          setTask(fresh);
          setComments(freshComments);
          setCommentText("");
          setAttachment(null);
          return;
        }
      } catch {
        /* verification failed — fall through to the error alert */
      }
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
  const sprintName =
    task.sprint_id != null
      ? sprints.find((s) => s.id === task.sprint_id)?.name ||
        `Sprint #${task.sprint_id}`
      : null;
  const typeName =
    task.work_item_type_id != null
      ? workItemTypes.find(
          (t) => String(t.id || t.key) === String(task.work_item_type_id),
        )?.name || null
      : null;
  const pointsDisplay = formatPoints(task.story_points);

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          title: task.issue_key || "Task",
          headerRight: () => (
            <View style={styles.headerActions}>
              <Pressable
                onPress={() => (editing ? cancelEdit() : startEdit())}
                hitSlop={8}
              >
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

              {/* Assignee */}
              <Text style={styles.label}>Assignee</Text>
              <Dropdown
                label="Assignee"
                value={assignedTo}
                placeholder="Unassigned"
                onChange={(v) => setAssignedTo(v == null ? null : Number(v))}
                options={[
                  { value: null, label: "Unassigned" },
                  ...users.map((u) => ({ value: u.id, label: u.full_name })),
                ]}
              />

              {/* Labels */}
              {labels.length > 0 ? (
                <>
                  <Text style={styles.label}>Labels</Text>
                  <MultiDropdown
                    label="Labels"
                    values={selectedLabels}
                    placeholder="No labels"
                    onChange={(vals) =>
                      setSelectedLabels(vals.map((v) => Number(v)))
                    }
                    options={labels.map((l) => ({
                      value: l.id,
                      label: l.name,
                      color: l.color || theme.primary,
                    }))}
                  />
                </>
              ) : null}

              {/* Sprint */}
              {sprints.length > 0 ? (
                <>
                  <Text style={styles.label}>Sprint</Text>
                  <Dropdown
                    label="Sprint"
                    value={sprintId}
                    placeholder="Backlog (no sprint)"
                    onChange={(v) => {
                      const sid = v == null ? null : Number(v);
                      setSprintId(sid);
                      if (!sid) {
                        setDueDate("");
                      } else {
                        const sp = sprints.find((s) => s.id === sid);
                        if (sp?.end_date) setDueDate(sp.end_date);
                      }
                    }}
                    options={[
                      { value: null, label: "Backlog (no sprint)" },
                      ...sprints.map((sp) => ({
                        value: sp.id,
                        label: sp.name + (sp.status === "active" ? " ●" : ""),
                      })),
                    ]}
                  />
                </>
              ) : null}

              {/* Type */}
              {workItemTypes.length > 0 ? (
                <>
                  <Text style={styles.label}>Type</Text>
                  <Dropdown
                    label="Type"
                    value={workItemType}
                    placeholder="— Type —"
                    onChange={(v) => setWorkItemType(v)}
                    options={[
                      { value: null, label: "— Type —" },
                      ...workItemTypes.map((t) => ({
                        value: t.id || t.key,
                        label: t.name,
                        color: t.color,
                      })),
                    ]}
                  />
                </>
              ) : null}

              {/* Story points */}
              <Text style={styles.label}>Story Points</Text>
              <StoryPointPicker value={storyPoints} onChange={setStoryPoints} />

              {/* Due date */}
              <Text style={styles.label}>Due Date</Text>
              <DatePicker value={dueDate} onChange={setDueDate} />

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
                {pointsDisplay ? (
                  <View style={styles.pointBadge}>
                    <Text style={styles.pointBadgeText}>{pointsDisplay}</Text>
                  </View>
                ) : null}
                {task.is_blocked ? (
                  <View style={styles.blockerBadge}>
                    <Text style={styles.blockerText}>⛔ Blocked</Text>
                  </View>
                ) : null}
              </View>

              {/* Labels */}
              {task.labels && task.labels.length > 0 ? (
                <View style={styles.labelRow}>
                  {task.labels.map((l) => (
                    <View
                      key={l.id}
                      style={[
                        styles.labelPill,
                        { backgroundColor: (l.color || theme.primary) + "22" },
                      ]}
                    >
                      <Text
                        style={[
                          styles.labelPillText,
                          { color: l.color || theme.primaryLight },
                        ]}
                      >
                        {l.name}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}

              {task.description ? (
                <Text style={styles.description}>{task.description}</Text>
              ) : (
                <Text style={styles.noDesc}>No description</Text>
              )}

              {/* Details grid */}
              <View style={styles.detailGrid}>
                {task.assignee ? (
                  <View style={styles.detailItem}>
                    <Text style={styles.detailLabel}>Assigned to</Text>
                    <Text style={styles.detailValue}>
                      {task.assignee.full_name || task.assignee.username}
                    </Text>
                  </View>
                ) : null}
                {typeName ? (
                  <View style={styles.detailItem}>
                    <Text style={styles.detailLabel}>Type</Text>
                    <Text style={styles.detailValue}>{typeName}</Text>
                  </View>
                ) : null}
                {pointsDisplay ? (
                  <View style={styles.detailItem}>
                    <Text style={styles.detailLabel}>Story points</Text>
                    <Text style={styles.detailValue}>{pointsDisplay}</Text>
                  </View>
                ) : null}
                {sprintName ? (
                  <View style={styles.detailItem}>
                    <Text style={styles.detailLabel}>Sprint</Text>
                    <Text style={styles.detailValue}>{sprintName}</Text>
                  </View>
                ) : null}
              </View>

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
              {/* `task.date` is the daily-planner schedule date set by the
                  schedule/unschedule endpoints. `due_date` is a separate
                  deadline field and must not be used to infer schedule state
                  (mirrors the web TaskDetailModal `isBacklogItem` check). */}
              <Text style={styles.sectionTitle}>Schedule</Text>
              {task.date ? (
                <Text style={styles.dueText}>
                  Scheduled for {new Date(task.date).toLocaleDateString()}
                </Text>
              ) : (
                <Text style={styles.noDesc}>In backlog (unscheduled)</Text>
              )}
              {task.due_date ? (
                <Text style={styles.dueText}>
                  Due {new Date(task.due_date).toLocaleDateString()}
                </Text>
              ) : null}
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
                    {c.content ? (
                      <Text style={styles.commentText}>{c.content}</Text>
                    ) : null}
                    {c.file_url ? (
                      isImageAttachment(c) ? (
                        <Pressable
                          onPress={() => openAttachment(c.file_url)}
                          style={styles.attachImageWrap}
                        >
                          <AuthedImage
                            uri={uploadUrl(c.file_url) || undefined}
                            style={styles.attachImage}
                            resizeMode="cover"
                          />
                        </Pressable>
                      ) : (
                        <Pressable
                          style={styles.attachFileCard}
                          onPress={() => openAttachment(c.file_url)}
                        >
                          <FileText size={16} color={theme.primary} />
                          <Text style={styles.attachFileName} numberOfLines={1}>
                            {c.file_name || "File"}
                          </Text>
                        </Pressable>
                      )
                    ) : null}
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
        <View
          style={[
            styles.composerWrap,
            { paddingBottom: Math.max(insets.bottom, kbInset) + 8 },
          ]}
        >
          {/* Selected-attachment chip (shown above the input row, mirrors the
              web InlineCommentPanel file chip). */}
          {attachment ? (
            <View style={styles.attachChip}>
              <Paperclip size={13} color={theme.primary} />
              <Text style={styles.attachChipText} numberOfLines={1}>
                {attachment.name || "Attachment"}
              </Text>
              <Pressable onPress={() => setAttachment(null)} hitSlop={8}>
                <X size={14} color={theme.textSecondary} />
              </Pressable>
            </View>
          ) : null}
          <View style={styles.composer}>
            <Pressable
              style={styles.attachBtn}
              onPress={pickAttachment}
              disabled={posting}
              hitSlop={8}
            >
              <Paperclip size={20} color={theme.textSecondary} />
            </Pressable>
            <TextInput
              style={styles.commentInput}
              placeholder="Add a comment"
              placeholderTextColor={theme.textMuted}
              value={commentText}
              onChangeText={setCommentText}
              onFocus={scrollFocusedIntoView}
              multiline
            />
            <Pressable
              style={[
                styles.sendBtn,
                !commentText.trim() && !attachment && styles.disabled,
              ]}
              onPress={postComment}
              disabled={(!commentText.trim() && !attachment) || posting}
            >
              {posting ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Send size={18} color="#fff" />
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}
