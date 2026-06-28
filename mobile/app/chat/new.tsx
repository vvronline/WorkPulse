import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { Check, Search, Users } from "lucide-react-native";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import {
  createGroupConversation,
  searchChatUsers,
  startConversation,
} from "../../src/features";

type FoundUser = {
  id: number;
  username: string;
  full_name: string;
  avatar?: string | null;
};

function initials(name?: string) {
  if (!name) return "?";
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "?";
}

export default function NewChatScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FoundUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState<number | null>(null);
  const [groupMode, setGroupMode] = useState(false);
  const [selected, setSelected] = useState<FoundUser[]>([]);
  const [groupName, setGroupName] = useState("");
  const [creating, setCreating] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    const q = query.trim();
    // The backend `/chat/search` endpoint ignores queries shorter than 2
    // characters (returns []), so mirror that threshold here to avoid showing
    // a misleading "No people found" state after a single keystroke.
    if (q.length < 2) {
      setResults([]);
      return;
    }
    debounce.current = setTimeout(async () => {
      setLoading(true);
      try {
        const { data } = await searchChatUsers(q);
        setResults(data || []);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query]);

  async function open(user: FoundUser) {
    setStarting(user.id);
    try {
      const { data } = await startConversation(user.id);
      // Server returns { conversationId } (accept legacy { id } defensively).
      const convId =
        (data as { conversationId?: number; id?: number })?.conversationId ??
        (data as { conversationId?: number; id?: number })?.id;
      if (!convId) {
        setStarting(null);
        return;
      }
      router.replace({
        pathname: "/chat/[id]",
        params: { id: String(convId), name: user.full_name || user.username },
      });
    } catch {
      setStarting(null);
    }
  }

  function toggleSelect(user: FoundUser) {
    setSelected((prev) =>
      prev.some((u) => u.id === user.id)
        ? prev.filter((u) => u.id !== user.id)
        : [...prev, user],
    );
  }

  async function createGroup() {
    if (!groupName.trim() || selected.length < 2) return;
    setCreating(true);
    try {
      const { data } = await createGroupConversation(
        groupName.trim(),
        selected.map((u) => u.id),
      );
      // Server returns { conversationId } (accept legacy { id } defensively).
      const convId =
        (data as { conversationId?: number; id?: number })?.conversationId ??
        (data as { conversationId?: number; id?: number })?.id;
      if (!convId) {
        setCreating(false);
        return;
      }
      router.replace({
        pathname: "/chat/[id]",
        params: { id: String(convId), name: groupName.trim() },
      });
    } catch {
      setCreating(false);
    }
  }

  return (
    <View style={styles.screen}>
      {/* Mode toggle */}
      <View style={styles.modeRow}>
        <Pressable
          style={[styles.modeBtn, !groupMode && styles.modeBtnActive]}
          onPress={() => {
            setGroupMode(false);
            setSelected([]);
          }}
        >
          <Text style={[styles.modeText, !groupMode && styles.modeTextActive]}>
            Direct
          </Text>
        </Pressable>
        <Pressable
          style={[styles.modeBtn, groupMode && styles.modeBtnActive]}
          onPress={() => setGroupMode(true)}
        >
          <Users size={14} color={groupMode ? "#fff" : theme.textSecondary} />
          <Text style={[styles.modeText, groupMode && styles.modeTextActive]}>
            Group
          </Text>
        </Pressable>
      </View>

      {groupMode ? (
        <TextInput
          style={styles.groupNameInput}
          placeholder="Group name"
          placeholderTextColor={theme.textMuted}
          value={groupName}
          onChangeText={setGroupName}
        />
      ) : null}

      <View style={styles.searchBar}>
        <Search size={18} color={theme.textMuted} />
        <TextInput
          style={styles.input}
          placeholder="Search people"
          placeholderTextColor={theme.textMuted}
          value={query}
          onChangeText={setQuery}
          autoFocus={!groupMode}
          autoCapitalize="none"
        />
        {loading ? <ActivityIndicator size="small" color={theme.primary} /> : null}
      </View>

      {/* Selected chips (group mode) */}
      {groupMode && selected.length > 0 ? (
        <View style={styles.selectedRow}>
          {selected.map((u) => (
            <Pressable
              key={u.id}
              style={styles.selectedChip}
              onPress={() => toggleSelect(u)}
            >
              <Text style={styles.selectedChipText}>
                {u.full_name || u.username} ✕
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <FlatList
        data={results}
        keyExtractor={(u) => String(u.id)}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => {
          const isSelected = selected.some((u) => u.id === item.id);
          return (
            <Pressable
              style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
              onPress={() => (groupMode ? toggleSelect(item) : open(item))}
            >
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{initials(item.full_name)}</Text>
              </View>
              <View style={styles.body}>
                <Text style={styles.name}>{item.full_name || item.username}</Text>
                <Text style={styles.username}>@{item.username}</Text>
              </View>
              {groupMode ? (
                <View style={[styles.checkbox, isSelected && styles.checkboxOn]}>
                  {isSelected ? <Check size={14} color="#fff" /> : null}
                </View>
              ) : starting === item.id ? (
                <ActivityIndicator size="small" color={theme.primary} />
              ) : null}
            </Pressable>
          );
        }}
        ListEmptyComponent={
          query.trim().length > 0 && !loading ? (
            <Text style={styles.empty}>No people found</Text>
          ) : null
        }
      />

      {groupMode ? (
        <Pressable
          style={[
            styles.createBtn,
            (creating || selected.length < 2 || !groupName.trim()) &&
              styles.disabled,
          ]}
          onPress={createGroup}
          disabled={creating || selected.length < 2 || !groupName.trim()}
        >
          {creating ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.createBtnText}>
              Create Group{selected.length > 0 ? ` (${selected.length})` : ""}
            </Text>
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  modeRow: {
    flexDirection: "row",
    margin: 16,
    marginBottom: 0,
    backgroundColor: theme.surface,
    borderRadius: theme.radiusSm,
    padding: 3,
    gap: 3,
  },
  modeBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingVertical: 9,
    borderRadius: 5,
  },
  modeBtnActive: { backgroundColor: theme.primary },
  modeText: { fontSize: 13, color: theme.textSecondary, fontWeight: "600" },
  modeTextActive: { color: "#fff" },
  groupNameInput: {
    marginHorizontal: 16,
    marginTop: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: theme.radiusSm,
    backgroundColor: theme.inputBg,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    color: theme.text,
    fontSize: 15,
  },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    margin: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: theme.radiusSm,
    backgroundColor: theme.inputBg,
    borderWidth: 1,
    borderColor: theme.inputBorder,
  },
  input: { flex: 1, color: theme.text, fontSize: 15 },
  selectedRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  selectedChip: {
    backgroundColor: theme.primaryGlow,
    borderRadius: theme.radiusFull,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  selectedChipText: { color: theme.primaryLight, fontSize: 13, fontWeight: "600" },
  list: { paddingHorizontal: 16, gap: 4, paddingBottom: 16 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  body: { flex: 1 },
  name: { fontSize: 15, fontWeight: "600", color: theme.text },
  username: { fontSize: 13, color: theme.textMuted },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: theme.glassBorder,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxOn: { backgroundColor: theme.primary, borderColor: theme.primary },
  empty: { textAlign: "center", color: theme.textMuted, marginTop: 40 },
  createBtn: {
    margin: 16,
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 14,
    alignItems: "center",
  },
  createBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  disabled: { opacity: 0.5 },
});