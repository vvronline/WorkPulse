import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import { Building2, Pause, Play, Search, Trash2, X } from "lucide-react-native";
import { theme } from "../../src/theme";
import {
  deleteTenant,
  getTenants,
  reactivateTenant,
  suspendTenant,
  type Tenant,
} from "../../src/admin";

const STATUS_FILTERS = [
  { key: "", label: "All" },
  { key: "active", label: "Active" },
  { key: "suspended", label: "Suspended" },
];

function statusColor(status?: string): string {
  if (status === "suspended") return theme.warning;
  if (status === "deleted") return theme.danger;
  return theme.success;
}

export default function TenantListScreen() {
  const router = useRouter();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
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
    const params: Record<string, string> = {};
    if (debounced) params.search = debounced;
    if (statusFilter) params.status = statusFilter;
    getTenants(params)
      .then((r) => setTenants(r.data.tenants || []))
      .catch(() => setTenants([]))
      .finally(() => setLoading(false));
  }, [debounced, statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  function suspend(t: Tenant) {
    Alert.prompt?.(
      "Suspend tenant",
      `Reason for suspending ${t.name}?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Suspend",
          style: "destructive",
          onPress: (reason?: string) => {
            suspendTenant(t.id, reason)
              .then(() => load())
              .catch((e: any) =>
                Alert.alert("Error", e?.response?.data?.error || "Failed"),
              );
          },
        },
      ],
      "plain-text",
    ) ??
      // Android fallback (Alert.prompt is iOS-only)
      Alert.alert("Suspend tenant", `Suspend ${t.name}?`, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Suspend",
          style: "destructive",
          onPress: () =>
            suspendTenant(t.id)
              .then(() => load())
              .catch((e: any) =>
                Alert.alert("Error", e?.response?.data?.error || "Failed"),
              ),
        },
      ]);
  }

  function reactivate(t: Tenant) {
    reactivateTenant(t.id)
      .then(() => load())
      .catch((e: any) =>
        Alert.alert("Error", e?.response?.data?.error || "Failed"),
      );
  }

  function confirmDelete(t: Tenant) {
    Alert.alert(
      "Delete tenant",
      `Delete ${t.name}? This is a destructive operation.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () =>
            deleteTenant(t.id)
              .then(() => load())
              .catch((e: any) =>
                Alert.alert("Error", e?.response?.data?.error || "Failed"),
              ),
        },
      ],
    );
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Tenants" }} />

      <View style={styles.searchBar}>
        <Search size={18} color={theme.textMuted} />
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Search tenants…"
          placeholderTextColor={theme.textMuted}
          autoCapitalize="none"
        />
        {search ? (
          <Pressable onPress={() => setSearch("")} hitSlop={8}>
            <X size={18} color={theme.textMuted} />
          </Pressable>
        ) : null}
      </View>

      <View style={styles.filterRow}>
        {STATUS_FILTERS.map((f) => (
          <Pressable
            key={f.key}
            style={[styles.chip, statusFilter === f.key && styles.chipActive]}
            onPress={() => setStatusFilter(f.key)}
          >
            <Text
              style={[
                styles.chipText,
                statusFilter === f.key && styles.chipTextActive,
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
          data={tenants}
          keyExtractor={(t) => String(t.id)}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <Pressable
              style={styles.card}
              onPress={() => router.push(`/tenants/${item.id}` as never)}
              android_ripple={{ color: theme.surfaceHover }}
            >
              <View style={styles.iconWrap}>
                <Building2 size={18} color={theme.primary} />
              </View>
              <View style={styles.body}>
                <Text style={styles.name} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={styles.meta} numberOfLines={1}>
                  {[
                    item.plan,
                    item.user_count != null ? `${item.user_count} users` : null,
                    item.custom_domain,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "—"}
                </Text>
              </View>
              <View style={styles.actions}>
                <View
                  style={[
                    styles.statusPill,
                    { backgroundColor: statusColor(item.status) + "22" },
                  ]}
                >
                  <Text
                    style={[
                      styles.statusText,
                      { color: statusColor(item.status) },
                    ]}
                  >
                    {item.status || "active"}
                  </Text>
                </View>
                {item.status === "suspended" ? (
                  <Pressable
                    onPress={() => reactivate(item)}
                    hitSlop={6}
                    style={styles.iconBtn}
                  >
                    <Play size={15} color={theme.success} />
                  </Pressable>
                ) : item.status !== "deleted" ? (
                  <Pressable
                    onPress={() => suspend(item)}
                    hitSlop={6}
                    style={styles.iconBtn}
                  >
                    <Pause size={15} color={theme.warning} />
                  </Pressable>
                ) : null}
                <Pressable
                  onPress={() => confirmDelete(item)}
                  hitSlop={6}
                  style={styles.iconBtn}
                >
                  <Trash2 size={15} color={theme.danger} />
                </Pressable>
              </View>
            </Pressable>
          )}
          ListEmptyComponent={
            <Text style={styles.empty}>No tenants found.</Text>
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
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radius,
    padding: 12,
  },
  iconWrap: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: theme.primaryGlow,
    alignItems: "center",
    justifyContent: "center",
  },
  body: { flex: 1, gap: 2 },
  name: { fontSize: 15, fontWeight: "600", color: theme.text },
  meta: { fontSize: 12, color: theme.textSecondary },
  actions: { alignItems: "flex-end", gap: 6 },
  statusPill: {
    borderRadius: theme.radiusFull,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  statusText: { fontSize: 11, fontWeight: "600", textTransform: "capitalize" },
  iconBtn: { padding: 2 },
  empty: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: "center",
    paddingTop: 32,
  },
});