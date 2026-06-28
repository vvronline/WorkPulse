import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  AlarmClock,
  ArrowRight,
  Building,
  CheckCircle2,
  Circle,
  ClipboardList,
  RefreshCw,
  Settings as SettingsIcon,
  UserPlus,
  Users,
  UsersRound,
} from "lucide-react-native";
import { useAuth } from "../../src/auth/AuthContext";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import {
  getAdminStats,
  getRoleChangeRequests,
  type AdminStats,
} from "../../src/admin";
import {
  getApprovals,
  getCurrentOrg,
  getOrgDepartments,
  getOrgTeams,
  getLeavePolicies,
} from "../../src/features";

type SetupState = {
  tzSet: boolean;
  hasDept: boolean;
  hasTeam: boolean;
  hasPolicy: boolean;
  loaded: boolean;
};

const DEFAULT_SETUP: SetupState = {
  tzSet: false,
  hasDept: false,
  hasTeam: false,
  hasPolicy: false,
  loaded: false,
};

export default function AdminHomeScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const { data, isLoading: loading } = useQuery({
    queryKey: ["admin", "home"],
    queryFn: async () => {
      const [statsR, rolesR, apprR] = await Promise.allSettled([
        getAdminStats(),
        getRoleChangeRequests({ status: "pending" }),
        getApprovals({ status: "pending" }),
      ]);
      let stats: AdminStats | null = null;
      let pendingRoleRequests = 0;
      let pendingApprovals = 0;
      if (statsR.status === "fulfilled") stats = statsR.value.data;
      if (rolesR.status === "fulfilled")
        pendingRoleRequests = (rolesR.value.data || []).length;
      if (apprR.status === "fulfilled") {
        const d = apprR.value.data as unknown;
        const arr = Array.isArray(d) ? d : ((d as any)?.data ?? []);
        pendingApprovals = arr.length;
      }

      let setup: SetupState = { ...DEFAULT_SETUP, loaded: true };
      if (user?.org_id) {
        const [orgR, deptR, teamR, polR] = await Promise.allSettled([
          getCurrentOrg(),
          getOrgDepartments(),
          getOrgTeams(),
          getLeavePolicies(),
        ]);
        const org = orgR.status === "fulfilled" ? orgR.value.data : null;
        const depts =
          deptR.status === "fulfilled" ? deptR.value.data || [] : [];
        const teams =
          teamR.status === "fulfilled" ? teamR.value.data || [] : [];
        const pols = polR.status === "fulfilled" ? polR.value.data || [] : [];
        setup = {
          tzSet: !!(org?.timezone && org.timezone !== "UTC"),
          hasDept: depts.length > 0,
          hasTeam: teams.length > 0,
          hasPolicy: pols.length > 0,
          loaded: true,
        };
      }

      return { stats, pendingRoleRequests, pendingApprovals, setup };
    },
  });

  const stats = data?.stats ?? null;
  const pendingRoleRequests = data?.pendingRoleRequests ?? 0;
  const pendingApprovals = data?.pendingApprovals ?? 0;
  const setup = data?.setup ?? DEFAULT_SETUP;

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Stack.Screen options={{ title: "Admin Panel" }} />
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  const checklist = [
    {
      key: "tzSet",
      label: "Set organization timezone & work hours",
      route: "/admin/org-settings",
      done: setup.tzSet,
    },
    {
      key: "hasDept",
      label: "Create at least one department",
      route: "/admin/departments",
      done: setup.hasDept,
    },
    {
      key: "hasTeam",
      label: "Create at least one team",
      route: "/admin/teams",
      done: setup.hasTeam,
    },
    {
      key: "hasPolicy",
      label: "Define a leave policy",
      route: "/admin/org-settings",
      done: setup.hasPolicy,
    },
  ];
  const setupProgress = checklist.filter((c) => c.done).length;
  const setupComplete = setupProgress === checklist.length;

  const attention: {
    key: string;
    value: React.ReactNode;
    label: string;
    action: string;
    route: string;
    color: string;
  }[] = [];
  if (pendingRoleRequests > 0) {
    attention.push({
      key: "role-requests",
      value: pendingRoleRequests,
      label:
        pendingRoleRequests === 1
          ? "role change request needs review"
          : "role change requests need review",
      action: "Review now",
      route: "/admin/role-requests",
      color: theme.warning,
    });
  }
  if (pendingApprovals > 0) {
    attention.push({
      key: "approvals",
      value: pendingApprovals,
      label:
        pendingApprovals === 1
          ? "leave / overtime approval pending"
          : "leave / overtime approvals pending",
      action: "Open queue",
      route: "/team",
      color: theme.warning,
    });
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await queryClient.invalidateQueries({
              queryKey: ["admin", "home"],
            });
            setRefreshing(false);
          }}
          tintColor={theme.primary}
        />
      }
    >
      <Stack.Screen options={{ title: "Admin Panel" }} />
      <Text style={styles.heading}>
        Welcome back, {user?.full_name || user?.username}
      </Text>

      {/* Attention cards */}
      {attention.map((a) => (
        <Pressable
          key={a.key}
          style={({ pressed }) => [styles.attnCard, pressed && { opacity: 0.6 }]}
          onPress={() => router.push(a.route as never)}
        >
          <View style={[styles.attnIcon, { backgroundColor: a.color + "22" }]}>
            {a.key === "role-requests" ? (
              <RefreshCw size={18} color={a.color} />
            ) : (
              <ClipboardList size={18} color={a.color} />
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.attnValue}>{a.value}</Text>
            <Text style={styles.attnLabel}>{a.label}</Text>
            <View style={styles.attnActionRow}>
              <Text style={styles.attnAction}>{a.action}</Text>
              <ArrowRight size={12} color={theme.primary} />
            </View>
          </View>
        </Pressable>
      ))}

      {/* Stats grid */}
      {stats ? (
        <View style={styles.statsGrid}>
          <StatTile
            icon={<CheckCircle2 size={20} color={theme.primary} />}
            value={stats.activeUsers ?? 0}
            label="Active users"
          />
          <StatTile
            icon={<Users size={20} color={theme.primary} />}
            value={stats.totalUsers ?? 0}
            label="Total users"
          />
          <StatTile
            icon={<Building size={20} color={theme.primary} />}
            value={stats.departments ?? 0}
            label="Departments"
          />
          <StatTile
            icon={<UsersRound size={20} color={theme.primary} />}
            value={stats.teams ?? 0}
            label="Teams"
          />
          <StatTile
            icon={<AlarmClock size={20} color={theme.primary} />}
            value={stats.clockedInToday ?? 0}
            label="Clocked-in"
          />
        </View>
      ) : null}

      {/* Quick actions */}
      <Text style={styles.sectionTitle}>Quick actions</Text>
      <View style={styles.quickRow}>
        <QuickBtn
          icon={<UserPlus size={15} color={theme.text} />}
          label="Add people"
          onPress={() => router.push("/admin/add-people")}
        />
        {user?.org_id ? (
          <QuickBtn
            icon={<Building size={15} color={theme.text} />}
            label="Departments"
            onPress={() => router.push("/admin/departments")}
          />
        ) : null}
        {user?.org_id ? (
          <QuickBtn
            icon={<UsersRound size={15} color={theme.text} />}
            label="Teams"
            onPress={() => router.push("/admin/teams")}
          />
        ) : null}
        <QuickBtn
          icon={<SettingsIcon size={15} color={theme.text} />}
          label="Audit logs"
          onPress={() => router.push("/admin/audit")}
        />
      </View>

      {/* Setup checklist */}
      {user?.org_id ? (
        <>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Setup checklist</Text>
            <Text style={styles.sectionHint}>
              {setupProgress}/{checklist.length} done
            </Text>
          </View>
          <View style={styles.card}>
            {checklist.map((item, i) => (
              <Pressable
                key={item.key}
                style={({ pressed }) => [
                  styles.checkRow,
                  i < checklist.length - 1 && styles.rowBorder,
                  pressed && { opacity: 0.6 },
                ]}
                onPress={() => router.push(item.route as never)}
              >
                {item.done ? (
                  <CheckCircle2 size={18} color={theme.success} />
                ) : (
                  <Circle size={18} color={theme.textMuted} />
                )}
                <Text
                  style={[
                    styles.checkLabel,
                    item.done && styles.checkLabelDone,
                  ]}
                >
                  {item.label}
                </Text>
                {!item.done ? (
                  <ArrowRight size={14} color={theme.textMuted} />
                ) : null}
              </Pressable>
            ))}
          </View>
          {setupComplete ? (
            <Text style={styles.completeHint}>
              ✓ Your organization is fully set up.
            </Text>
          ) : null}
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
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View style={styles.statTile}>
      {icon}
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function QuickBtn({
  icon,
  label,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <Pressable
      style={({ pressed }) => [styles.quickBtn, pressed && { opacity: 0.6 }]}
      onPress={onPress}
    >
      {icon}
      <Text style={styles.quickBtnText}>{label}</Text>
    </Pressable>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.bg },
    center: { alignItems: "center", justifyContent: "center" },
    container: { padding: 16, gap: 14, paddingBottom: 40 },
    heading: {
      fontSize: 20,
      fontWeight: "800",
      color: theme.text,
      letterSpacing: -0.4,
    },
    attnCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radiusLg,
      padding: 14,
    },
    attnIcon: {
      width: 38,
      height: 38,
      borderRadius: 10,
      alignItems: "center",
      justifyContent: "center",
    },
    attnValue: { fontSize: 22, fontWeight: "800", color: theme.text },
    attnLabel: { fontSize: 13, color: theme.textSecondary },
    attnActionRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      marginTop: 4,
    },
    attnAction: { fontSize: 12, fontWeight: "600", color: theme.primary },
    statsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
    statTile: {
      width: "31%",
      flexGrow: 1,
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radius,
      padding: 14,
      alignItems: "center",
      gap: 4,
    },
    statValue: { fontSize: 20, fontWeight: "800", color: theme.text },
    statLabel: {
      fontSize: 10,
      color: theme.textMuted,
      textTransform: "uppercase",
      letterSpacing: 0.3,
      textAlign: "center",
    },
    sectionTitle: {
      fontSize: 15,
      fontWeight: "700",
      color: theme.text,
      marginTop: 4,
    },
    sectionHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: 4,
    },
    sectionHint: { fontSize: 12, color: theme.textMuted },
    quickRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    quickBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radiusSm,
      paddingHorizontal: 12,
      paddingVertical: 9,
    },
    quickBtnText: { color: theme.text, fontSize: 13, fontWeight: "500" },
    card: {
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radiusLg,
      overflow: "hidden",
    },
    checkRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    rowBorder: { borderBottomWidth: 1, borderBottomColor: theme.border },
    checkLabel: { flex: 1, fontSize: 14, color: theme.text },
    checkLabelDone: {
      color: theme.textMuted,
      textDecorationLine: "line-through",
    },
    completeHint: { fontSize: 13, color: theme.success, marginTop: 4 },
  });
