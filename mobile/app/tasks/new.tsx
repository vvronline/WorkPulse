import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { theme } from "../../src/theme";
import { TASK_PRIORITY } from "../../src/constants";
import { Dropdown, MultiDropdown } from "../../src/components/Dropdown";
import DatePicker from "../../src/components/DatePicker";
import {
  addBacklogTask,
  createTask,
  getAgileConfig,
  getAssignableUsers,
  getAvailableSprints,
  getTaskLabels,
  type AssignableUser,
  type Sprint,
  type TaskLabel,
  type TaskPriority,
  type WorkItemType,
} from "../../src/features";

const PRIORITIES: TaskPriority[] = ["low", "medium", "high"];

export default function NewTaskScreen() {
  const router = useRouter();
  const { backlog } = useLocalSearchParams<{ backlog?: string }>();
  const isBacklog = backlog === "1";
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [assignedTo, setAssignedTo] = useState<number | null>(null);
  const [dueDate, setDueDate] = useState("");
  const [storyPoints, setStoryPoints] = useState("");
  const [selectedLabels, setSelectedLabels] = useState<number[]>([]);
  const [sprintId, setSprintId] = useState<number | null>(null);
  const [workItemType, setWorkItemType] = useState<string | number | null>(null);
  const [busy, setBusy] = useState(false);

  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [labels, setLabels] = useState<TaskLabel[]>([]);
  const [sprints, setSprints] = useState<Sprint[]>([]);
  const [workItemTypes, setWorkItemTypes] = useState<WorkItemType[]>([]);

  useEffect(() => {
    if (!isBacklog) return;
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
      .then((r) => {
        const types = (r.data.workItemTypes || []).filter(Boolean);
        setWorkItemTypes(types);
      })
      .catch(() => {});
  }, [isBacklog]);

  async function submit() {
    if (!title.trim()) return;
    setBusy(true);
    try {
      if (isBacklog) {
        await addBacklogTask({
          title: title.trim(),
          description: description.trim() || undefined,
          priority,
          assigned_to: assignedTo ?? undefined,
          due_date: /^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? dueDate : undefined,
          label_ids: selectedLabels.length ? selectedLabels : undefined,
          story_points: storyPoints ? Number(storyPoints) : undefined,
          sprint_id: sprintId ?? undefined,
          work_item_type_id: workItemType ?? undefined,
        });
      } else {
        await createTask({
          title: title.trim(),
          description: description.trim() || undefined,
          priority,
        });
      }
      router.back();
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to create task");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: isBacklog ? "New Ticket" : "New Task" }} />
      <Text style={styles.label}>Title</Text>
      <TextInput
        style={styles.input}
        placeholder="What needs to be done?"
        placeholderTextColor={theme.textMuted}
        value={title}
        onChangeText={setTitle}
      />

      <Text style={styles.label}>Description (optional)</Text>
      <TextInput
        style={[styles.input, styles.textarea]}
        placeholder="Add details"
        placeholderTextColor={theme.textMuted}
        value={description}
        onChangeText={setDescription}
        multiline
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
              <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                {meta.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {isBacklog ? (
        <>
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
                onChange={(vals) => setSelectedLabels(vals.map((v) => Number(v)))}
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
              <Text style={styles.label}>Sprint (optional)</Text>
              <Dropdown
                label="Sprint"
                value={sprintId}
                placeholder="None"
                onChange={(v) => {
                  const id = v == null ? null : Number(v);
                  setSprintId(id);
                  if (!id) {
                    setDueDate("");
                  } else {
                    const sp = sprints.find((s) => s.id === id);
                    if (sp?.end_date) setDueDate(sp.end_date);
                  }
                }}
                options={[
                  { value: null, label: "None" },
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

          {/* Story points + due date */}
          <View style={styles.row}>
            <View style={styles.half}>
              <Text style={styles.label}>Story Points</Text>
              <TextInput
                style={styles.input}
                placeholder="e.g. 3"
                placeholderTextColor={theme.textMuted}
                value={storyPoints}
                onChangeText={setStoryPoints}
                keyboardType="number-pad"
              />
            </View>
            <View style={styles.half}>
              <Text style={styles.label}>Due Date</Text>
              <DatePicker value={dueDate} onChange={setDueDate} />
            </View>
          </View>
        </>
      ) : null}

      <Pressable
        style={[styles.submit, (!title.trim() || busy) && styles.submitDisabled]}
        onPress={submit}
        disabled={!title.trim() || busy}
      >
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.submitText}>
            {isBacklog ? "Create Ticket" : "Create Task"}
          </Text>
        )}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  container: { padding: 16, gap: 8, paddingBottom: 40 },
  label: {
    fontSize: 11,
    fontWeight: "600",
    color: theme.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 10,
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
  segmentBtn: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 5,
    alignItems: "center",
  },
  segmentText: { fontSize: 13, color: theme.textSecondary, fontWeight: "600" },
  segmentTextActive: { color: "#fff" },
  row: { flexDirection: "row", gap: 12 },
  half: { flex: 1 },
  submit: {
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 20,
  },
  submitDisabled: { opacity: 0.5 },
  submitText: { color: "#fff", fontSize: 15, fontWeight: "600" },
});