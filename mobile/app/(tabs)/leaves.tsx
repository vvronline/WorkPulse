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
import { useRouter } from "expo-router";
import { CalendarOff, Plus } from "lucide-react-native";
import { theme } from "../../src/theme";
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

export default function LeavesScreen() {
  const router = useRouter();
  const [balances, setBalances] = useState<LeaveBalance[]>([]);
  const [leaves, setLeaves] = useState<Leave[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [balRes, leaveRes] = await Promise.allSettled([
        getLeaveBalance(),
        getLeaves(),
      ]);
      if (balRes.status === "fulfilled") setBalances(balRes.value.data || []);
      if (leaveRes.status === "fulfilled") setLeaves(leaveRes.value.data || []);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
  }, [load]);

  if (loading) {
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
        <Pressable style={styles.applyBtn} onPress={() => router.push("/leaves/apply")}>
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
                <View style={[styles.balanceBar, { backgroundColor: meta.color }]} />
                <Text style={styles.balanceType}>{b.policy_name || meta.label}</Text>
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
                <View style={[styles.leaveDot, { backgroundColor: type.color }]} />
                <View style={styles.leaveBody}>
                  <Text style={styles.leaveType}>{type.label}</Text>
                  <Text style={styles.leaveDate}>
                    {fmtDate(l.date)}
                    {l.duration && l.duration !== "full" ? ` · ${l.duration}` : ""}
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

const styles = StyleSheet.create({
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
  balanceType: { fontSize: 12, color: theme.textSecondary, fontWeight: "600" },
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
