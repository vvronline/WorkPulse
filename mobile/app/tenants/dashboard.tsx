import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Pause,
  Users,
} from "lucide-react-native";
import { theme } from "../../src/theme";
import {
  getTenantAlerts,
  getTenantOverview,
  type TenantAlert,
  type TenantOverview,
} from "../../src/admin";

function alertLabel(type: string): string {
  switch (type) {
    case "users_approaching_limit":
      return "Users at limit";
    case "storage_approaching_limit":
      return "Storage at limit";
    case "no_active_super_admin":
      return "No active admin";
    default:
      return type.replace(/_/g, " ");
  }
}

function alertColor(type: string): string {
  return type === "no_active_super_admin" ? theme.danger : theme.warning;
}

export default function PlatformDashboardScreen() {
  const router = useRouter();
  const [overview, setOverview] = useState<TenantOverview | null>(null);
  const [alerts, setAlerts] = useState<TenantAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [oRes, aRes] = await Promise.allSettled([
      getTenantOverview(),
      getTenantAlerts(),
    ]);
    if (oRes.status === "fulfilled") setOverview(oRes.value.data);
    if (aRes.status === "fulfilled")
      setAlerts(aRes.value.data?.alerts || []);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Stack.Screen options={{ title: "Dashboard" }} />
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  const byStatus = overview?.by_status || {};
  const byPlan = overview?.by_plan || {};
  const recent = overview?.recent || [];

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            load();
          }}
          tintColor={theme.primary}
        />
      }
    >
      <Stack.Screen options={{ title: "Dashboard" }} />

      <View style={styles.statsGrid}>
        <StatTile
          icon={<Building2 size={20} color={theme.primary} />}
          value={overview?.total_tenants ?? 0}
          label="Total tenants"
        />
        <StatTile
          icon={<Users size={20} color={theme.primary} />}
          value={overview?.total_users ?? 0}
          label="Total users"
        />
        <StatTile
          icon={<CheckCircle2 size={20} color={theme.success} />}
          value={byStatus.active ?? 0}
          label="Active"
        />
        <StatTile
          icon={<Pause size={20} color={theme.warning} />}
          value={byStatus.suspended ?? 0}
          label="Suspended"
        />
      </View>

      {/* Plan distribution */}
      {Object.keys(byPlan).length > 0 ? (
        <>
          <Text style={styles.sectionTitle}>Plan distribution</Text>
          <View style={styles.planRow}>
            {Object.entries(byPlan).map(([plan, count]) => (
              <View key={plan} style={styles.planTile}>
                <Text style={styles.planCount}>{count}</Text>
                <Text style={styles.planName}>{plan}</Text>
              </View>
            ))}
          </View>
        </>
      ) : null}

      {/* Alerts */}
      <View style={styles.sectionHeaderRow}>
        <AlertTriangle size={15} color={theme.textSecondary} />
        <Text style={styles.sectionTitle}>Alerts ({alerts.length})</Text>
      </View>
      {alerts.length === 0 ? (
        <Text style={styles.empty}>No alerts — all tenants within limits.</Text>
      ) : (
        alerts.map((a, i) => (
          <View key={`${a.tenant_id}-${a.alert_type}-${i}`} style={styles.alertCard}>
            <View style={styles.alertHeader}>
              <Text style={styles.alertTenant} numberOfLines={1}>
                {a.tenant_name}
              </Text>
              <View
                style={[
                  styles.alertPill,
                  { backgroundColor: alertColor(a.alert_type) + "22" },
                ]}
              >
                <Text
                  style={[styles.alertPillText, { color: alertColor(a.alert_type) }]}
                >
                  {alertLabel(a.alert_type)}
                </Text>
              </View>
            </View>
            <Text style={styles.alertMeta}>
              {a.alert_type === "no_active_super_admin"
                ? a.slug
                : `${a.slug} · ${a.current_value}${
                    a.alert_type === "storage_approaching_limit" ? " MB" : ""
                  } / ${a.limit_value}${
                    a.alert_type === "storage_approaching_limit" ? " MB" : ""
                  } (${a.percentage}%)`}
            </Text>
          </View>
        ))
      )}

      {/* Recently created tenants */}
      {recent.length > 0 ? (
        <>
          <Text style={styles.sectionTitle}>Recently created</Text>
          {recent.map((t) => (
            <Pressable
              key={t.id}
              style={styles.recentCard}
              onPress={() => router.push(`/tenants/${t.id}` as never)}
              android_ripple={{ color: theme.surfaceHover }}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.recentName} numberOfLines={1}>
                  {t.org_name}
                </Text>
                <Text style={styles.recentMeta}>
                  {t.slug} · {new Date(t.created_at).toLocaleDateString()}
                </Text>
              </View>
              <View
                style={[
                  styles.alertPill,
                  {
                    backgroundColor:
                      (t.status === "active" ? theme.success : theme.warning) +
                      "22",
                  },
                ]}
              >
                <Text
                  style={[
                    styles.alertPillText,
                    {
                      color:
                        t.status === "active" ? theme.success : theme.warning,
                    },
                  ]}
                >
                  {t.status}
                </Text>
              </View>
            </Pressable>
          ))}
        </>
      ) : null}
    </ScrollView>
  );
}

function StatTile({
  icon,
  value,
  label,
}: {
  icon: React.ReactNode;
  value: React.ReactNode;
  label: string;
}) {
  return (
    <View style={styles.statTile}>
      {icon}
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { alignItems: "center", justifyContent: "center" },
  container: { padding: 16, gap: 12, paddingBottom: 40 },
  statsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  statTile: {
    width: "47%",
    flexGrow: 1,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radius,
    padding: 16,
    alignItems: "center",
    gap: 4,
  },
  statValue: { fontSize: 22, fontWeight: "800", color: theme.text },
  statLabel: {
    fontSize: 11,
    color: theme.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  sectionTitle: { fontSize: 15, fontWeight: "700", color: theme.text, marginTop: 6 },
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 6,
  },
  planRow: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  planTile: {
    minWidth: 90,
    flexGrow: 1,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radius,
    padding: 14,
    alignItems: "center",
    gap: 2,
  },
  planCount: { fontSize: 20, fontWeight: "800", color: theme.primary },
  planName: {
    fontSize: 11,
    color: theme.textSecondary,
    textTransform: "capitalize",
  },
  alertCard: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radius,
    padding: 14,
    gap: 6,
  },
  alertHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  alertTenant: { flex: 1, fontSize: 14, fontWeight: "700", color: theme.text },
  alertPill: {
    borderRadius: theme.radiusFull,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  alertPillText: { fontSize: 11, fontWeight: "600", textTransform: "capitalize" },
  alertMeta: { fontSize: 12, color: theme.textSecondary },
  recentCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radius,
    padding: 12,
  },
  recentName: { fontSize: 14, fontWeight: "600", color: theme.text },
  recentMeta: { fontSize: 12, color: theme.textMuted },
  empty: { color: theme.textMuted, fontSize: 13, paddingVertical: 8 },
});