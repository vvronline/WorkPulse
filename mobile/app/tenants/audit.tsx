import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack } from "expo-router";
import { theme } from "../../src/theme";
import { getPlatformAuditLogs, type AuditLog } from "../../src/admin";

const PAGE_SIZE = 50;

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function actionColor(action: string): string {
  if (/delete|reject|deactivate|suspend/.test(action)) return theme.danger;
  if (/create|approve|reactivate/.test(action)) return theme.success;
  if (/update|role|reset/.test(action)) return theme.warning;
  return theme.primary;
}

export default function PlatformAuditScreen() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    getPlatformAuditLogs({ limit: PAGE_SIZE, offset: page * PAGE_SIZE })
      .then((r) => {
        setLogs(r.data.logs || []);
        setTotal(r.data.total || 0);
      })
      .catch(() => setLogs([]))
      .finally(() => setLoading(false));
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Stack.Screen options={{ title: "Audit Trail" }} />
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Audit Trail" }} />
      <FlatList
        data={logs}
        keyExtractor={(l) => String(l.id)}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <View style={styles.cardHeader}>
              <View
                style={[
                  styles.actionDot,
                  { backgroundColor: actionColor(item.action) },
                ]}
              />
              <Text style={styles.action}>
                {item.action.replace(/_/g, " ")}
              </Text>
              <Text style={styles.time}>{fmtTime(item.created_at)}</Text>
            </View>
            <Text style={styles.detail}>
              {item.entity_type}
              {item.entity_id ? ` #${item.entity_id}` : ""}
              {item.actor_name ? ` · by ${item.actor_name}` : ""}
            </Text>
          </View>
        )}
        ListEmptyComponent={
          <Text style={styles.empty}>No audit entries.</Text>
        }
        ListFooterComponent={
          totalPages > 1 ? (
            <View style={styles.pager}>
              <Pressable
                style={[styles.pagerBtn, page === 0 && styles.pagerBtnDisabled]}
                disabled={page === 0}
                onPress={() => setPage((p) => Math.max(0, p - 1))}
              >
                <Text style={styles.pagerText}>Previous</Text>
              </Pressable>
              <Text style={styles.pagerInfo}>
                {page + 1} / {totalPages}
              </Text>
              <Pressable
                style={[
                  styles.pagerBtn,
                  page >= totalPages - 1 && styles.pagerBtnDisabled,
                ]}
                disabled={page >= totalPages - 1}
                onPress={() => setPage((p) => p + 1)}
              >
                <Text style={styles.pagerText}>Next</Text>
              </Pressable>
            </View>
          ) : null
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  list: { padding: 16, gap: 8, paddingBottom: 40 },
  card: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radius,
    padding: 14,
    gap: 5,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  actionDot: { width: 8, height: 8, borderRadius: 4 },
  action: {
    flex: 1,
    fontSize: 14,
    fontWeight: "700",
    color: theme.text,
    textTransform: "capitalize",
  },
  time: { fontSize: 11, color: theme.textMuted },
  detail: { fontSize: 13, color: theme.textSecondary },
  empty: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: "center",
    paddingTop: 32,
  },
  pager: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
  },
  pagerBtn: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  pagerBtnDisabled: { opacity: 0.4 },
  pagerText: { color: theme.text, fontSize: 13, fontWeight: "600" },
  pagerInfo: { color: theme.textSecondary, fontSize: 13 },
});