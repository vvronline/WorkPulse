import { useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import {
  Building2,
  Calendar,
  ChevronRight,
  FileText,
  Server,
  Settings,
  Users,
  type LucideIcon,
} from "../../src/icons";
import { useAuth, userHasFeature } from "../../src/auth/AuthContext";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";

const ROLE_LEVELS: Record<string, number> = {
  employee: 1,
  user: 1,
  team_lead: 2,
  manager: 3,
  hr_admin: 4,
  super_admin: 5,
  platform_admin: 6,
};

type Item = {
  label: string;
  icon: LucideIcon;
  onPress: () => void;
};

export default function MoreScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const { user } = useAuth();

  const level = ROLE_LEVELS[user?.role ?? "user"] || 1;
  const isTeamLead = level >= 2 || !!user?.has_reports;
  const isHR = level >= 4;

  // Attendance is now a primary tab; Calendar moved here from the tab bar.
  // Feature-gate Calendar + Notes to match the web MobileTabBar's More sheet
  // (only listed when the tenant's plan enables them).
  const items: Item[] = [];
  if (userHasFeature(user, "calendar")) {
    items.push({
      label: "Calendar",
      icon: Calendar,
      onPress: () => router.push("/calendar"),
    });
  }
  if (userHasFeature(user, "notes")) {
    items.push({
      label: "Notes",
      icon: FileText,
      onPress: () => router.push("/notes"),
    });
  }

  if (user?.org_id || user?.role === "platform_admin") {
    items.push({
      label: "Organization",
      icon: Building2,
      onPress: () => router.push("/organization"),
    });
  }
  if (isTeamLead)
    items.push({ label: "My Team", icon: Users, onPress: () => router.push("/team") });
  if (isHR)
    items.push({
      label: "Admin",
      icon: Settings,
      onPress: () => router.push("/admin"),
    });
  if (user?.role === "platform_admin") {
    items.push({
      label: "Tenants",
      icon: Server,
      onPress: () => router.push("/tenants"),
    });
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <Text style={styles.heading}>More</Text>
      <View style={styles.card}>
        {items.map((item, i) => (
          <Pressable
            key={item.label}
            style={({ pressed }) => [
              styles.row,
              i < items.length - 1 && styles.rowBorder,
              pressed && { opacity: 0.6 },
            ]}
            onPress={item.onPress}
          >
            <View style={styles.iconWrap}>
              <item.icon size={18} color={theme.textSecondary} />
            </View>
            <Text style={styles.label}>{item.label}</Text>
            <ChevronRight size={18} color={theme.textMuted} />
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  container: { padding: 16, gap: 12 },
  heading: {
    fontSize: 24,
    fontWeight: "800",
    color: theme.text,
    letterSpacing: -0.5,
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
