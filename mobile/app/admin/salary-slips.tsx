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
import { Play, Receipt, Send } from "lucide-react-native";
import { theme } from "../../src/theme";
import { Dropdown, type DropdownOption } from "../../src/components/Dropdown";
import {
  bulkPublishSlips,
  getPayPeriods,
  getSalarySlips,
  publishSalarySlip,
  runPayroll,
  type SalarySlip,
} from "../../src/admin";

const STATUS_COLORS: Record<string, string> = {
  draft: "#f59e0b",
  published: "#10b981",
};

function fmtMoney(v?: number | string | null): string {
  if (v == null || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export default function SalarySlipsScreen() {
  const [periods, setPeriods] = useState<DropdownOption[]>([]);
  const [periodId, setPeriodId] = useState<string | number | null>(null);
  const [slips, setSlips] = useState<SalarySlip[]>([]);
  const [loading, setLoading] = useState(true);
  const [slipsLoading, setSlipsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    getPayPeriods()
      .then((r) => {
        const arr = Array.isArray(r.data) ? r.data : [];
        setPeriods(arr.map((p) => ({ value: p.id, label: p.label })));
        if (arr[0]) setPeriodId(arr[0].id);
      })
      .catch((e: any) =>
        setError(e?.response?.data?.error || "Failed to load pay periods"),
      )
      .finally(() => setLoading(false));
  }, []);

  const loadSlips = useCallback(() => {
    if (!periodId) {
      setSlips([]);
      return;
    }
    setSlipsLoading(true);
    setError(null);
    getSalarySlips({ pay_period_id: String(periodId) })
      .then((r) => setSlips(Array.isArray(r.data) ? r.data : []))
      .catch((e: any) => {
        setSlips([]);
        setError(e?.response?.data?.error || "Failed to load slips");
      })
      .finally(() => setSlipsLoading(false));
  }, [periodId]);

  useEffect(() => {
    loadSlips();
  }, [loadSlips]);

  async function generate() {
    if (!periodId) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const r = await runPayroll({ pay_period_id: Number(periodId) });
      setMessage(r.data?.message || "Payroll generated");
      loadSlips();
    } catch (e: any) {
      setError(e?.response?.data?.error || "Payroll run failed");
    } finally {
      setBusy(false);
    }
  }

  function publishAll() {
    if (!periodId) return;
    Alert.alert(
      "Publish all slips",
      "Publish every draft slip in this period? Employees will be able to see them.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Publish",
          onPress: async () => {
            setBusy(true);
            try {
              const r = await bulkPublishSlips({
                pay_period_id: Number(periodId),
              });
              setMessage(r.data?.message || "Slips published");
              loadSlips();
            } catch (e: any) {
              setError(
                e?.response?.data?.error || "Bulk publish failed",
              );
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }

  function publishOne(slip: SalarySlip) {
    publishSalarySlip(slip.id)
      .then(() => loadSlips())
      .catch((e: any) =>
        Alert.alert("Error", e?.response?.data?.error || "Failed to publish"),
      );
  }

  const draftCount = slips.filter((s) => s.status === "draft").length;

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Stack.Screen options={{ title: "Salary Slips" }} />
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Salary Slips" }} />

      <View style={styles.toolbar}>
        <Dropdown
          label="Pay period"
          value={periodId}
          options={periods}
          onChange={setPeriodId}
        />
        <View style={styles.actionsRow}>
          <Pressable
            style={[styles.actionBtn, busy && styles.disabled]}
            onPress={generate}
            disabled={busy || !periodId}
          >
            <Play size={14} color="#fff" />
            <Text style={styles.actionText}>
              {busy ? "Working…" : "Run payroll"}
            </Text>
          </Pressable>
          {draftCount > 0 ? (
            <Pressable
              style={[styles.actionBtnGhost, busy && styles.disabled]}
              onPress={publishAll}
              disabled={busy}
            >
              <Send size={14} color={theme.primary} />
              <Text style={styles.actionTextGhost}>
                Publish all ({draftCount})
              </Text>
            </Pressable>
          ) : null}
        </View>
        {message ? <Text style={styles.success}>{message}</Text> : null}
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </View>

      {slipsLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.primary} />
        </View>
      ) : (
        <FlatList
          data={slips}
          keyExtractor={(s) => String(s.id)}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <View style={styles.card}>
              <View style={styles.iconWrap}>
                <Receipt size={18} color={theme.primary} />
              </View>
              <View style={styles.body}>
                <Text style={styles.name} numberOfLines={1}>
                  {item.full_name || item.username || `User #${item.user_id}`}
                </Text>
                <Text style={styles.meta}>
                  Net {fmtMoney(item.net_pay)} · Gross{" "}
                  {fmtMoney(item.gross_earnings)}
                </Text>
              </View>
              <View
                style={[
                  styles.statusPill,
                  {
                    backgroundColor:
                      (STATUS_COLORS[item.status] || theme.textMuted) + "22",
                  },
                ]}
              >
                <Text
                  style={[
                    styles.statusText,
                    { color: STATUS_COLORS[item.status] || theme.textMuted },
                  ]}
                >
                  {item.status}
                </Text>
              </View>
              {item.status === "draft" ? (
                <Pressable
                  style={styles.publishBtn}
                  onPress={() => publishOne(item)}
                  hitSlop={6}
                >
                  <Send size={15} color={theme.primary} />
                </Pressable>
              ) : null}
            </View>
          )}
          ListEmptyComponent={
            <Text style={styles.empty}>
              {periodId
                ? "No slips for this period. Run payroll to generate them."
                : "Select a pay period."}
            </Text>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { alignItems: "center", justifyContent: "center", flex: 1 },
  toolbar: { padding: 16, gap: 10 },
  actionsRow: { flexDirection: "row", gap: 10, flexWrap: "wrap" },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  actionText: { color: "#fff", fontSize: 13, fontWeight: "600" },
  actionBtnGhost: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  actionTextGhost: { color: theme.primary, fontSize: 13, fontWeight: "600" },
  disabled: { opacity: 0.5 },
  success: { color: theme.success, fontSize: 12 },
  errorText: { color: theme.danger, fontSize: 12 },
  list: { padding: 16, paddingTop: 4, gap: 10, paddingBottom: 40 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radius,
    padding: 12,
  },
  iconWrap: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: theme.primaryGlow,
    alignItems: "center",
    justifyContent: "center",
  },
  body: { flex: 1, gap: 2 },
  name: { fontSize: 14, fontWeight: "600", color: theme.text },
  meta: { fontSize: 12, color: theme.textSecondary },
  statusPill: {
    borderRadius: theme.radiusFull,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  statusText: { fontSize: 10, fontWeight: "700", textTransform: "uppercase" },
  publishBtn: { padding: 6 },
  empty: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: "center",
    paddingTop: 32,
  },
});