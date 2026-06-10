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
import { Check, Shield, X } from "lucide-react-native";
import { theme } from "../../src/theme";
import {
  approveAccessRequest,
  denyAccessRequest,
  listIncomingAccessRequests,
  revokeAccessSession,
  type IncomingAccessRequest,
} from "../../src/admin";

function fmt(iso?: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function PlatformAccessScreen() {
  const [requests, setRequests] = useState<IncomingAccessRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    listIncomingAccessRequests()
      .then((r) => setRequests(r.data || []))
      .catch(() => setRequests([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function approve(req: IncomingAccessRequest) {
    setBusyId(req.id);
    approveAccessRequest(req.id)
      .then(() => load())
      .catch((e: any) =>
        Alert.alert("Error", e?.response?.data?.error || "Failed to approve"),
      )
      .finally(() => setBusyId(null));
  }

  function deny(req: IncomingAccessRequest) {
    Alert.alert("Deny request", "Deny this platform access request?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Deny",
        style: "destructive",
        onPress: () => {
          setBusyId(req.id);
          denyAccessRequest(req.id)
            .then(() => load())
            .catch((e: any) =>
              Alert.alert("Error", e?.response?.data?.error || "Failed to deny"),
            )
            .finally(() => setBusyId(null));
        },
      },
    ]);
  }

  function revoke(req: IncomingAccessRequest) {
    Alert.alert("Revoke session", "Revoke this active access session?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Revoke",
        style: "destructive",
        onPress: () => {
          setBusyId(req.id);
          revokeAccessSession(req.id)
            .then(() => load())
            .catch((e: any) =>
              Alert.alert("Error", e?.response?.data?.error || "Failed to revoke"),
            )
            .finally(() => setBusyId(null));
        },
      },
    ]);
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Platform Access" }} />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.primary} />
        </View>
      ) : (
        <FlatList
          data={requests}
          keyExtractor={(r) => String(r.id)}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            <Text style={styles.intro}>
              Approve or deny platform-admin support sessions for your
              organization, and revoke active sessions.
            </Text>
          }
          renderItem={({ item }) => {
            const isPending = item.status === "pending";
            const isApproved =
              item.status === "approved" || item.status === "active";
            return (
              <View style={styles.card}>
                <View style={styles.cardHeader}>
                  <Shield size={16} color={theme.primary} />
                  <Text style={styles.name} numberOfLines={1}>
                    {item.inspector_name || "Platform admin"}
                  </Text>
                  <View
                    style={[
                      styles.statusPill,
                      {
                        backgroundColor: isPending
                          ? theme.warning + "22"
                          : isApproved
                            ? theme.success + "22"
                            : theme.danger + "22",
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.statusText,
                        {
                          color: isPending
                            ? theme.warning
                            : isApproved
                              ? theme.success
                              : theme.danger,
                        },
                      ]}
                    >
                      {item.status}
                    </Text>
                  </View>
                </View>
                {item.reason ? (
                  <Text style={styles.reason}>"{item.reason}"</Text>
                ) : null}
                <Text style={styles.meta}>
                  Requested {fmt(item.created_at)}
                  {item.expires_at ? ` · expires ${fmt(item.expires_at)}` : ""}
                </Text>

                {isPending ? (
                  <View style={styles.actionRow}>
                    <Pressable
                      style={[styles.actionBtn, styles.approveBtn]}
                      onPress={() => approve(item)}
                      disabled={busyId === item.id}
                    >
                      <Check size={15} color="#fff" />
                      <Text style={styles.actionBtnText}>Approve</Text>
                    </Pressable>
                    <Pressable
                      style={[styles.actionBtn, styles.denyBtn]}
                      onPress={() => deny(item)}
                      disabled={busyId === item.id}
                    >
                      <X size={15} color={theme.danger} />
                      <Text style={[styles.actionBtnText, { color: theme.danger }]}>
                        Deny
                      </Text>
                    </Pressable>
                  </View>
                ) : isApproved ? (
                  <Pressable
                    style={styles.revokeBtn}
                    onPress={() => revoke(item)}
                    disabled={busyId === item.id}
                  >
                    <X size={15} color={theme.danger} />
                    <Text style={[styles.actionBtnText, { color: theme.danger }]}>
                      Revoke session
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            );
          }}
          ListEmptyComponent={
            <Text style={styles.empty}>No access requests.</Text>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  list: { padding: 16, gap: 12, paddingBottom: 40 },
  intro: { fontSize: 13, color: theme.textSecondary, marginBottom: 4 },
  card: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusLg,
    padding: 16,
    gap: 8,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { flex: 1, fontSize: 15, fontWeight: "700", color: theme.text },
  statusPill: {
    borderRadius: theme.radiusFull,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  statusText: { fontSize: 11, fontWeight: "600", textTransform: "capitalize" },
  reason: { fontSize: 13, color: theme.textSecondary, fontStyle: "italic" },
  meta: { fontSize: 11, color: theme.textMuted },
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
  denyBtn: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
  },
  revokeBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: theme.radiusSm,
    paddingVertical: 11,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    marginTop: 4,
  },
  actionBtnText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  empty: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: "center",
    paddingTop: 32,
  },
});