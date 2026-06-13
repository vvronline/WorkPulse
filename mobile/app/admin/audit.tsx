import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack } from "expo-router";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import { getAuditLogs, type AuditLog } from "../../src/admin";

const PAGE_SIZE = 50;

const RANGES = [
  { key: "all", label: "All time", days: null as number | null },
  { key: "today", label: "Today", days: 0 },
  { key: "7d", label: "7 days", days: 7 },
  { key: "30d", label: "30 days", days: 30 },
];

function rangeToDates(key: string): { from?: string; to?: string } {
  const r = RANGES.find((d) => d.key === key);
  if (!r || r.days === null) return {};
  const to = new Date();
  const from = new Date();
  if (r.days === 0) from.setHours(0, 0, 0, 0);
  else {
    from.setDate(from.getDate() - r.days);
    from.setHours(0, 0, 0, 0);
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function actionColor(theme: Theme, action: string): string {
  if (/delete|reject|deactivate/.test(action)) return theme.danger;
  if (/create|approve|reactivate/.test(action)) return theme.success;
  if (/update|role|reset/.test(action)) return theme.warning;
  return theme.primary;
}

export default function AuditLogsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [range, setRange] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const params: Record<string, string | number> = {
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    };
    const { from, to } = rangeToDates(range);
    if (from) params.from = from;
    if (to) params.to = to;
    getAuditLogs(params)
      .then((r) => {
        setLogs(r.data.logs || []);
        setTotal(r.data.total || 0);
      })
      .catch((e: any) => {
        setLogs([]);
        setError(e?.response?.data?.error || "Failed to load audit logs");
      })
      .finally(() => setLoading(false));
  }, [page, range]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setPage(0);
  }, [range]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Audit Logs" }} />

      <View style={styles.filterRow}>
        {RANGES.map((r) => (
          <Pressable
            key={r.key}
            style={[styles.chip, range === r.key && styles.chipActive]}
            onPress={() => setRange(r.key)}
          >
            <Text
              style={[styles.chipText, range === r.key && styles.chipTextActive]}
            >
              {r.label}
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
          data={logs}
          keyExtractor={(l) => String(l.id)}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <View
                  style={[
                    styles.actionDot,
                    { backgroundColor: actionColor(theme, item.action) },
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
              {item.ip_address ? (
                <Text style={styles.ip}>{item.ip_address}</Text>
              ) : null}
            </View>
          )}
          ListEmptyComponent={
            <Text style={styles.empty}>{error ?? "No audit entries."}</Text>
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
      )}
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  filterRow: {
    flexDirection: "row",
    gap: 8,
    padding: 16,
    paddingBottom: 8,
    flexWrap: "wrap",
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: theme.radiusFull,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
  },
  chipActive: { backgroundColor: theme.primary, borderColor: theme.primary },
  chipText: { fontSize: 13, color: theme.textSecondary, fontWeight: "500" },
  chipTextActive: { color: "#fff", fontWeight: "600" },
  list: { padding: 16, paddingTop: 4, gap: 8, paddingBottom: 40 },
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
  ip: { fontSize: 11, color: theme.textMuted },
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