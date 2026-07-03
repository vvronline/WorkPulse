import { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import {
  ClipboardList,
  FileText,
  Search,
  User,
  X,
} from "../src/icons";
import type { Theme } from "../src/theme";
import { useTheme } from "../src/theme/ThemeProvider";
import {
  globalSearch,
  type GlobalSearchResults,
  type GlobalSearchTask,
  type GlobalSearchUser,
  type GlobalSearchNote,
} from "../src/features";

// Minimum query length before hitting the server (mirrors the server-side guard).
const MIN_QUERY_LENGTH = 2;
// Debounce delay (ms) — avoids hammering the server on every keystroke.
const DEBOUNCE_MS = 400;

type ResultItem =
  | { kind: "task"; data: GlobalSearchTask }
  | { kind: "user"; data: GlobalSearchUser }
  | { kind: "note"; data: GlobalSearchNote }
  | { kind: "section"; label: string };

function buildItems(results: GlobalSearchResults): ResultItem[] {
  const items: ResultItem[] = [];
  if (results.tasks.length) {
    items.push({ kind: "section", label: "Tasks" });
    results.tasks.forEach((d) => items.push({ kind: "task", data: d }));
  }
  if (results.users.length) {
    items.push({ kind: "section", label: "People" });
    results.users.forEach((d) => items.push({ kind: "user", data: d }));
  }
  if (results.notes.length) {
    items.push({ kind: "section", label: "Notes" });
    results.notes.forEach((d) => items.push({ kind: "note", data: d }));
  }
  return items;
}

const PRIORITY_COLORS: Record<string, string> = {
  high: "#ef4444",
  medium: "#f59e0b",
  low: "#22c55e",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "To Do",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
};

export default function GlobalSearchScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GlobalSearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<TextInput>(null);

  const performSearch = useCallback(async (q: string) => {
    if (q.trim().length < MIN_QUERY_LENGTH) {
      setResults(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await globalSearch(q.trim());
      setResults(res.data ?? { tasks: [], users: [], notes: [], logs: [] });
    } catch {
      setError("Search failed. Please try again.");
      setResults(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const onChangeText = useCallback(
    (text: string) => {
      setQuery(text);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => performSearch(text), DEBOUNCE_MS);
    },
    [performSearch],
  );

  const clearQuery = useCallback(() => {
    setQuery("");
    setResults(null);
    setError(null);
    inputRef.current?.focus();
  }, []);

  const items = useMemo(
    () => (results ? buildItems(results) : []),
    [results],
  );

  const isEmpty =
    results !== null &&
    results.tasks.length === 0 &&
    results.users.length === 0 &&
    results.notes.length === 0;

  const renderItem = useCallback(
    ({ item }: { item: ResultItem }) => {
      if (item.kind === "section") {
        return (
          <Text style={styles.sectionLabel}>{item.label}</Text>
        );
      }

      if (item.kind === "task") {
        const t = item.data;
        return (
          <Pressable
            style={styles.resultRow}
            onPress={() =>
              router.push({
                pathname: "/tasks/[id]",
                params: { id: String(t.id) },
              })
            }
          >
            <View style={styles.resultIcon}>
              <ClipboardList size={16} color={theme.textSecondary} />
            </View>
            <View style={styles.resultContent}>
              <Text style={styles.resultTitle} numberOfLines={1}>
                {t.title}
              </Text>
              <View style={styles.metaRow}>
                <View
                  style={[
                    styles.priorityBadge,
                    {
                      backgroundColor:
                        (PRIORITY_COLORS[t.priority] ?? theme.border) + "26",
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.priorityText,
                      { color: PRIORITY_COLORS[t.priority] ?? theme.textSecondary },
                    ]}
                  >
                    {t.priority}
                  </Text>
                </View>
                <Text style={styles.metaLabel}>
                  {STATUS_LABELS[t.status] ?? t.status}
                </Text>
              </View>
              {!!t.snippet && (
                <Text style={styles.snippet} numberOfLines={2}>
                  {t.snippet.replace(/<[^>]+>/g, "")}
                </Text>
              )}
            </View>
          </Pressable>
        );
      }

      if (item.kind === "user") {
        const u = item.data;
        return (
          <Pressable
            style={styles.resultRow}
            onPress={() =>
              router.push({
                pathname: "/member/[id]",
                params: { id: String(u.id) },
              })
            }
          >
            <View style={styles.resultIcon}>
              <User size={16} color={theme.textSecondary} />
            </View>
            <View style={styles.resultContent}>
              <Text style={styles.resultTitle} numberOfLines={1}>
                {u.full_name}
              </Text>
              {!!(u.role || u.department_name) && (
                <Text style={styles.metaLabel} numberOfLines={1}>
                  {[u.role, u.department_name].filter(Boolean).join(" · ")}
                </Text>
              )}
            </View>
          </Pressable>
        );
      }

      if (item.kind === "note") {
        const n = item.data;
        return (
          <Pressable
            style={styles.resultRow}
            onPress={() =>
              router.push({
                pathname: "/notes/[id]",
                params: { id: n.id },
              })
            }
          >
            <View style={styles.resultIcon}>
              <FileText size={16} color={theme.textSecondary} />
            </View>
            <View style={styles.resultContent}>
              <Text style={styles.resultTitle} numberOfLines={1}>
                {n.title || "Untitled"}
              </Text>
              {!!n.snippet && (
                <Text style={styles.snippet} numberOfLines={2}>
                  {n.snippet}
                </Text>
              )}
            </View>
          </Pressable>
        );
      }

      return null;
    },
    [styles, theme, router],
  );

  const keyExtractor = useCallback((item: ResultItem, index: number) => {
    if (item.kind === "section") return `section-${item.label}`;
    if (item.kind === "task") return `task-${item.data.id}`;
    if (item.kind === "user") return `user-${item.data.id}`;
    if (item.kind === "note") return `note-${item.data.id}`;
    return String(index);
  }, []);

  return (
    <>
      <Stack.Screen
        options={{
          title: "Search",
          headerShown: false,
        }}
      />
      <View style={styles.root}>
        {/* Search bar */}
        <View style={styles.searchBar}>
          <Search size={18} color={theme.textSecondary} />
          <TextInput
            ref={inputRef}
            style={styles.input}
            placeholder="Search tasks, people, notes…"
            placeholderTextColor={theme.textSecondary}
            value={query}
            onChangeText={onChangeText}
            autoFocus
            returnKeyType="search"
            onSubmitEditing={() => performSearch(query)}
            clearButtonMode="never"
          />
          {query.length > 0 && (
            <Pressable onPress={clearQuery} hitSlop={8}>
              <X size={16} color={theme.textSecondary} />
            </Pressable>
          )}
        </View>

        {/* States */}
        {loading && (
          <View style={styles.centerState}>
            <ActivityIndicator color={theme.primary} />
          </View>
        )}

        {!loading && !!error && (
          <View style={styles.centerState}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {!loading && !error && isEmpty && (
          <View style={styles.centerState}>
            <Text style={styles.emptyText}>
              No results for "{query}"
            </Text>
          </View>
        )}

        {!loading && !error && query.trim().length > 0 && query.trim().length < MIN_QUERY_LENGTH && (
          <View style={styles.centerState}>
            <Text style={styles.hintText}>Type at least 2 characters to search</Text>
          </View>
        )}

        {!loading && !error && query.trim().length === 0 && (
          <View style={styles.centerState}>
            <Search size={36} color={theme.border} />
            <Text style={styles.hintText}>Search across tasks, people, and notes</Text>
          </View>
        )}

        {/* Results */}
        {!loading && !error && items.length > 0 && (
          <FlatList
            data={items}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.list}
          />
        )}
      </View>
    </>
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: theme.bg,
    },
    searchBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      marginHorizontal: 16,
      marginTop: 16,
      marginBottom: 8,
      paddingHorizontal: 14,
      paddingVertical: 10,
      backgroundColor: theme.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.border,
    },
    input: {
      flex: 1,
      fontSize: 15,
      color: theme.text,
      fontFamily: theme.fontRegular,
      padding: 0,
    },
    centerState: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: 12,
      paddingHorizontal: 32,
    },
    errorText: {
      fontSize: 14,
      color: "#ef4444",
      textAlign: "center",
      fontFamily: theme.fontRegular,
    },
    emptyText: {
      fontSize: 14,
      color: theme.textSecondary,
      textAlign: "center",
      fontFamily: theme.fontRegular,
    },
    hintText: {
      fontSize: 13,
      color: theme.textSecondary,
      textAlign: "center",
      fontFamily: theme.fontRegular,
    },
    list: {
      paddingHorizontal: 16,
      paddingBottom: 32,
    },
    sectionLabel: {
      fontSize: 11,
      fontWeight: "600",
      color: theme.textSecondary,
      textTransform: "uppercase",
      letterSpacing: 0.8,
      marginTop: 20,
      marginBottom: 6,
      fontFamily: theme.fontSemiBold,
    },
    resultRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 12,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    resultIcon: {
      marginTop: 2,
    },
    resultContent: {
      flex: 1,
      gap: 4,
    },
    resultTitle: {
      fontSize: 14,
      color: theme.text,
      fontFamily: theme.fontMedium,
    },
    metaRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    priorityBadge: {
      borderRadius: 4,
      paddingHorizontal: 6,
      paddingVertical: 1,
    },
    priorityText: {
      fontSize: 11,
      fontWeight: "600",
      textTransform: "capitalize",
      fontFamily: theme.fontSemiBold,
    },
    metaLabel: {
      fontSize: 12,
      color: theme.textSecondary,
      fontFamily: theme.fontRegular,
    },
    snippet: {
      fontSize: 12,
      color: theme.textSecondary,
      lineHeight: 17,
      fontFamily: theme.fontRegular,
    },
  });
}
