import { useCallback, useMemo } from "react";
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
  Building,
  ChevronRight,
  CreditCard,
  DollarSign,
  Folder,
  GitBranch,
  GitMerge,
  Home,
  Receipt,
  RefreshCw,
  ScrollText,
  Settings as SettingsIcon,
  Shield,
  UserPlus,
  Users,
  UsersRound,
  Wallet,
  Workflow,
  type LucideIcon,
} from "lucide-react-native";
import { useAuth, userHasFeature } from "../../src/auth/AuthContext";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import { getRoleChangeRequests } from "../../src/admin";
import { useQuery } from "@tanstack/react-query";

type Section = {
  key: string;
  label: string;
  icon: LucideIcon;
  group: string;
  route: string;
  requires?: "orgId" | "super" | "approver";
  feature?: string;
  badgeKey?: string;
};

// Mirrors client/src/pages/admin/index.tsx SECTIONS. `route` points to the
// mobile screen for each section.
const SECTIONS: Section[] = [
  {
    key: "home",
    label: "Home",
    icon: Home,
    group: "Overview",
    route: "/admin/home",
  },

  {
    key: "users",
    label: "Users",
    icon: Users,
    group: "People",
    route: "/admin/users",
  },
  {
    key: "add",
    label: "Add People",
    icon: UserPlus,
    group: "People",
    route: "/admin/add-people",
  },
  {
    key: "role-requests",
    label: "Role Requests",
    icon: RefreshCw,
    group: "People",
    route: "/admin/role-requests",
    badgeKey: "roleRequests",
  },

  {
    key: "departments",
    label: "Departments",
    icon: Building,
    group: "Structure",
    route: "/admin/departments",
    requires: "orgId",
  },
  {
    key: "teams",
    label: "Teams",
    icon: UsersRound,
    group: "Structure",
    route: "/admin/teams",
    requires: "orgId",
  },
  {
    key: "org-chart",
    label: "Org Chart",
    icon: GitBranch,
    group: "Structure",
    route: "/admin/org-chart",
    requires: "orgId",
  },
  {
    key: "agile",
    label: "Agile Config",
    icon: Workflow,
    group: "Structure",
    route: "/admin/agile",
    requires: "orgId",
    feature: "agile",
  },
  {
    key: "projects",
    label: "Projects",
    icon: Folder,
    group: "Structure",
    route: "/admin/projects",
    requires: "orgId",
    feature: "agile",
  },

  {
    key: "integrations",
    label: "Integrations",
    icon: GitMerge,
    group: "Settings",
    route: "/admin/integrations",
    requires: "orgId",
  },
  {
    key: "org-settings",
    label: "Org Settings",
    icon: SettingsIcon,
    group: "Settings",
    route: "/admin/org-settings",
    requires: "orgId",
  },

  {
    key: "payroll",
    label: "Payroll Periods",
    icon: DollarSign,
    group: "Operations",
    route: "/admin/payroll",
    feature: "payroll",
  },
  {
    key: "compensation",
    label: "Compensation",
    icon: Wallet,
    group: "Operations",
    route: "/admin/compensation",
    requires: "orgId",
    feature: "payroll",
  },
  {
    key: "salary-slips",
    label: "Salary Slips",
    icon: Receipt,
    group: "Operations",
    route: "/admin/salary-slips",
    requires: "orgId",
    feature: "payroll",
  },
  {
    key: "payment-config",
    label: "Payment Settings",
    icon: CreditCard,
    group: "Operations",
    route: "/admin/payment-settings",
    requires: "orgId",
    feature: "payroll",
  },

  {
    key: "audit",
    label: "Audit Logs",
    icon: ScrollText,
    group: "Compliance",
    route: "/admin/audit",
  },
  {
    key: "platform-access",
    label: "Platform Access",
    icon: Shield,
    group: "Compliance",
    route: "/admin/platform-access",
    requires: "approver",
  },
];

const GROUP_ORDER = [
  "Overview",
  "People",
  "Structure",
  "Settings",
  "Operations",
  "Compliance",
];

const DEFAULT_BADGES: Record<string, number> = { roleRequests: 0 };

function isAllowed(
  section: Section,
  user: ReturnType<typeof useAuth>["user"],
  hasFeature: (f: string) => boolean,
): boolean {
  if (section.feature && !hasFeature(section.feature)) return false;
  if (!section.requires) return true;
  if (section.requires === "orgId") return !!user?.org_id;
  if (section.requires === "super") {
    return user?.role === "super_admin" || user?.role === "platform_admin";
  }
  if (section.requires === "approver") {
    return ["super_admin", "hr_admin", "platform_admin"].includes(
      user?.role ?? "",
    );
  }
  return true;
}

export default function AdminPanel() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const { user } = useAuth();

  const { data: badges = DEFAULT_BADGES, isLoading: loadingBadges } = useQuery({
    queryKey: ["admin", "badges"],
    queryFn: async () => {
      const r = await getRoleChangeRequests({ status: "pending" });
      return { roleRequests: (r.data || []).length } as Record<string, number>;
    },
  });

  const hasFeature = useCallback(
    (f: string) => userHasFeature(user, f),
    [user],
  );

  // Access gate — matches the web AdminPanel role check.
  if (
    !user ||
    !["hr_admin", "super_admin", "platform_admin"].includes(user.role)
  ) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Stack.Screen options={{ title: "Admin Panel" }} />
        <Shield size={40} color={theme.textMuted} />
        <Text style={styles.denied}>
          Access denied. HR Admin, Super Admin, or Platform Admin role required.
        </Text>
      </View>
    );
  }

  const groups = GROUP_ORDER.map((name) => ({
    name,
    items: SECTIONS.filter(
      (sec) => sec.group === name && isAllowed(sec, user, hasFeature),
    ),
  })).filter((g) => g.items.length > 0);

  const roleLabel =
    user.role === "platform_admin"
      ? "Platform Admin"
      : user.role === "super_admin"
        ? "Super Admin"
        : "HR Admin";

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: "Admin Panel" }} />

      <View style={styles.brandRow}>
        <View style={styles.brandIcon}>
          <SettingsIcon size={20} color={theme.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.brandTitle}>Admin Panel</Text>
          <Text style={styles.brandSubtitle}>{roleLabel}</Text>
        </View>
        {loadingBadges ? (
          <ActivityIndicator size="small" color={theme.primary} />
        ) : null}
      </View>

      {groups.map((group) => (
        <View key={group.name} style={styles.group}>
          <Text style={styles.groupLabel}>{group.name}</Text>
          <View style={styles.card}>
            {group.items.map((item, i) => {
              const badge = item.badgeKey ? badges[item.badgeKey] : 0;
              return (
                <Pressable
                  key={item.key}
                  style={({ pressed }) => [
                    styles.row,
                    i < group.items.length - 1 && styles.rowBorder,
                    pressed && { opacity: 0.6 },
                  ]}
                  onPress={() => router.push(item.route as never)}
                >
                  <View style={styles.iconWrap}>
                    <item.icon size={18} color={theme.textSecondary} />
                  </View>
                  <Text style={styles.label}>{item.label}</Text>
                  {badge > 0 ? (
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>{badge}</Text>
                    </View>
                  ) : null}
                  <ChevronRight size={18} color={theme.textMuted} />
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}

      {/* Platform Console link — platform_admin only. */}
      {user.role === "platform_admin" ? (
        <View style={styles.group}>
          <Text style={styles.groupLabel}>Platform</Text>
          <View style={styles.card}>
            <Pressable
              style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
              onPress={() => router.push("/tenants" as never)}
            >
              <View style={styles.iconWrap}>
                <Building size={18} color={theme.textSecondary} />
              </View>
              <Text style={styles.label}>Platform Console</Text>
              <ChevronRight size={18} color={theme.textMuted} />
            </Pressable>
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.bg },
    center: {
      alignItems: "center",
      justifyContent: "center",
      gap: 12,
      padding: 32,
    },
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
    badge: {
      backgroundColor: theme.warning,
      borderRadius: theme.radiusFull,
      minWidth: 22,
      paddingHorizontal: 7,
      paddingVertical: 2,
      alignItems: "center",
    },
    badgeText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  });
