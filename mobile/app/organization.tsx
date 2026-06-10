import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack } from "expo-router";
import { Building2 } from "lucide-react-native";
import { theme } from "../src/theme";
import { uploadUrl } from "../src/config";
import {
  getCurrentOrg,
  getOrgMembers,
  type OrgInfo,
  type OrgMember,
} from "../src/features";

function initials(name?: string) {
  if (!name) return "?";
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "?";
}

export default function OrganizationScreen() {
  const [org, setOrg] = useState<OrgInfo | null>(null);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [oRes, mRes] = await Promise.allSettled([
      getCurrentOrg(),
      getOrgMembers({ limit: "100" }),
    ]);
    if (oRes.status === "fulfilled") setOrg(oRes.value.data || null);
    if (mRes.status === "fulfilled") setMembers(mRes.value.data.members || []);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: "Organization" }} />
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Organization" }} />
      <FlatList
        data={members}
        keyExtractor={(m) => String(m.id)}
        contentContainerStyle={styles.list}
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
        ListHeaderComponent={
          <View>
            {org ? (
              <View style={styles.orgCard}>
                <View style={styles.orgIcon}>
                  <Building2 size={26} color={theme.primary} />
                </View>
                <Text style={styles.orgName}>{org.name}</Text>
                {org.domain ? (
                  <Text style={styles.orgDomain}>{org.domain}</Text>
                ) : null}
                <View style={styles.statsRow}>
                  <Stat label="Members" value={org.member_count ?? 0} />
                  <View style={styles.statDivider} />
                  <Stat label="Departments" value={org.department_count ?? 0} />
                  <View style={styles.statDivider} />
                  <Stat label="Teams" value={org.team_count ?? 0} />
                </View>
                {org.settings ? (
                  <View style={styles.settingsRow}>
                    {org.settings.daily_hours ? (
                      <Text style={styles.settingChip}>
                        {org.settings.daily_hours}h/day
                      </Text>
                    ) : null}
                    {org.settings.timezone ? (
                      <Text style={styles.settingChip}>
                        {org.settings.timezone}
                      </Text>
                    ) : null}
                  </View>
                ) : null}
              </View>
            ) : null}
            <Text style={styles.sectionTitle}>Members</Text>
          </View>
        }
        renderItem={({ item }) => {
          const avatar = uploadUrl(item.avatar);
          return (
            <View style={styles.memberCard}>
              <View style={styles.avatar}>
                {avatar ? (
                  <Image source={{ uri: avatar }} style={styles.avatarImg} />
                ) : (
                  <Text style={styles.avatarText}>
                    {initials(item.full_name)}
                  </Text>
                )}
              </View>
              <View style={styles.memberBody}>
                <Text style={styles.memberName} numberOfLines={1}>
                  {item.full_name}
                </Text>
                <Text style={styles.memberMeta} numberOfLines={1}>
                  {[item.department_name, item.team_name]
                    .filter(Boolean)
                    .join(" · ") || item.email || "—"}
                </Text>
              </View>
              <View style={styles.roleBadge}>
                <Text style={styles.roleText}>
                  {item.role?.replace(/_/g, " ")}
                </Text>
              </View>
            </View>
          );
        }}
        ListEmptyComponent={
          <Text style={styles.empty}>No members visible.</Text>
        }
      />
    </View>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.bg },
  list: { padding: 16, gap: 10, paddingBottom: 40 },
  orgCard: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusLg,
    padding: 20,
    alignItems: "center",
    gap: 6,
    marginBottom: 16,
  },
  orgIcon: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: theme.primaryGlow,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  orgName: { fontSize: 20, fontWeight: "800", color: theme.text },
  orgDomain: { fontSize: 13, color: theme.textMuted },
  statsRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 12,
    alignSelf: "stretch",
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
  settingsRow: { flexDirection: "row", gap: 8, marginTop: 12, flexWrap: "wrap" },
  settingChip: {
    fontSize: 11,
    color: theme.textSecondary,
    backgroundColor: theme.surface,
    borderRadius: theme.radiusFull,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: theme.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 8,
  },
  memberCard: {
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
  avatarImg: { width: 42, height: 42, borderRadius: 21 },
  avatarText: { color: "#fff", fontSize: 14, fontWeight: "700" },
  memberBody: { flex: 1, gap: 2 },
  memberName: { fontSize: 15, fontWeight: "600", color: theme.text },
  memberMeta: { fontSize: 12, color: theme.textSecondary },
  roleBadge: {
    backgroundColor: theme.primaryGlow,
    borderRadius: theme.radiusFull,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  roleText: {
    color: theme.primaryLight,
    fontSize: 11,
    fontWeight: "600",
    textTransform: "capitalize",
  },
  empty: { color: theme.textMuted, fontSize: 13, textAlign: "center", paddingTop: 24 },
});