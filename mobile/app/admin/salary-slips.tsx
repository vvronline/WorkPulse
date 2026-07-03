import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import {
  CheckCircle2,
  Clock,
  Download,
  Play,
  Receipt,
  RefreshCw,
  Send,
  XCircle,
} from "../../src/icons";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import { Dropdown, type DropdownOption } from "../../src/components/Dropdown";
import {
  bulkPublishSlips,
  disburseSalaries,
  getDisbursements,
  getPayPeriods,
  getSalarySlips,
  publishSalarySlip,
  retryDisbursement,
  runPayroll,
  salarySlipPdfPath,
  type Disbursement,
  type SalarySlip,
} from "../../src/admin";
import { API_BASE_URL } from "../../src/config";
import { getToken } from "../../src/auth/tokenStore";

const EMPTY_PERIODS: DropdownOption[] = [];
const EMPTY_SLIPS: SalarySlip[] = [];
const EMPTY_DISBURSEMENTS: Disbursement[] = [];

const STATUS_COLORS: Record<string, string> = {
  draft: "#f59e0b",
  published: "#10b981",
  processed: "#10b981",
  processing: "#3b82f6",
  failed: "#ef4444",
  reversed: "#ef4444",
  queued: "#6b7280",
};

function fmtMoney(v?: number | string | null): string {
  if (v == null || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

export default function SalarySlipsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const queryClient = useQueryClient();
  const [periodId, setPeriodId] = useState<string | number | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloadingId, setDownloadingId] = useState<number | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const {
    data: periodsData,
    isLoading: loading,
    isError: periodsIsError,
    error: periodsErr,
  } = useQuery({
    queryKey: ["admin", "salarySlipPeriods"],
    queryFn: async () => {
      const r = await getPayPeriods();
      const arr = Array.isArray(r.data) ? r.data : [];
      // Payroll can only run against a LOCKED period — the server returns a
      // 400 otherwise, which surfaced as a confusing failure. Only show
      // locked periods so generation always has a valid target.
      const locked = arr.filter((p) => p.is_locked || (p as any).locked_by);
      return {
        periods: locked.map((p) => ({ value: p.id, label: p.label })),
        firstId: locked[0]?.id ?? null,
      };
    },
  });
  const periods = periodsData?.periods ?? EMPTY_PERIODS;

  // Auto-select the first locked period once, matching the old load() behavior.
  useEffect(() => {
    if (periodId == null && periodsData?.firstId != null) {
      setPeriodId(periodsData.firstId);
    }
  }, [periodId, periodsData?.firstId]);

  const { data: slipsData, isLoading: slipsQueryLoading } = useQuery({
    queryKey: ["admin", "salarySlips", periodId],
    enabled: !!periodId,
    queryFn: async () => {
      const [slipR, disbR] = await Promise.allSettled([
        getSalarySlips({ pay_period_id: String(periodId) }),
        getDisbursements({ pay_period_id: String(periodId) }),
      ]);
      let slips: SalarySlip[] = EMPTY_SLIPS;
      let loadError: string | null = null;
      if (slipR.status === "fulfilled")
        slips = Array.isArray(slipR.value.data)
          ? slipR.value.data
          : EMPTY_SLIPS;
      else
        loadError =
          (slipR.reason as any)?.response?.data?.error ||
          "Failed to load slips";
      const disbursements =
        disbR.status === "fulfilled" && Array.isArray(disbR.value.data)
          ? disbR.value.data
          : EMPTY_DISBURSEMENTS;
      return { slips, disbursements, loadError };
    },
  });
  const slips = slipsData?.slips ?? EMPTY_SLIPS;
  const disbursements = slipsData?.disbursements ?? EMPTY_DISBURSEMENTS;
  const slipsLoading = !!periodId && slipsQueryLoading;

  const periodsError = periodsIsError
    ? (periodsErr as any)?.response?.data?.error || "Failed to load pay periods"
    : null;
  const error = mutationError ?? slipsData?.loadError ?? periodsError ?? null;

  function refreshSlips() {
    if (periodId)
      queryClient.invalidateQueries({
        queryKey: ["admin", "salarySlips", periodId],
      });
  }

  async function generate() {
    if (!periodId) return;
    setBusy(true);
    setMutationError(null);
    setMessage(null);
    try {
      const r = await runPayroll({ pay_period_id: Number(periodId) });
      setMessage(r.data?.message || "Payroll generated");
      refreshSlips();
    } catch (e: any) {
      // A slow cold-start write may time out client-side even though slips were
      // generated. Re-fetch and, if slips now exist, treat it as success.
      try {
        const r = await getSalarySlips({ pay_period_id: String(periodId) });
        const list = Array.isArray(r.data) ? r.data : [];
        if (list.length > 0) {
          queryClient.setQueryData(
            ["admin", "salarySlips", periodId],
            (prev: any) => ({
              slips: list,
              disbursements: prev?.disbursements ?? EMPTY_DISBURSEMENTS,
              loadError: null,
            }),
          );
          setMessage("Payroll generated");
          setBusy(false);
          return;
        }
      } catch {
        /* fall through */
      }
      setMutationError(e?.response?.data?.error || "Payroll run failed");
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
            setMutationError(null);
            setMessage(null);
            try {
              const r = await bulkPublishSlips({
                pay_period_id: Number(periodId),
              });
              setMessage(r.data?.message || "Slips published");
              refreshSlips();
            } catch (e: any) {
              // Verify-after-write: if no drafts remain, the publish succeeded.
              try {
                const r = await getSalarySlips({
                  pay_period_id: String(periodId),
                });
                const list = Array.isArray(r.data) ? r.data : [];
                if (!list.some((s) => s.status === "draft")) {
                  queryClient.setQueryData(
                    ["admin", "salarySlips", periodId],
                    (prev: any) => ({
                      slips: list,
                      disbursements: prev?.disbursements ?? EMPTY_DISBURSEMENTS,
                      loadError: null,
                    }),
                  );
                  setMessage("Slips published");
                  setBusy(false);
                  return;
                }
              } catch {
                /* fall through */
              }
              setMutationError(
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

  async function publishOne(slip: SalarySlip) {
    setMutationError(null);
    try {
      await publishSalarySlip(slip.id);
      refreshSlips();
    } catch (e: any) {
      // Verify-after-write: re-fetch and check if this slip is now published.
      try {
        const r = await getSalarySlips({ pay_period_id: String(periodId) });
        const list = Array.isArray(r.data) ? r.data : [];
        const updated = list.find((s) => s.id === slip.id);
        if (updated && updated.status !== "draft") {
          queryClient.setQueryData(
            ["admin", "salarySlips", periodId],
            (prev: any) => ({
              slips: list,
              disbursements: prev?.disbursements ?? EMPTY_DISBURSEMENTS,
              loadError: null,
            }),
          );
          return;
        }
      } catch {
        /* fall through */
      }
      Alert.alert("Error", e?.response?.data?.error || "Failed to publish");
    }
  }

  function disburseAll() {
    if (!periodId) return;
    Alert.alert(
      "Disburse salaries",
      "Initiate bank transfer for all published slips in this period?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Disburse",
          onPress: async () => {
            setBusy(true);
            setMutationError(null);
            setMessage(null);
            try {
              const r = await disburseSalaries({
                pay_period_id: Number(periodId),
              });
              const d = r.data;
              setMessage(
                `${d?.message || "Disbursement initiated"} (${d?.disbursed ?? 0} sent, ${d?.failed ?? 0} failed)`,
              );
              refreshSlips();
            } catch (e: any) {
              setMutationError(
                e?.response?.data?.error || "Disbursement failed",
              );
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }

  function retry(d: Disbursement) {
    retryDisbursement(d.id)
      .then(() => refreshSlips())
      .catch((e: any) =>
        Alert.alert("Error", e?.response?.data?.error || "Retry failed"),
      );
  }

  async function downloadPdf(slip: SalarySlip) {
    setDownloadingId(slip.id);
    try {
      const token = await getToken();
      const safeName = (slip.full_name || slip.username || `slip_${slip.id}`)
        .replace(/\s+/g, "_")
        .replace(/[^\w.-]/g, "");
      const target = `${FileSystem.cacheDirectory}salary_slip_${safeName}.pdf`;
      const res = await FileSystem.downloadAsync(
        `${API_BASE_URL}${salarySlipPdfPath(slip.id)}`,
        target,
        { headers: token ? { Authorization: `Bearer ${token}` } : undefined },
      );
      if (res.status !== 200) {
        throw new Error(`Server returned ${res.status}`);
      }
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(res.uri, {
          mimeType: "application/pdf",
          dialogTitle: "Salary slip",
          UTI: "com.adobe.pdf",
        });
      } else {
        Alert.alert("Downloaded", `Saved to ${res.uri}`);
      }
    } catch (e: any) {
      Alert.alert("Error", e?.message || "Failed to download PDF");
    } finally {
      setDownloadingId(null);
    }
  }

  const draftCount = slips.filter((s) => s.status === "draft").length;
  const publishedCount = slips.filter((s) => s.status === "published").length;

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
        {periods.length === 0 ? (
          <Text style={styles.hint}>
            No locked pay periods. Lock a period in Payroll Periods before
            generating salary slips.
          </Text>
        ) : (
          <Dropdown
            label="Pay period (locked)"
            value={periodId}
            options={periods}
            onChange={(v) => {
              setPeriodId(v);
              setMessage(null);
              setMutationError(null);
            }}
          />
        )}
        <View style={styles.actionsRow}>
          <Pressable
            style={[styles.actionBtn, (busy || !periodId) && styles.disabled]}
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
              <CheckCircle2 size={14} color={theme.primary} />
              <Text style={styles.actionTextGhost}>
                Publish all ({draftCount})
              </Text>
            </Pressable>
          ) : null}
          {publishedCount > 0 ? (
            <Pressable
              style={[styles.actionBtn, busy && styles.disabled]}
              onPress={disburseAll}
              disabled={busy}
            >
              <Send size={14} color="#fff" />
              <Text style={styles.actionText}>Disburse ({publishedCount})</Text>
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
          renderItem={({ item }) => {
            const disb = disbursements.find(
              (d) => d.salary_slip_id === item.id,
            );
            return (
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
                    {fmtMoney(item.gross_earnings)} · Ded{" "}
                    {fmtMoney(item.total_deductions)}
                  </Text>
                  <View style={styles.badgeRow}>
                    <View
                      style={[
                        styles.statusPill,
                        {
                          backgroundColor:
                            (STATUS_COLORS[item.status] || theme.textMuted) +
                            "22",
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.statusText,
                          {
                            color:
                              STATUS_COLORS[item.status] || theme.textMuted,
                          },
                        ]}
                      >
                        {item.status}
                      </Text>
                    </View>
                    {disb ? (
                      <View style={styles.payRow}>
                        {disb.status === "processed" ? (
                          <CheckCircle2
                            size={12}
                            color={STATUS_COLORS.processed}
                          />
                        ) : disb.status === "processing" ? (
                          <Clock size={12} color={STATUS_COLORS.processing} />
                        ) : disb.status === "failed" ? (
                          <XCircle size={12} color={STATUS_COLORS.failed} />
                        ) : null}
                        <Text
                          style={[
                            styles.payText,
                            {
                              color:
                                STATUS_COLORS[disb.status] || theme.textMuted,
                            },
                          ]}
                        >
                          {disb.status}
                          {disb.utr ? ` · UTR ${disb.utr}` : ""}
                        </Text>
                      </View>
                    ) : null}
                  </View>
                </View>
                <View style={styles.actionsCol}>
                  {item.status === "draft" ? (
                    <Pressable
                      style={styles.iconBtn}
                      onPress={() => publishOne(item)}
                      hitSlop={6}
                    >
                      <CheckCircle2 size={16} color={theme.primary} />
                    </Pressable>
                  ) : null}
                  <Pressable
                    style={styles.iconBtn}
                    onPress={() => downloadPdf(item)}
                    hitSlop={6}
                    disabled={downloadingId === item.id}
                  >
                    {downloadingId === item.id ? (
                      <ActivityIndicator size="small" color={theme.primary} />
                    ) : (
                      <Download size={16} color={theme.textSecondary} />
                    )}
                  </Pressable>
                  {disb?.status === "failed" ? (
                    <Pressable
                      style={styles.iconBtn}
                      onPress={() => retry(disb)}
                      hitSlop={6}
                    >
                      <RefreshCw size={16} color={theme.warning} />
                    </Pressable>
                  ) : null}
                </View>
              </View>
            );
          }}
          ListEmptyComponent={
            <Text style={styles.empty}>
              {periodId
                ? "No slips for this period. Run payroll to generate them."
                : "Select a locked pay period."}
            </Text>
          }
        />
      )}
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.bg },
    center: { alignItems: "center", justifyContent: "center", flex: 1 },
    toolbar: { padding: 16, gap: 10 },
    hint: { fontSize: 13, color: theme.textSecondary, lineHeight: 18 },
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
    body: { flex: 1, gap: 4 },
    name: { fontSize: 14, fontWeight: "600", color: theme.text },
    meta: { fontSize: 12, color: theme.textSecondary },
    badgeRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      flexWrap: "wrap",
    },
    statusPill: {
      borderRadius: theme.radiusFull,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    statusText: { fontSize: 10, fontWeight: "700", textTransform: "uppercase" },
    payRow: { flexDirection: "row", alignItems: "center", gap: 3 },
    payText: { fontSize: 10, fontWeight: "600" },
    actionsCol: { flexDirection: "row", alignItems: "center", gap: 2 },
    iconBtn: { padding: 6 },
    empty: {
      color: theme.textMuted,
      fontSize: 13,
      textAlign: "center",
      paddingTop: 32,
    },
  });
