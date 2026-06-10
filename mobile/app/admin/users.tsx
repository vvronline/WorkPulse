import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import { Ban, CheckCircle2, Search, X } from "lucide-react-native";
import { theme } from "../../src/theme";
import { uploadUrl } from "../../src/config";
import { roleLabel } from "../../src/constants/roles";
import { getAdminUsers, type AdminUser } from "../../src/admin";

function initials(name?: string) {
  if (!name) return "?";
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "?";
}

const FILTERS = [
  { key: "all", label: "All" },
  { key: "active", label: "Active" },
  { key: "inactive", label: "Inactive" },
  { key: "admins", label: "Admins" },
];

export default function AdminUsersScreen() {
  const router = useRouter();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [filter, setFilter] = useState("all");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setDebounced(search), 300);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [search]);

  const load = useCallback(() => {
    setLoading(true);
    const params: Record<string, string | number> = { per_page: 100 };
    if (debounced) params.search = debounced;
    if (filter === "active") params.is_active = "true";
    if (filter === "inactive") params.is_active = "false";
    getAdminUsers(params)
      .then((r) => {
        let rows = r.data.data || [];
        if (filter === "admins") {
          rows = rows.filter((u) =>
            ["hr_admin", "super_admin", "platform_admin"].includes(u.role),
          );
        }
        setUsers(rows);
      })
      .catch(() => setUsers([]))
      .finally(() => setLoading(false));
  }, [debounced, filter]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Users" }} />

      <View style={styles.searchBar}>
        <Search size={18} color={theme.textMuted} />
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Search users…"
          placeholderTextColor={theme.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {search ? (
          <Pressable onPress={() => setSearch("")} hitSlop={8}>
            <X size={18} color={theme.textMuted} />
          </Pressable>
        ) : null}
      </View>

      <View style={styles.filterRow}>
        {FILTERS.map((f) => (
          <Pressable
            key={f.key}
            style={[styles.chip, filter === f.key && styles.chipActive]}
            onPress={() => setFilter(f.key)}
          >
            <Text
              style={[
                styles.chipText,
                filter === f.key && styles.chipTextActive,
              ]}
            >
              {f.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.primary} />
        </View>
      ) : (
        <FlatList
          data={users}
          keyExtractor={(u) => String(u.id)}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => {
            const avatar = uploadUrl(item.avatar);
            return (
              <Pressable
                style={styles.userCard}
                onPress={() => router.push(`/admin/user/${item.id}` as never)}
                android_ripple={{ color: theme.surfaceHover }}
              >
                <View style={[styles.avatar, !item.is_active && styles.avatarMuted]}>
                  {avatar ? (
                    <Image source={{ uri: avatar }} style={styles.avatarImg} />
                  ) : (
                    <Text style={styles.avatarText}>
                      {initials(item.full_name)}
                    </Text>
                  )}
                </View>
                <View style={styles.userBody}>
                  <Text style={styles.userName} numberOfLines={1}>
                    {item.full_name}
                  </Text>
                  <Text style={styles.userMeta} numberOfLines={1}>
                    {[item.department_name, item.team_name]
                      .filter(Boolean)
                      .join(" · ") ||
                      item.email ||
                      `@${item.username}`}
                  </Text>
                </View>
                <View style={styles.userRight}>
                  <View style={styles.roleBadge}>
                    <Text style={styles.roleText}>{roleLabel(item.role)}</Text>
                  </View>
                  {item.is_active ? (
                    <CheckCircle2 size={14} color={theme.success} />
                  ) : (
                    <Ban size={14} color={theme.danger} />
                  )}
                </View>
              </Pressable>
            );
          }}
          ListEmptyComponent={
            <Text style={styles.empty}>No users found.</Text>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: theme.inputBg,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 12,
    margin: 16,
    marginBottom: 8,
  },
  searchInput: { flex: 1, color: theme.text, fontSize: 15, paddingVertical: 11 },
  filterRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: theme.radiusFull,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
  },
  chipActive: { backgroundColor: theme.primary, borderColor: theme.primary },
  chipText: { fontSize: 13, color: theme.textSecondary, fontWeight: "500" },
  chipTextActive: { color: "#fff", fontWeight: "600" },
  list: { padding: 16, paddingTop: 4, gap: 10, paddingBottom: 40 },
  userCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radius,
    padding: 12,
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarMuted: { opacity: 0.5 },
  avatarImg: { width: 42, height: 42, borderRadius: 21 },
  avatarText: { color: "#fff", fontSize: 14, fontWeight: "700" },
  userBody: { flex: 1, gap: 2 },
  userName: { fontSize: 15, fontWeight: "600", color: theme.text },
  userMeta: { fontSize: 12, color: theme.textSecondary },
  userRight: { alignItems: "flex-end", gap: 5 },
  roleBadge: {
    backgroundColor: theme.primaryGlow,
    borderRadius: theme.radiusFull,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  roleText: {
    color: theme.primaryLight,
    fontSize: 11,
    fontWeight: "600",
  },
  empty: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: "center",
    paddingTop: 32,
  },
});