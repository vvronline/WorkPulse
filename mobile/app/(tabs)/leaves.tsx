import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarOff, Plus } from "../../src/icons";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import { leaveStatusMeta, leaveTypeMeta } from "../../src/constants";
import {
  getLeaveBalance,
  getLeaves,
  type Leave,
  type LeaveBalance,
} from "../../src/features";

function fmtDate(d: string) {
  const date = new Date(d);
  if (isNaN(date.getTime())) return d;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const LEAVES_QUERY_KEY = ["leaves", "list"] as const;

// Stable empty references so memoized derivations don't recompute while the
// query is still resolving (data is undefined until the first fetch lands).
const EMPTY_BALANCES: LeaveBalance[] = [];
const EMPTY_LEAVES: Leave[] = [];

async function fetchLeaves(): Promise<{
  balances: LeaveBalance[];
  leaves: Leave[];
}> {
  const [balRes, leaveRes] = await Promise.allSettled([
    getLeaveBalance(),
    getLeaves(),
  ]);
  return {
    balances: balRes.status === "fulfilled" ? balRes.value.data || [] : [],
    leaves: leaveRes.status === "fulfilled" ? leaveRes.value.data || [] : [],
  };
}

export default function LeavesScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const queryClient = useQueryClient();

  // Stale-while-revalidate: cached balances/leaves (restored from MMKV on a cold
  // start) render instantly while a background refetch refreshes them — the
  // full-screen spinner only shows on the very first load with no cache.
  const { data, isLoading, refetch } = useQuery({
    queryKey: LEAVES_QUERY_KEY,
    queryFn: fetchLeaves,
  });
  const balances = data?.balances ?? EMPTY_BALANCES;
  const leaves = data?.leaves ?? EMPTY_LEAVES;
  const [refreshing, setRefreshing] = useState(false);

  // Background-refresh whenever the tab regains focus (e.g. after applying for
  // leave on another screen). Cached data stays visible — no blank spinner.
  useFocusEffect(
    useCallback(() => {
      queryClient.invalidateQueries({ queryKey: LEAVES_QUERY_KEY });
    }, [queryClient]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refetch();
    } finally {
      setRefreshing(false);
    }
  }, [refetch]);

  if (isLoading) {
    return (
      <View style={[styles.screen, styles.center]}>
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
          onRefresh={onRefresh}
          tintColor={theme.primary}
        />
      }
    >
      <View style={styles.headerRow}>
        <Text style={styles.heading}>Leaves</Text>
        <Pressable
          style={styles.applyBtn}
          onPress={() => router.push("/leaves/apply")}
        >
          <Plus size={16} color="#fff" />
          <Text style={styles.applyText}>Apply</Text>
        </Pressable>
      </View>

      {/* Balance cards */}
      {balances.length > 0 && (
        <View style={styles.balanceGrid}>
          {balances.map((b) => {
            const meta = leaveTypeMeta(b.leave_type);
            const remaining = b.quota + b.carried_forward - b.used;
            return (
              <View
                key={b.leave_type}
                style={[styles.balanceCard, { borderColor: meta.color + "55" }]}
              >
                <View
                  style={[styles.balanceBar, { backgroundColor: meta.color }]}
                />
                <Text style={styles.balanceType}>
                  {b.policy_name || meta.label}
                </Text>
                <Text style={[styles.balanceRemaining, { color: meta.color }]}>
                  {remaining}
                </Text>
                <Text style={styles.balanceMeta}>
                  {b.used} used / {b.quota + b.carried_forward} total
                </Text>
              </View>
            );
          })}
        </View>
      )}

      {/* History */}
      <Text style={styles.sectionTitle}>History</Text>
      {leaves.length === 0 ? (
        <View style={styles.empty}>
          <CalendarOff size={40} color={theme.textMuted} />
          <Text style={styles.emptyText}>No leave records</Text>
        </View>
      ) : (
        <View style={{ gap: 10 }}>
          {leaves.map((l) => {
            const type = leaveTypeMeta(l.leave_type);
            const status = leaveStatusMeta(l.status);
            return (
              <View key={l.id} style={styles.leaveCard}>
                <View
                  style={[styles.leaveDot, { backgroundColor: type.color }]}
                />
                <View style={styles.leaveBody}>
                  <Text style={styles.leaveType}>{type.label}</Text>
                  <Text style={styles.leaveDate}>
                    {fmtDate(l.date)}
                    {l.duration && l.duration !== "full"
                      ? ` · ${l.duration}`
                      : ""}
                  </Text>
                  {l.reason ? (
                    <Text style={styles.leaveReason} numberOfLines={1}>
                      {l.reason}
                    </Text>
                  ) : null}
                </View>
                <View style={[styles.badge, { backgroundColor: status.bg }]}>
                  <Text style={[styles.badgeText, { color: status.color }]}>
                    {status.label}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.bg },
    center: { alignItems: "center", justifyContent: "center" },
    container: { padding: 16, gap: 14, paddingBottom: 32 },
    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    applyBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      backgroundColor: theme.primary,
      borderRadius: theme.radiusFull,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    applyText: { color: "#fff", fontSize: 13, fontWeight: "600" },
    heading: {
      fontSize: 24,
      fontWeight: "800",
      color: theme.text,
      letterSpacing: -0.5,
    },
    balanceGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
    balanceCard: {
      width: "47.5%",
      flexGrow: 1,
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderRadius: theme.radiusLg,
      padding: 14,
      overflow: "hidden",
    },
    balanceBar: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      height: 3,
    },
    balanceType: {
      fontSize: 12,
      color: theme.textSecondary,
      fontWeight: "600",
    },
    balanceRemaining: { fontSize: 28, fontWeight: "800", marginVertical: 2 },
    balanceMeta: { fontSize: 11, color: theme.textMuted },
    sectionTitle: {
      fontSize: 13,
      fontWeight: "700",
      color: theme.textSecondary,
      textTransform: "uppercase",
      letterSpacing: 0.6,
      marginTop: 4,
    },
    leaveCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radius,
      padding: 14,
    },
    leaveDot: { width: 10, height: 10, borderRadius: 5 },
    leaveBody: { flex: 1, gap: 2 },
    leaveType: { fontSize: 14, fontWeight: "600", color: theme.text },
    leaveDate: { fontSize: 12, color: theme.textSecondary },
    leaveReason: { fontSize: 12, color: theme.textMuted },
    badge: {
      borderRadius: theme.radiusSm,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    badgeText: { fontSize: 11, fontWeight: "600" },
    empty: { alignItems: "center", gap: 10, paddingTop: 40 },
    emptyText: { color: theme.textMuted, fontSize: 14 },
  });
