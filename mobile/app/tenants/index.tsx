import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import {
  Activity,
  Building2,
  ChevronRight,
  CreditCard,
  LayoutDashboard,
  Plus,
  ScrollText,
  Settings2,
  Shield,
  type LucideIcon,
} from "lucide-react-native";
import { useAuth } from "../../src/auth/AuthContext";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import { getTenantOverview, type TenantOverview } from "../../src/admin";

type Section = {
  key: string;
  label: string;
  icon: LucideIcon;
  group: string;
  route: string;
};

const SECTIONS: Section[] = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard, group: "Overview", route: "/tenants/dashboard" },
  { key: "tenants", label: "Tenants", icon: Building2, group: "Tenants", route: "/tenants/list" },
  { key: "create", label: "New Tenant", icon: Plus, group: "Tenants", route: "/tenants/create" },
  { key: "plans", label: "Plans", icon: CreditCard, group: "Configuration", route: "/tenants/plans" },
  { key: "admins", label: "Platform Admins", icon: Shield, group: "Access", route: "/tenants/admins" },
  { key: "settings", label: "Platform Settings", icon: Settings2, group: "Access", route: "/tenants/settings" },
  { key: "audit", label: "Audit Trail", icon: ScrollText, group: "Compliance", route: "/tenants/audit" },
];

const GROUP_ORDER = ["Overview", "Tenants", "Configuration", "Access", "Compliance"];

export default function PlatformConsole() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const { user } = useAuth();
  const [overview, setOverview] = useState<TenantOverview | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    getTenantOverview()
      .then((r) => setOverview(r.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Access gate — platform_admin only.
  if (!user || user.role !== "platform_admin") {
    return (
      <View style={[styles.screen, styles.center]}>
        <Stack.Screen options={{ title: "Platform Console" }} />
        <Shield size={40} color={theme.textMuted} />
        <Text style={styles.denied}>
          Access denied. Platform Admin role required.
        </Text>
      </View>
    );
  }

  const groups = GROUP_ORDER.map((name) => ({
    name,
    items: SECTIONS.filter((s) => s.group === name),
  }));

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: "Platform Console" }} />

      <View style={styles.brandRow}>
        <View style={styles.brandIcon}>
          <Activity size={20} color={theme.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.brandTitle}>Platform Console</Text>
          <Text style={styles.brandSubtitle}>Platform Admin</Text>
        </View>
        {loading ? (
          <ActivityIndicator size="small" color={theme.primary} />
        ) : null}
      </View>

      {/* Quick overview stats */}
      {overview ? (
        <View style={styles.statsRow}>
          <Stat value={overview.total_tenants ?? 0} label="Tenants" />
          <View style={styles.statDivider} />
          <Stat value={overview.by_status?.active ?? 0} label="Active" />
          <View style={styles.statDivider} />
          <Stat value={overview.by_status?.suspended ?? 0} label="Suspended" />
          <View style={styles.statDivider} />
          <Stat value={overview.total_users ?? 0} label="Users" />
        </View>
      ) : null}

      {groups.map((group) => (
        <View key={group.name} style={styles.group}>
          <Text style={styles.groupLabel}>{group.name}</Text>
          <View style={styles.card}>
            {group.items.map((item, i) => (
              <Pressable
                key={item.key}
                style={[
                  styles.row,
                  i < group.items.length - 1 && styles.rowBorder,
                ]}
                onPress={() => router.push(item.route as never)}
                android_ripple={{ color: theme.surfaceHover }}
              >
                <View style={styles.iconWrap}>
                  <item.icon size={18} color={theme.textSecondary} />
                </View>
                <Text style={styles.label}>{item.label}</Text>
                <ChevronRight size={18} color={theme.textMuted} />
              </Pressable>
            ))}
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

function Stat({ value, label }: { value: React.ReactNode; label: string }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { alignItems: "center", justifyContent: "center", gap: 12, padding: 32 },
  denied: {
    color: theme.textSecondary,
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
  },
  container: { padding: 16, gap: 18, paddingBottom: 40 },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusLg,
    padding: 16,
  },
  brandIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: theme.primaryGlow,
    alignItems: "center",
    justifyContent: "center",
  },
  brandTitle: { fontSize: 18, fontWeight: "800", color: theme.text },
  brandSubtitle: { fontSize: 13, color: theme.textMuted },
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
  group: { gap: 8 },
  groupLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: theme.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginLeft: 4,
  },
  card: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusLg,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: theme.border },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: 9,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    alignItems: "center",
    justifyContent: "center",
  },
  label: { flex: 1, fontSize: 15, fontWeight: "500", color: theme.text },
});