import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import { PromptModal } from "../../src/components/PromptModal";
import {
  deleteTenant,
  getTenants,
  getTenantOverview,
  reactivateTenant,
  suspendTenant,
  type Tenant,
  type TenantOverview,
} from "../../src/admin";

const STATUS_FILTERS = [
  { key: "", label: "All" },
  { key: "active", label: "Active" },
  { key: "suspended", label: "Suspended" },
  { key: "deleted", label: "Deleted" },
];

function statusColor(theme: Theme, status?: string): string {
  if (status === "suspended") return theme.warning;
  if (status === "deleted") return theme.danger;
  return theme.success;
}

type ConfirmAction = {
  action: "suspend" | "delete";
  tenant: Tenant;
};

export default function TenantListScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [overview, setOverview] = useState<TenantOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Password-confirm modal state for destructive lifecycle actions —
  // mirrors the web TenantDetail confirm flow (server requires the acting
  // platform admin's password for suspend/delete).
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

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
    Promise.allSettled([getTenants(params), getTenantOverview()])
      .then(([tRes, oRes]) => {
        setTenants(
          tRes.status === "fulfilled" ? tRes.value.data.tenants || [] : [],
        );
        if (oRes.status === "fulfilled") setOverview(oRes.value.data);
      })
      .finally(() => setLoading(false));
  }, [debounced, statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  function reactivate(t: Tenant) {
    reactivateTenant(t.id)
      .then(() => load())
      .catch((e: any) =>
        Alert.alert("Error", e?.response?.data?.error || "Failed"),
      );
  }

  async function submitConfirm(values: Record<string, string>) {
    if (!confirm) return;
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      if (confirm.action === "suspend") {
        await suspendTenant(
          confirm.tenant.id,
          values.reason?.trim() || "Suspended by platform admin",
          values.password,
        );
      } else {
        await deleteTenant(confirm.tenant.id, false, values.password);
      }
      setConfirm(null);
      load();
    } catch (e: any) {
      setConfirmError(e?.response?.data?.error || "Action failed");
    } finally {
      setConfirmBusy(false);
    }
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

      {overview ? (
        <View style={styles.statsRow}>
          <View style={styles.stat}>
            <Text style={styles.statValue}>{overview.total_tenants ?? 0}</Text>
            <Text style={styles.statLabel}>Tenants</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.stat}>
            <Text style={styles.statValue}>{overview.total_users ?? 0}</Text>
            <Text style={styles.statLabel}>Users</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.stat}>
            <Text style={[styles.statValue, { color: theme.success }]}>
              {overview.by_status?.active ?? 0}
            </Text>
            <Text style={styles.statLabel}>Active</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.stat}>
            <Text style={[styles.statValue, { color: theme.warning }]}>
              {overview.by_status?.suspended ?? 0}
            </Text>
            <Text style={styles.statLabel}>Suspended</Text>
          </View>
        </View>
      ) : null}

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
              style={({ pressed }) => [styles.card, pressed && { opacity: 0.6 }]}
              onPress={() => router.push(`/tenants/${item.id}` as never)}
            >
              <View style={styles.iconWrap}>
                <Building2 size={18} color={theme.primary} />
              </View>
              <View style={styles.body}>
                <Text style={styles.name} numberOfLines={1}>
                  {item.org_name}
                </Text>
                <Text style={styles.meta} numberOfLines={1}>
                  {[
                    item.slug,
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
                    { backgroundColor: statusColor(theme, item.status) + "22" },
                  ]}
                >
                  <Text
                    style={[
                      styles.statusText,
                      { color: statusColor(theme, item.status) },
                    ]}
                  >
                    {item.status || "active"}
                  </Text>
                </View>
                <View style={styles.actionBtns}>
                  {item.status === "suspended" ? (
                    <Pressable
                      onPress={() => reactivate(item)}
                      hitSlop={6}
                      style={styles.iconBtn}
                    >
                      <Play size={15} color={theme.success} />
                    </Pressable>
                  ) : item.status !== "deleted" && !item.is_default ? (
                    <Pressable
                      onPress={() =>
                        setConfirm({ action: "suspend", tenant: item })
                      }
                      hitSlop={6}
                      style={styles.iconBtn}
                    >
                      <Pause size={15} color={theme.warning} />
                    </Pressable>
                  ) : null}
                  {!item.is_default && item.status !== "deleted" ? (
                    <Pressable
                      onPress={() =>
                        setConfirm({ action: "delete", tenant: item })
                      }
                      hitSlop={6}
                      style={styles.iconBtn}
                    >
                      <Trash2 size={15} color={theme.danger} />
                    </Pressable>
                  ) : null}
                </View>
              </View>
            </Pressable>
          )}
          ListEmptyComponent={
            <Text style={styles.empty}>No tenants found.</Text>
          }
        />
      )}

      <PromptModal
        visible={!!confirm}
        title={
          confirm?.action === "suspend" ? "Suspend tenant" : "Delete tenant"
        }
        message={
          confirm
            ? confirm.action === "suspend"
              ? `This will suspend "${confirm.tenant.org_name}" and block all its users from signing in. Re-enter your password to confirm.`
              : `This will mark "${confirm.tenant.org_name}" as deleted. This action is recorded in the audit log. Re-enter your password to confirm.`
            : undefined
        }
        fields={
          confirm?.action === "suspend"
            ? [
                {
                  key: "reason",
                  label: "Reason (optional)",
                  placeholder: "Reason for suspension",
                },
                {
                  key: "password",
                  label: "Your password",
                  placeholder: "Enter your password",
                  secure: true,
                  required: true,
                },
              ]
            : [
                {
                  key: "password",
                  label: "Your password",
                  placeholder: "Enter your password",
                  secure: true,
                  required: true,
                },
              ]
        }
        confirmLabel={confirm?.action === "suspend" ? "Suspend" : "Delete"}
        destructive
        busy={confirmBusy}
        error={confirmError}
        onCancel={() => {
          setConfirm(null);
          setConfirmError(null);
        }}
        onSubmit={submitConfirm}
      />
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
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
  statsRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radius,
    padding: 12,
    marginHorizontal: 16,
    marginBottom: 8,
  },
  stat: { flex: 1, alignItems: "center", gap: 2 },
  statValue: { fontSize: 17, fontWeight: "800", color: theme.primary },
  statLabel: {
    fontSize: 9,
    color: theme.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  statDivider: { width: 1, height: 24, backgroundColor: theme.border },
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
  actionBtns: { flexDirection: "row", gap: 4 },
  statusPill: {
    borderRadius: theme.radiusFull,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  statusText: { fontSize: 11, fontWeight: "600", textTransform: "capitalize" },
  iconBtn: { padding: 4 },
  empty: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: "center",
    paddingTop: 32,
  },
});