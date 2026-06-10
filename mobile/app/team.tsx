import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack } from "expo-router";
import { CheckCircle2, Users, XCircle } from "lucide-react-native";
import { theme } from "../src/theme";
import { uploadUrl } from "../src/config";
import { formatTime } from "../src/utils/time";
import {
  approveRequest,
  getApprovals,
  getTeamAttendance,
  rejectRequest,
  type Approval,
  type TeamMember,
} from "../src/features";

type Tab = "attendance" | "approvals";

const STATUS_META: Record<
  TeamMember["status"],
  { label: string; color: string; bg: string }
> = {
  working: { label: "Working", color: "#4daa57", bg: "rgba(77,170,87,0.12)" },
  away: { label: "On Break", color: "#cb912f", bg: "rgba(203,145,47,0.12)" },
  not_started: {
    label: "Clocked Out",
    color: "#94a3b8",
    bg: "rgba(148,163,184,0.12)",
  },
  on_leave: { label: "On Leave", color: "#0ea5e9", bg: "rgba(14,165,233,0.12)" },
};

function initials(name?: string) {
  if (!name) return "?";
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "?";
}

export default function TeamScreen() {
  const [tab, setTab] = useState<Tab>("attendance");

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "My Team" }} />
      <View style={styles.tabRow}>
        <Pressable
          style={[styles.tabBtn, tab === "attendance" && styles.tabBtnActive]}
          onPress={() => setTab("attendance")}
        >
          <Text
            style={[
              styles.tabText,
              tab === "attendance" && styles.tabTextActive,
            ]}
          >
            Attendance
          </Text>
        </Pressable>
        <Pressable
          style={[styles.tabBtn, tab === "approvals" && styles.tabBtnActive]}
          onPress={() => setTab("approvals")}
        >
          <Text
            style={[styles.tabText, tab === "approvals" && styles.tabTextActive]}
          >
            Approvals
          </Text>
        </Pressable>
      </View>
      {tab === "attendance" ? <AttendanceTab /> : <ApprovalsTab />}
    </View>
  );
}

function AttendanceTab() {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await getTeamAttendance();
      // Server returns a bare array.
      setMembers(Array.isArray(data) ? data : []);
    } catch {
      setMembers([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  return (
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
      renderItem={({ item }) => {
        const meta = STATUS_META[item.status] || STATUS_META.not_started;
        const avatar = uploadUrl(item.avatar);
        return (
          <View style={styles.memberCard}>
            <View style={styles.avatar}>
              {avatar ? (
                <Image source={{ uri: avatar }} style={styles.avatarImg} />
              ) : (
                <Text style={styles.avatarText}>{initials(item.full_name)}</Text>
              )}
            </View>
            <View style={styles.memberBody}>
              <Text style={styles.memberName} numberOfLines={1}>
                {item.full_name}
              </Text>
              <Text style={styles.memberMeta}>
                {item.floorMinutes
                  ? `${formatTime(item.floorMinutes)} worked`
                  : item.leave_type
                    ? item.leave_type
                    : "—"}
                {item.workMode ? ` · ${item.workMode}` : ""}
              </Text>
            </View>
            <View style={[styles.badge, { backgroundColor: meta.bg }]}>
              <Text style={[styles.badgeText, { color: meta.color }]}>
                {meta.label}
              </Text>
            </View>
          </View>
        );
      }}
      ListEmptyComponent={
        <View style={styles.empty}>
          <Users size={40} color={theme.textMuted} />
          <Text style={styles.emptyText}>No team members</Text>
        </View>
      }
    />
  );
}

function ApprovalsTab() {
  const [items, setItems] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const { data } = await getApprovals({ status: "pending" });
      setItems(data || []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function act(item: Approval, action: "approve" | "reject") {
    setBusyId(item.id);
    try {
      if (action === "approve") {
        await approveRequest(item.id);
      } else {
        await rejectRequest(item.id);
      }
      setItems((prev) => prev.filter((i) => i.id !== item.id));
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Action failed");
    } finally {
      setBusyId(null);
    }
  }

  function typeLabel(t: string) {
    if (t === "manual_entry") return "Manual Entry";
    if (t === "leave") return "Leave";
    if (t === "leave_withdraw") return "Leave Withdraw";
    if (t === "overtime") return "Overtime";
    return t;
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  return (
    <FlatList
      data={items}
      keyExtractor={(a) => String(a.id)}
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
      renderItem={({ item }) => {
        const name = item.requester_name || "User";
        const m = item.metadata || {};
        const startDate = m.start_date || m.dates?.[0];
        const endDate =
          m.end_date || (m.dates ? m.dates[m.dates.length - 1] : undefined);
        const date =
          startDate && endDate
            ? startDate === endDate
              ? startDate
              : `${startDate} → ${endDate}`
            : m.date || "";
        const leaveType = m.leave_type;
        const reason = m.reason;
        return (
          <View style={styles.approvalCard}>
            <View style={styles.approvalHeader}>
              <View style={styles.avatarSm}>
                <Text style={styles.avatarTextSm}>{initials(name)}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.approvalName}>{name}</Text>
                <Text style={styles.approvalType}>
                  {typeLabel(item.type)}
                  {leaveType ? ` · ${leaveType}` : ""}
                </Text>
              </View>
            </View>
            {date ? <Text style={styles.approvalDate}>{date}</Text> : null}
            {reason ? (
              <Text style={styles.approvalReason}>{reason}</Text>
            ) : null}
            <View style={styles.actionRow}>
              <Pressable
                style={[styles.actionBtn, styles.rejectBtn]}
                onPress={() => act(item, "reject")}
                disabled={busyId === item.id}
              >
                <XCircle size={16} color={theme.danger} />
                <Text style={[styles.actionText, { color: theme.danger }]}>
                  Reject
                </Text>
              </Pressable>
              <Pressable
                style={[styles.actionBtn, styles.approveBtn]}
                onPress={() => act(item, "approve")}
                disabled={busyId === item.id}
              >
                {busyId === item.id ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <>
                    <CheckCircle2 size={16} color="#fff" />
                    <Text style={[styles.actionText, { color: "#fff" }]}>
                      Approve
                    </Text>
                  </>
                )}
              </Pressable>
            </View>
          </View>
        );
      }}
      ListEmptyComponent={
        <View style={styles.empty}>
          <CheckCircle2 size={40} color={theme.textMuted} />
          <Text style={styles.emptyText}>No pending approvals</Text>
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  tabRow: {
    flexDirection: "row",
    backgroundColor: theme.surface,
    borderRadius: theme.radiusSm,
    padding: 3,
    gap: 3,
    margin: 16,
    marginBottom: 4,
  },
  tabBtn: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 9,
    borderRadius: 5,
  },
  tabBtnActive: { backgroundColor: theme.primary },
  tabText: { fontSize: 13, color: theme.textSecondary, fontWeight: "600" },
  tabTextActive: { color: "#fff" },
  list: { padding: 16, paddingTop: 8, gap: 10, paddingBottom: 40 },
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
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarImg: { width: 44, height: 44, borderRadius: 22 },
  avatarText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  memberBody: { flex: 1, gap: 2 },
  memberName: { fontSize: 15, fontWeight: "600", color: theme.text },
  memberMeta: { fontSize: 12, color: theme.textSecondary, textTransform: "capitalize" },
  badge: { borderRadius: theme.radiusSm, paddingHorizontal: 8, paddingVertical: 4 },
  badgeText: { fontSize: 11, fontWeight: "700" },
  approvalCard: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radius,
    padding: 14,
    gap: 8,
  },
  approvalHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  avatarSm: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarTextSm: { color: "#fff", fontSize: 13, fontWeight: "700" },
  approvalName: { fontSize: 15, fontWeight: "600", color: theme.text },
  approvalType: {
    fontSize: 12,
    color: theme.textSecondary,
    textTransform: "capitalize",
  },
  approvalDate: { fontSize: 13, color: theme.text, fontWeight: "500" },
  approvalReason: { fontSize: 13, color: theme.textMuted },
  actionRow: { flexDirection: "row", gap: 10, marginTop: 4 },
  actionBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    borderRadius: theme.radiusSm,
  },
  rejectBtn: {
    backgroundColor: "rgba(224,62,62,0.1)",
    borderWidth: 1,
    borderColor: "rgba(224,62,62,0.25)",
  },
  approveBtn: { backgroundColor: theme.primary },
  actionText: { fontSize: 14, fontWeight: "600" },
  empty: { alignItems: "center", gap: 10, paddingTop: 80 },
  emptyText: { color: theme.textMuted, fontSize: 14 },
});