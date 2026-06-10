import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { Building2, Pause, Play, Users } from "lucide-react-native";
import { theme } from "../../src/theme";
import { roleLabel } from "../../src/constants/roles";
import {
  getTenant,
  getTenantStats,
  getTenantUsers,
  reactivateTenant,
  suspendTenant,
  type Tenant,
  type TenantStats,
  type TenantUser,
} from "../../src/admin";

function statusColor(status?: string): string {
  if (status === "suspended") return theme.warning;
  if (status === "deleted") return theme.danger;
  return theme.success;
}

export default function TenantDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [stats, setStats] = useState<TenantStats | null>(null);
  const [users, setUsers] = useState<TenantUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [tRes, sRes, uRes] = await Promise.allSettled([
      getTenant(id),
      getTenantStats(id),
      getTenantUsers(id, { per_page: 50 }),
    ]);
    if (tRes.status === "fulfilled") setTenant(tRes.value.data);
    if (sRes.status === "fulfilled") setStats(sRes.value.data);
    if (uRes.status === "fulfilled") {
      const d = uRes.value.data;
      setUsers(d.data ?? d.users ?? []);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading || !tenant) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Stack.Screen options={{ title: "Tenant" }} />
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  function toggleStatus() {
    if (!tenant) return;
    const isSuspended = tenant.status === "suspended";
    const action = isSuspended ? "Reactivate" : "Suspend";
    Alert.alert(`${action} tenant`, `${action} ${tenant.name}?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: action,
        style: isSuspended ? "default" : "destructive",
        onPress: async () => {
          setBusy(true);
          try {
            if (isSuspended) await reactivateTenant(tenant.id);
            else await suspendTenant(tenant.id);
            await load();
          } catch (e: any) {
            Alert.alert("Error", e?.response?.data?.error || "Failed");
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: tenant.name }} />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.icon}>
          <Building2 size={26} color={theme.primary} />
        </View>
        <Text style={styles.name}>{tenant.name}</Text>
        {tenant.custom_domain ? (
          <Text style={styles.domain}>{tenant.custom_domain}</Text>
        ) : null}
        <View
          style={[
            styles.statusPill,
            { backgroundColor: statusColor(tenant.status) + "22" },
          ]}
        >
          <Text style={[styles.statusText, { color: statusColor(tenant.status) }]}>
            {tenant.status || "active"}
          </Text>
        </View>
        {tenant.plan ? (
          <Text style={styles.plan}>Plan: {tenant.plan}</Text>
        ) : null}
      </View>

      {/* Stats */}
      {stats ? (
        <View style={styles.statsRow}>
          <Stat value={stats.users ?? users.length} label="Users" />
          <View style={styles.statDivider} />
          <Stat value={stats.activeUsers ?? 0} label="Active" />
          <View style={styles.statDivider} />
          <Stat value={stats.tasks ?? 0} label="Tasks" />
        </View>
      ) : null}

      {/* Action */}
      {tenant.status !== "deleted" ? (
        <Pressable
          style={[
            styles.actionBtn,
            tenant.status === "suspended" ? styles.reactivateBtn : styles.suspendBtn,
          ]}
          onPress={toggleStatus}
          disabled={busy}
        >
          {tenant.status === "suspended" ? (
            <Play size={16} color="#fff" />
          ) : (
            <Pause size={16} color={theme.warning} />
          )}
          <Text
            style={[
              styles.actionBtnText,
              tenant.status === "suspended"
                ? { color: "#fff" }
                : { color: theme.warning },
            ]}
          >
            {tenant.status === "suspended" ? "Reactivate tenant" : "Suspend tenant"}
          </Text>
        </Pressable>
      ) : null}

      {/* Users */}
      <View style={styles.sectionHeader}>
        <Users size={15} color={theme.textSecondary} />
        <Text style={styles.sectionTitle}>Users ({users.length})</Text>
      </View>
      {users.length === 0 ? (
        <Text style={styles.empty}>No users.</Text>
      ) : (
        users.map((u) => (
          <View key={u.id} style={styles.userCard}>
            <View style={styles.userBody}>
              <Text style={styles.userName} numberOfLines={1}>
                {u.full_name}
              </Text>
              <Text style={styles.userMeta} numberOfLines={1}>
                {u.email || `@${u.username}`}
              </Text>
            </View>
            <View style={styles.roleBadge}>
              <Text style={styles.roleText}>{roleLabel(u.role)}</Text>
            </View>
          </View>
        ))
      )}
    </ScrollView>
  );
}

function Stat({ value, label }: { value: React.ReactNode; label: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { alignItems: "center", justifyContent: "center" },
  container: { padding: 16, gap: 16, paddingBottom: 48 },
  header: {
    alignItems: "center",
    gap: 6,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusLg,
    padding: 20,
  },
  icon: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: theme.primaryGlow,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  name: { fontSize: 20, fontWeight: "800", color: theme.text },
  domain: { fontSize: 13, color: theme.textMuted },
  statusPill: {
    borderRadius: theme.radiusFull,
    paddingHorizontal: 12,
    paddingVertical: 4,
    marginTop: 4,
  },
  statusText: { fontSize: 12, fontWeight: "600", textTransform: "capitalize" },
  plan: { fontSize: 13, color: theme.textSecondary, marginTop: 4 },
  statsRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusLg,
    padding: 16,
  },
  stat: { flex: 1, alignItems: "center", gap: 2 },
  statValue: { fontSize: 20, fontWeight: "800", color: theme.primary },
  statLabel: {
    fontSize: 10,
    color: theme.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  statDivider: { width: 1, height: 28, backgroundColor: theme.border },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: theme.radiusSm,
    paddingVertical: 13,
  },
  suspendBtn: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
  },
  reactivateBtn: { backgroundColor: theme.success },
  actionBtnText: { fontSize: 15, fontWeight: "600" },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 4,
  },
  sectionTitle: { fontSize: 15, fontWeight: "700", color: theme.text },
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
  userBody: { flex: 1, gap: 2 },
  userName: { fontSize: 14, fontWeight: "600", color: theme.text },
  userMeta: { fontSize: 12, color: theme.textSecondary },
  roleBadge: {
    backgroundColor: theme.primaryGlow,
    borderRadius: theme.radiusFull,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  roleText: { color: theme.primaryLight, fontSize: 11, fontWeight: "600" },
  empty: { color: theme.textMuted, fontSize: 13, paddingVertical: 8 },
});