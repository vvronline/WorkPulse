import { useMemo, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack } from "expo-router";
import { Check, Circle, Flag, Plus, Trash2 } from "../../src/icons";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import { useNotes } from "../../src/notes/NotesContext";
import type { NoteTodo } from "../../src/features";

const PRIORITY_COLORS: Record<string, string> = {
  high: "#e03e3e",
  medium: "#cb912f",
  low: "#4daa57",
};

const PRIORITY_CYCLE: Array<NoteTodo["priority"]> = [null, "low", "medium", "high"];

export default function NotesTodoScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const store = useNotes();
  const {
    todos,
    handleAddTodo,
    handleToggleTodo,
    handleSetTodoPriority,
    handleDeleteTodo,
  } = store;

  const [text, setText] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "done">("all");

  const sorted = useMemo(() => {
    const list = [...todos];
    const weight = (p: NoteTodo["priority"]) =>
      p === "high" ? 0 : p === "medium" ? 1 : p === "low" ? 2 : 3;
    return list.sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      const w = weight(a.priority ?? null) - weight(b.priority ?? null);
      if (w !== 0) return w;
      return (b.sortOrder || 0) - (a.sortOrder || 0);
    });
  }, [todos]);

  const visible = useMemo(() => {
    if (filter === "active") return sorted.filter((t) => !t.done);
    if (filter === "done") return sorted.filter((t) => t.done);
    return sorted;
  }, [sorted, filter]);

  const activeCount = todos.filter((t) => !t.done).length;
  const doneCount = todos.length - activeCount;

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    handleAddTodo(t);
    setText("");
  };

  const cyclePriority = (todo: NoteTodo) => {
    const idx = PRIORITY_CYCLE.indexOf(todo.priority ?? null);
    const next = PRIORITY_CYCLE[(idx + 1) % PRIORITY_CYCLE.length];
    handleSetTodoPriority(todo.id, next);
  };

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "To-do" }} />

      {/* ── Add row ── */}
      <View style={styles.addRow}>
        <TextInput
          style={styles.addInput}
          value={text}
          onChangeText={setText}
          placeholder="Add a task…"
          placeholderTextColor={theme.textMuted}
          onSubmitEditing={submit}
          returnKeyType="done"
        />
        <Pressable style={styles.addBtn} onPress={submit}>
          <Plus size={18} color={theme.onAccent} />
        </Pressable>
      </View>

      {/* ── Filters ── */}
      <View style={styles.filters}>
        {(["all", "active", "done"] as const).map((f) => (
          <Pressable
            key={f}
            style={[styles.filterChip, filter === f && styles.filterChipActive]}
            onPress={() => setFilter(f)}
          >
            <Text style={[styles.filterText, filter === f && styles.filterTextActive]}>
              {f === "all"
                ? `All ${todos.length}`
                : f === "active"
                  ? `Active ${activeCount}`
                  : `Done ${doneCount}`}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* ── List ── */}
      <ScrollView contentContainerStyle={styles.list}>
        {visible.length === 0 ? (
          <Text style={styles.empty}>
            {filter === "done" ? "No completed tasks yet." : "No tasks. Add one above."}
          </Text>
        ) : (
          <View style={styles.card}>
            {visible.map((todo, i) => (
              <View
                key={todo.id}
                style={[styles.todoRow, i < visible.length - 1 && styles.rowBorder]}
              >
                <Pressable onPress={() => handleToggleTodo(todo.id)} hitSlop={8}>
                  {todo.done ? (
                    <View style={styles.checkOn}>
                      <Check size={13} color={theme.onAccent} />
                    </View>
                  ) : (
                    <Circle size={20} color={theme.textMuted} />
                  )}
                </Pressable>
                <Text
                  style={[styles.todoText, todo.done && styles.todoTextDone]}
                  numberOfLines={2}
                >
                  {todo.text}
                </Text>
                <Pressable onPress={() => cyclePriority(todo)} hitSlop={8}>
                  <Flag
                    size={16}
                    color={
                      todo.priority ? PRIORITY_COLORS[todo.priority] : theme.textMuted
                    }
                    fill={todo.priority ? PRIORITY_COLORS[todo.priority] : "transparent"}
                  />
                </Pressable>
                <Pressable onPress={() => handleDeleteTodo(todo.id)} hitSlop={8}>
                  <Trash2 size={16} color={theme.textMuted} />
                </Pressable>
              </View>
            ))}
          </View>
        )}
        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.bg },

    addRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      padding: 16,
    },
    addInput: {
      flex: 1,
      backgroundColor: theme.inputBg,
      borderWidth: 1,
      borderColor: theme.inputBorder,
      borderRadius: theme.radius,
      paddingHorizontal: 14,
      height: 46,
      color: theme.text,
      fontSize: 15,
    },
    addBtn: {
      width: 46,
      height: 46,
      borderRadius: theme.radius,
      backgroundColor: theme.primary,
      alignItems: "center",
      justifyContent: "center",
    },

    filters: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
    filterChip: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: theme.radiusFull,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.glassBorder,
    },
    filterChipActive: { backgroundColor: theme.primaryGlow, borderColor: theme.primary },
    filterText: { color: theme.textSecondary, fontSize: 12, fontWeight: "600" },
    filterTextActive: { color: theme.primary },

    list: { paddingHorizontal: 16, paddingTop: 4 },
    empty: { color: theme.textMuted, fontSize: 13, textAlign: "center", paddingVertical: 30 },

    card: {
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radiusLg,
      overflow: "hidden",
    },
    todoRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 14,
      paddingVertical: 13,
    },
    rowBorder: { borderBottomWidth: 1, borderBottomColor: theme.border },
    checkOn: {
      width: 20,
      height: 20,
      borderRadius: 10,
      backgroundColor: theme.primary,
      alignItems: "center",
      justifyContent: "center",
    },
    todoText: { flex: 1, color: theme.text, fontSize: 14 },
    todoTextDone: { color: theme.textMuted, textDecorationLine: "line-through" },
  });