import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack } from "expo-router";
import { ArrowRight, Check, RefreshCw, X } from "lucide-react-native";
import { theme } from "../../src/theme";
import { roleLabel } from "../../src/constants/roles";
import {
  approveRoleChange,
  getRoleChangeRequests,
  rejectRoleChange,
  type RoleChangeRequest,
} from "../../src/admin";

const TABS = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
];

export default function RoleRequestsScreen() {
  const [requests, setRequests] = useState<RoleChangeRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("pending");
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    getRoleChangeRequests({ status: tab })
      .then((r) => setRequests(r.data || []))
      .catch(() => setRequests([]))
      .finally(() => setLoading(false));
  }, [tab]);

  useEffect(() => {
    load();
  }, [load]);

  function approve(req: RoleChangeRequest) {
    setBusyId(req.id);
    approveRoleChange(req.id)
      .then((r) => {
        Alert.alert("Approved", r.data.message || "Approved");
        load();
      })
      .catch((e: any) =>
        Alert.alert("Error", e?.response?.data?.error || "Failed to approve"),
      )
      .finally(() => setBusyId(null));
  }

  function reject(req: RoleChangeRequest) {
    Alert.alert("Reject request", `Reject role change for ${req.target_name}?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Reject",
        style: "destructive",
        onPress: () => {
          setBusyId(req.id);
          rejectRoleChange(req.id)
            .then((r) => {
              Alert.alert("Rejected", r.data.message || "Rejected");
              load();
            })
            .catch((e: any) =>
              Alert.alert(
                "Error",
                e?.response?.data?.error || "Failed to reject",
              ),
            )
            .finally(() => setBusyId(null));
        },
      },
    ]);
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Role Requests" }} />

      <View style={styles.tabRow}>
        {TABS.map((t) => (
          <Pressable
            key={t.key}
            style={[styles.tab, tab === t.key && styles.tabActive]}
            onPress={() => setTab(t.key)}
          >
            <Text style={[styles.tabText, tab === t.key && styles.tabTextActive]}>
              {t.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.primary} />
        </View>
      ) : (
        <FlatList
          data={requests}
          keyExtractor={(r) => String(r.id)}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <RefreshCw size={16} color={theme.primary} />
                <Text style={styles.targetName} numberOfLines={1}>
                  {item.target_name || `User #${item.target_user_id}`}
                </Text>
              </View>
              <View style={styles.roleFlow}>
                <View style={styles.roleChip}>
                  <Text style={styles.roleChipText}>
                    {roleLabel(item.from_role)}
                  </Text>
                </View>
                <ArrowRight size={14} color={theme.textMuted} />
                <View style={[styles.roleChip, styles.roleChipTarget]}>
                  <Text style={[styles.roleChipText, styles.roleChipTextTarget]}>
                    {roleLabel(item.to_role)}
                  </Text>
                </View>
              </View>
              {item.requester_name ? (
                <Text style={styles.meta}>
                  Requested by {item.requester_name}
                </Text>
              ) : null}
              {item.reason ? (
                <Text style={styles.reason}>"{item.reason}"</Text>
              ) : null}
              {item.reject_reason ? (
                <Text style={styles.rejectReason}>
                  Rejected: {item.reject_reason}
                </Text>
              ) : null}

              {tab === "pending" ? (
                <View style={styles.actionRow}>
                  <Pressable
                    style={[styles.actionBtn, styles.approveBtn]}
                    onPress={() => approve(item)}
                    disabled={busyId === item.id}
                  >
                    {busyId === item.id ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <>
                        <Check size={15} color="#fff" />
                        <Text style={styles.actionBtnText}>Approve</Text>
                      </>
                    )}
                  </Pressable>
                  <Pressable
                    style={[styles.actionBtn, styles.rejectBtn]}
                    onPress={() => reject(item)}
                    disabled={busyId === item.id}
                  >
                    <X size={15} color={theme.danger} />
                    <Text style={[styles.actionBtnText, { color: theme.danger }]}>
                      Reject
                    </Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          )}
          ListEmptyComponent={
            <Text style={styles.empty}>No {tab} requests.</Text>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  tabRow: { flexDirection: "row", gap: 8, padding: 16, paddingBottom: 8 },
  tab: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: theme.radiusFull,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
  },
  tabActive: { backgroundColor: theme.primary, borderColor: theme.primary },
  tabText: { fontSize: 13, color: theme.textSecondary, fontWeight: "500" },
  tabTextActive: { color: "#fff", fontWeight: "600" },
  list: { padding: 16, paddingTop: 4, gap: 12, paddingBottom: 40 },
  card: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusLg,
    padding: 16,
    gap: 10,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  targetName: { flex: 1, fontSize: 16, fontWeight: "700", color: theme.text },
  roleFlow: { flexDirection: "row", alignItems: "center", gap: 8 },
  roleChip: {
    backgroundColor: theme.surface,
    borderRadius: theme.radiusFull,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  roleChipTarget: { backgroundColor: theme.primaryGlow },
  roleChipText: { fontSize: 12, color: theme.textSecondary, fontWeight: "600" },
  roleChipTextTarget: { color: theme.primaryLight },
  meta: { fontSize: 12, color: theme.textMuted },
  reason: { fontSize: 13, color: theme.textSecondary, fontStyle: "italic" },
  rejectReason: { fontSize: 12, color: theme.danger },
  actionRow: { flexDirection: "row", gap: 10, marginTop: 4 },
  actionBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: theme.radiusSm,
    paddingVertical: 11,
  },
  approveBtn: { backgroundColor: theme.success },
  rejectBtn: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
  },
  actionBtnText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  empty: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: "center",
    paddingTop: 32,
  },
});