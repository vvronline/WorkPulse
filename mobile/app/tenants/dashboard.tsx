import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack } from "expo-router";
import { Building2, CheckCircle2, Pause, Users } from "lucide-react-native";
import { theme } from "../../src/theme";
import {
  getTenantAlerts,
  getTenantOverview,
  type TenantOverview,
} from "../../src/admin";

export default function PlatformDashboardScreen() {
  const [overview, setOverview] = useState<TenantOverview | null>(null);
  const [alerts, setAlerts] = useState<unknown[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [oRes, aRes] = await Promise.allSettled([
      getTenantOverview(),
      getTenantAlerts(),
    ]);
    if (oRes.status === "fulfilled") setOverview(oRes.value.data);
    if (aRes.status === "fulfilled")
      setAlerts(Array.isArray(aRes.value.data) ? aRes.value.data : []);
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
          value={overview?.total ?? 0}
          label="Total tenants"
        />
        <StatTile
          icon={<CheckCircle2 size={20} color={theme.success} />}
          value={overview?.active ?? 0}
          label="Active"
        />
        <StatTile
          icon={<Pause size={20} color={theme.warning} />}
          value={overview?.suspended ?? 0}
          label="Suspended"
        />
        <StatTile
          icon={<Users size={20} color={theme.primary} />}
          value={overview?.totalUsers ?? 0}
          label="Total users"
        />
      </View>

      <Text style={styles.sectionTitle}>Alerts</Text>
      {alerts.length === 0 ? (
        <Text style={styles.empty}>No active alerts.</Text>
      ) : (
        alerts.map((a, i) => (
          <View key={i} style={styles.alertCard}>
            <Text style={styles.alertText}>
              {typeof a === "string" ? a : JSON.stringify(a)}
            </Text>
          </View>
        ))
      )}
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
  container: { padding: 16, gap: 14, paddingBottom: 40 },
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
  alertCard: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radius,
    padding: 14,
  },
  alertText: { fontSize: 13, color: theme.textSecondary },
  empty: { color: theme.textMuted, fontSize: 13, paddingVertical: 8 },
});