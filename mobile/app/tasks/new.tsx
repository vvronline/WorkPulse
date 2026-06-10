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
import {
  addBacklogTask,
  createTask,
  getAssignableUsers,
  getAvailableSprints,
  getTaskLabels,
  type AssignableUser,
  type Sprint,
  type TaskLabel,
  type TaskPriority,
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
  const [busy, setBusy] = useState(false);

  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [labels, setLabels] = useState<TaskLabel[]>([]);
  const [sprints, setSprints] = useState<Sprint[]>([]);

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
  }, [isBacklog]);

  function toggleLabel(id: number) {
    setSelectedLabels((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

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
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.chipRow}
          >
            <Pressable
              style={[styles.chip, assignedTo === null && styles.chipActive]}
              onPress={() => setAssignedTo(null)}
            >
              <Text
                style={[styles.chipText, assignedTo === null && styles.chipTextActive]}
              >
                Unassigned
              </Text>
            </Pressable>
            {users.map((u) => {
              const active = assignedTo === u.id;
              return (
                <Pressable
                  key={u.id}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => setAssignedTo(active ? null : u.id)}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>
                    {u.full_name}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>

          {/* Labels */}
          {labels.length > 0 ? (
            <>
              <Text style={styles.label}>Labels</Text>
              <View style={styles.wrapRow}>
                {labels.map((l) => {
                  const active = selectedLabels.includes(l.id);
                  return (
                    <Pressable
                      key={l.id}
                      style={[
                        styles.chip,
                        active && { backgroundColor: l.color || theme.primary, borderColor: l.color || theme.primary },
                      ]}
                      onPress={() => toggleLabel(l.id)}
                    >
                      <Text style={[styles.chipText, active && styles.chipTextActive]}>
                        {l.name}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </>
          ) : null}

          {/* Sprint */}
          {sprints.length > 0 ? (
            <>
              <Text style={styles.label}>Sprint (optional)</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.chipRow}
              >
                <Pressable
                  style={[styles.chip, sprintId === null && styles.chipActive]}
                  onPress={() => setSprintId(null)}
                >
                  <Text
                    style={[styles.chipText, sprintId === null && styles.chipTextActive]}
                  >
                    None
                  </Text>
                </Pressable>
                {sprints.map((sp) => {
                  const active = sprintId === sp.id;
                  return (
                    <Pressable
                      key={sp.id}
                      style={[styles.chip, active && styles.chipActive]}
                      onPress={() => setSprintId(active ? null : sp.id)}
                    >
                      <Text style={[styles.chipText, active && styles.chipTextActive]}>
                        {sp.name}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
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
              <TextInput
                style={styles.input}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={theme.textMuted}
                value={dueDate}
                onChangeText={setDueDate}
                autoCapitalize="none"
              />
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
  chipRow: { gap: 8, paddingVertical: 2 },
  wrapRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: theme.radiusFull,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
  },
  chipActive: { backgroundColor: theme.primary, borderColor: theme.primary },
  chipText: { fontSize: 13, color: theme.textSecondary, fontWeight: "500" },
  chipTextActive: { color: "#fff", fontWeight: "600" },
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