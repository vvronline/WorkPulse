import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { theme } from "../theme";
import {
  addLeavesBatch,
  getLeaveBalance,
  getLeavePolicies,
  getLeaves,
  withdrawLeave,
  type Leave,
  type LeaveBalance,
  type LeavePolicy,
} from "../features";
import {
  STATUS_CONFIG,
  buildLeaveTypeMeta,
  buildLeaveTypeOptions,
  getLeaveType,
  type LeaveTypeMeta,
} from "../constants/leaves";

/* ───────────────────────── helpers ───────────────────────── */

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function fmtDate(str: string): string {
  return new Date(str.slice(0, 10) + "T00:00:00").toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** Generates YYYY-MM-DD strings between from and to (inclusive), skipping weekends optionally. */
function getDateRange(from: string, to: string, skipWeekends = true): string[] {
  const dates: string[] = [];
  const end = new Date(to + "T00:00:00");
  for (let d = new Date(from + "T00:00:00"); d <= end; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    if (skipWeekends && (dow === 0 || dow === 6)) continue;
    dates.push(ymd(d));
  }
  return dates;
}

/** Public holidays are auto-booked by HR and excluded from personal leave history. */
function isPublicHoliday(l: Leave | null | undefined): boolean {
  return (
    !!l &&
    l.leave_type === "holiday" &&
    typeof l.reason === "string" &&
    l.reason.startsWith("Public holiday:")
  );
}

/* ───────────────────────── LeavesTab ───────────────────────── */

const SUB_TABS = [
  { id: "request", label: "My Leaves" },
  { id: "balances", label: "My Balances" },
] as const;
type SubTab = (typeof SUB_TABS)[number]["id"];

export default function LeavesTab() {
  const [subTab, setSubTab] = useState<SubTab>("request");

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.subTabRow}>
        {SUB_TABS.map((t) => (
          <Pressable
            key={t.id}
            style={[styles.subTab, subTab === t.id && styles.subTabActive]}
            onPress={() => setSubTab(t.id)}
          >
            <Text
              style={[
                styles.subTabText,
                subTab === t.id && styles.subTabTextActive,
              ]}
            >
              {t.label}
            </Text>
          </Pressable>
        ))}
      </View>
      {subTab === "request" ? <RequestTab /> : <BalancesTab />}
    </View>
  );
}

/* ───────────────────────── Request tab ───────────────────────── */

function RequestTab() {
  const [policies, setPolicies] = useState<LeavePolicy[]>([]);
  const [leaves, setLeaves] = useState<Leave[]>([]);
  const [balances, setBalances] = useState<LeaveBalance[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filterMonth, setFilterMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });

  const loadPolicies = useCallback(async () => {
    try {
      const { data } = await getLeavePolicies();
      setPolicies(data || []);
    } catch {
      /* fall back to defaults */
    }
  }, []);

  const loadData = useCallback(async () => {
    try {
      const [y, m] = filterMonth.split("-");
      const from = `${filterMonth}-01`;
      const lastDay = new Date(parseInt(y), parseInt(m), 0).getDate();
      const to = `${filterMonth}-${lastDay}`;
      const [leavesRes, balancesRes] = await Promise.all([
        getLeaves(from, to),
        getLeaveBalance(parseInt(y)).catch(() => ({ data: [] as LeaveBalance[] })),
      ]);
      setLeaves(leavesRes.data || []);
      setBalances(balancesRes.data || []);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [filterMonth]);

  useEffect(() => {
    loadPolicies();
  }, [loadPolicies]);

  useEffect(() => {
    setLoading(true);
    loadData();
  }, [loadData]);

  const confirmWithdraw = (leave: Leave) => {
    const needsApproval = leave.status === "approved";
    Alert.alert(
      "Withdraw Leave Request",
      `Withdraw your ${leave.leave_type} leave for ${fmtDate(leave.date)}?${
        needsApproval ? " This requires manager approval." : ""
      }`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Withdraw",
          style: "destructive",
          onPress: async () => {
            try {
              const res = await withdrawLeave(leave.id);
              Alert.alert(
                "Done",
                (res.data as any)?.message || "Withdrawal request submitted",
              );
              loadData();
            } catch (err: any) {
              Alert.alert(
                "Error",
                err?.response?.data?.error || "Failed to withdraw leave",
              );
            }
          },
        },
      ],
    );
  };

  return (
    <ScrollView
      contentContainerStyle={styles.body}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            loadPolicies();
            loadData();
          }}
          tintColor={theme.primary}
        />
      }
    >
      <LeaveBalanceCards balances={balances} />
      <LeaveRequestForm policies={policies} onSuccess={loadData} />

      <View style={styles.monthFilterRow}>
        <Text style={styles.sectionTitle}>Leave History</Text>
        <TextInput
          style={styles.monthInput}
          value={filterMonth}
          onChangeText={setFilterMonth}
          placeholder="YYYY-MM"
          placeholderTextColor={theme.textMuted}
        />
      </View>

      <LeaveHistory
        leaves={leaves}
        policies={policies}
        loading={loading}
        onWithdraw={confirmWithdraw}
      />
    </ScrollView>
  );
}

/* ───────────────────────── Leave request form ───────────────────────── */

const DURATIONS: { value: "full" | "half" | "quarter"; label: string }[] = [
  { value: "full", label: "Full Day" },
  { value: "half", label: "Half Day" },
  { value: "quarter", label: "Quarter" },
];

function LeaveRequestForm({
  policies,
  onSuccess,
}: {
  policies: LeavePolicy[];
  onSuccess: () => void;
}) {
  const [isRange, setIsRange] = useState(false);
  const [date, setDate] = useState(ymd(new Date()));
  const [dateFrom, setDateFrom] = useState(ymd(new Date()));
  const [dateTo, setDateTo] = useState(ymd(new Date()));
  const [skipWeekends, setSkipWeekends] = useState(true);
  const [leaveType, setLeaveType] = useState("");
  const [duration, setDuration] = useState<"full" | "half" | "quarter">("full");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const typeOptions = useMemo(
    () => buildLeaveTypeOptions(policies).filter((t) => t.value !== "holiday"),
    [policies],
  );

  useEffect(() => {
    if (!typeOptions.some((t) => t.value === leaveType) && typeOptions.length > 0) {
      setLeaveType(typeOptions[0].value);
    }
  }, [typeOptions, leaveType]);

  const rangeDays = useMemo(() => {
    if (!isRange || !dateFrom || !dateTo || dateTo < dateFrom) return [];
    return getDateRange(dateFrom, dateTo, skipWeekends);
  }, [isRange, dateFrom, dateTo, skipWeekends]);

  async function submit() {
    setSubmitting(true);
    try {
      if (isRange) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
          Alert.alert("Invalid date", "Use the format YYYY-MM-DD.");
          return;
        }
        if (dateTo < dateFrom) {
          Alert.alert("Invalid range", "End date must be after start date.");
          return;
        }
        if (rangeDays.length === 0) {
          Alert.alert("No valid days", "No valid days in the selected range.");
          return;
        }
        const res = await addLeavesBatch({
          dates: rangeDays,
          leave_type: leaveType,
          reason: reason.trim() || undefined,
          duration,
        });
        Alert.alert(
          "Submitted",
          (res.data as any)?.message || `${rangeDays.length} leave(s) submitted`,
        );
        setReason("");
        setDuration("full");
      } else {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          Alert.alert("Invalid date", "Use the format YYYY-MM-DD.");
          return;
        }
        const res = await addLeavesBatch({
          dates: [date],
          leave_type: leaveType,
          reason: reason.trim() || undefined,
          duration,
        });
        Alert.alert(
          "Submitted",
          (res.data as any)?.message || "Leave request submitted",
        );
        setReason("");
        setDuration("full");
      }
      onSuccess();
    } catch (err: any) {
      Alert.alert(
        "Error",
        err?.response?.data?.error || "Failed to submit leave",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>New Leave Request</Text>

      {/* Single day / range toggle */}
      <View style={styles.segmented}>
        <Pressable
          style={[styles.segBtn, !isRange && styles.segActive]}
          onPress={() => setIsRange(false)}
        >
          <Text style={[styles.segText, !isRange && styles.segTextActive]}>
            Single Day
          </Text>
        </Pressable>
        <Pressable
          style={[styles.segBtn, isRange && styles.segActive]}
          onPress={() => setIsRange(true)}
        >
          <Text style={[styles.segText, isRange && styles.segTextActive]}>
            Date Range
          </Text>
        </Pressable>
      </View>

      {!isRange ? (
        <>
          <Text style={styles.label}>Date</Text>
          <TextInput
            style={styles.input}
            value={date}
            onChangeText={setDate}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={theme.textMuted}
          />
        </>
      ) : (
        <>
          <View style={styles.timeRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>From</Text>
              <TextInput
                style={styles.input}
                value={dateFrom}
                onChangeText={setDateFrom}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={theme.textMuted}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>To</Text>
              <TextInput
                style={styles.input}
                value={dateTo}
                onChangeText={setDateTo}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={theme.textMuted}
              />
            </View>
          </View>
          <Pressable
            style={styles.checkRow}
            onPress={() => setSkipWeekends((v) => !v)}
          >
            <View style={[styles.checkbox, skipWeekends && styles.checkboxOn]}>
              {skipWeekends ? <Text style={styles.checkMark}>✓</Text> : null}
            </View>
            <Text style={styles.checkLabel}>Skip weekends</Text>
          </Pressable>
          {rangeDays.length > 0 ? (
            <Text style={styles.rangePreview}>
              {rangeDays.length} working day{rangeDays.length !== 1 ? "s" : ""} selected
            </Text>
          ) : null}
        </>
      )}

      {/* Leave type chips */}
      <Text style={styles.label}>Leave Type</Text>
      {typeOptions.length === 0 ? (
        <Text style={styles.emptyHint}>
          No leave types configured. Ask your HR admin to add leave policies.
        </Text>
      ) : (
        <View style={styles.typeGrid}>
          {typeOptions.map((t) => {
            const active = leaveType === t.value;
            const Icon = t.Icon;
            return (
              <Pressable
                key={t.value}
                style={[
                  styles.typeChip,
                  active && { borderColor: t.color, backgroundColor: t.bg },
                ]}
                onPress={() => setLeaveType(t.value)}
              >
                <Icon size={16} color={t.color} />
                <Text
                  style={[
                    styles.typeChipText,
                    active && { color: t.color, fontWeight: "700" },
                  ]}
                >
                  {t.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}

      {/* Duration */}
      <Text style={styles.label}>Duration</Text>
      <View style={styles.segmented}>
        {DURATIONS.map((d) => (
          <Pressable
            key={d.value}
            style={[styles.segBtn, duration === d.value && styles.segActive]}
            onPress={() => setDuration(d.value)}
          >
            <Text
              style={[styles.segText, duration === d.value && styles.segTextActive]}
            >
              {d.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Reason */}
      <Text style={styles.label}>Reason (optional)</Text>
      <TextInput
        style={[styles.input, styles.textarea]}
        value={reason}
        onChangeText={setReason}
        placeholder="Briefly describe your reason…"
        placeholderTextColor={theme.textMuted}
        multiline
        numberOfLines={3}
      />

      <Pressable
        style={[
          styles.submit,
          (submitting || typeOptions.length === 0) && styles.submitDisabled,
        ]}
        onPress={submit}
        disabled={submitting || typeOptions.length === 0}
      >
        {submitting ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.submitText}>
            {isRange
              ? `Submit ${rangeDays.length || ""} Request${
                  rangeDays.length !== 1 ? "s" : ""
                }`
              : "Submit Request"}
          </Text>
        )}
      </Pressable>
    </View>
  );
}

/* ───────────────────────── Balance cards ───────────────────────── */

function LeaveBalanceCards({ balances }: { balances: LeaveBalance[] }) {
  if (!balances.length) return null;
  return (
    <View style={styles.balanceRow}>
      {balances.map((b) => {
        const type = getLeaveType(b.leave_type);
        const quota = Number(b.quota ?? 0) || 0;
        const carried = Number(b.carried_forward ?? 0) || 0;
        const used = Number(b.used ?? 0) || 0;
        const total = quota + carried;
        const available = total - used;
        const pct = total > 0 ? Math.min(Math.round((used / total) * 100), 100) : 0;
        const barColor = pct >= 80 ? "#ef4444" : pct >= 50 ? "#f59e0b" : type.color;
        const Icon = type.Icon;
        return (
          <View key={`${b.leave_type}-${b.year}`} style={styles.balanceCard}>
            <View style={styles.balanceTop}>
              <View style={[styles.balanceIcon, { backgroundColor: type.bg }]}>
                <Icon size={16} color={type.color} />
              </View>
              <Text style={styles.balanceType}>{type.label}</Text>
            </View>
            <View style={styles.balanceNums}>
              <Text style={[styles.balanceAvail, { color: type.color }]}>
                {available}
              </Text>
              <Text style={styles.balanceOf}>of {total}</Text>
            </View>
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${pct}%`, backgroundColor: barColor },
                ]}
              />
            </View>
            <Text style={styles.balanceMeta}>
              {used} used · {carried} carried
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/* ───────────────────────── Leave history ───────────────────────── */

function LeaveHistory({
  leaves,
  policies,
  loading,
  onWithdraw,
}: {
  leaves: Leave[];
  policies: LeavePolicy[];
  loading: boolean;
  onWithdraw: (leave: Leave) => void;
}) {
  const typeMeta = useMemo(() => buildLeaveTypeMeta(policies), [policies]);
  const lookupType = (val: string): LeaveTypeMeta =>
    typeMeta[val] || getLeaveType(val);

  const personalLeaves = useMemo(
    () => leaves.filter((l) => !isPublicHoliday(l)),
    [leaves],
  );

  const totalDays = useMemo(
    () =>
      personalLeaves.reduce(
        (acc, l) =>
          acc + (l.duration === "half" ? 0.5 : l.duration === "quarter" ? 0.25 : 1),
        0,
      ),
    [personalLeaves],
  );

  const approved = personalLeaves.filter((l) => l.status === "approved").length;
  const pending = personalLeaves.filter((l) => l.status === "pending").length;
  const rejected = personalLeaves.filter((l) => l.status === "rejected").length;

  if (loading) {
    return <ActivityIndicator color={theme.primary} style={{ marginTop: 20 }} />;
  }

  return (
    <>
      {/* Stats strip */}
      <View style={styles.statsStrip}>
        <Stat num={personalLeaves.length} label="Requests" />
        <View style={styles.statDivider} />
        <Stat num={totalDays} label="Days" />
        <View style={styles.statDivider} />
        <Stat num={approved} label="Approved" color={theme.success} />
        <View style={styles.statDivider} />
        <Stat num={pending} label="Pending" color={theme.warning} />
        <View style={styles.statDivider} />
        <Stat num={rejected} label="Rejected" color={theme.danger} />
      </View>

      {personalLeaves.length === 0 ? (
        <Text style={styles.emptyDetail}>
          No leave requests found for this period.
        </Text>
      ) : (
        <View style={styles.leaveList}>
          {personalLeaves.map((leave) => {
            const type = lookupType(leave.leave_type);
            const status =
              STATUS_CONFIG[leave.status] ?? STATUS_CONFIG.pending;
            const durLabel =
              leave.duration === "half"
                ? "Half Day"
                : leave.duration === "quarter"
                  ? "Quarter Day"
                  : "Full Day";
            const isPublicHolidayItem =
              typeof leave.reason === "string" &&
              leave.reason.startsWith("Public holiday:");
            const canWithdraw =
              !isPublicHolidayItem &&
              (leave.status === "pending" || leave.status === "approved");
            const Icon = type.Icon;
            return (
              <View key={leave.id} style={styles.leaveItem}>
                <View style={[styles.leaveIcon, { backgroundColor: type.bg }]}>
                  <Icon size={16} color={type.color} />
                </View>
                <View style={{ flex: 1 }}>
                  <View style={styles.leaveTopRow}>
                    <Text style={styles.leaveTypeName}>{type.label}</Text>
                    <View
                      style={[styles.statusBadge, { backgroundColor: status.bg }]}
                    >
                      <Text style={[styles.statusText, { color: status.color }]}>
                        {status.label}
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.leaveDate}>
                    {fmtDate(leave.date)} · {durLabel}
                  </Text>
                  {leave.reason ? (
                    <Text style={styles.leaveReason}>"{leave.reason}"</Text>
                  ) : null}
                  {canWithdraw ? (
                    <Pressable
                      style={styles.withdrawBtn}
                      onPress={() => onWithdraw(leave)}
                    >
                      <Text style={styles.withdrawText}>Withdraw</Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>
            );
          })}
        </View>
      )}
    </>
  );
}

function Stat({
  num,
  label,
  color,
}: {
  num: number;
  label: string;
  color?: string;
}) {
  return (
    <View style={styles.statItem}>
      <Text style={[styles.statNum, color ? { color } : null]}>{num}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

/* ───────────────────────── Balances tab ───────────────────────── */

function BalancesTab() {
  const [year, setYear] = useState(new Date().getFullYear());
  const [balances, setBalances] = useState<LeaveBalance[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await getLeaveBalance(year);
      setBalances(data || []);
    } catch {
      setBalances([]);
    } finally {
      setLoading(false);
    }
  }, [year]);

  useEffect(() => {
    load();
  }, [load]);

  const years = [year - 1, year, year + 1];

  return (
    <ScrollView contentContainerStyle={styles.body}>
      <View style={styles.yearRow}>
        {years.map((y) => (
          <Pressable
            key={y}
            style={[styles.yearChip, year === y && styles.yearChipActive]}
            onPress={() => setYear(y)}
          >
            <Text
              style={[styles.yearText, year === y && styles.yearTextActive]}
            >
              {y}
            </Text>
          </Pressable>
        ))}
      </View>

      {loading ? (
        <ActivityIndicator color={theme.primary} style={{ marginTop: 24 }} />
      ) : balances.length === 0 ? (
        <Text style={styles.emptyDetail}>
          No balances found. Contact HR to set up leave policies.
        </Text>
      ) : (
        balances.map((b) => {
          const type = getLeaveType(b.leave_type);
          const quota = Number(b.quota ?? 0) || 0;
          const carried = Number(b.carried_forward ?? 0) || 0;
          const used = Number(b.used ?? 0) || 0;
          const total = quota + carried;
          const available = total - used;
          const pct = total > 0 ? Math.min(Math.round((used / total) * 100), 100) : 0;
          const barColor =
            pct >= 80 ? "#ef4444" : pct >= 50 ? "#f59e0b" : type.color;
          const Icon = type.Icon;
          return (
            <View key={b.leave_type} style={styles.detailCard}>
              <View style={styles.detailTop}>
                <View style={[styles.balanceIcon, { backgroundColor: type.bg }]}>
                  <Icon size={18} color={type.color} />
                </View>
                <View>
                  <Text style={styles.detailType}>{type.label}</Text>
                  <Text style={styles.detailYear}>Year {b.year || year}</Text>
                </View>
              </View>
              <View style={styles.detailNums}>
                <View style={styles.detailNum}>
                  <Text style={[styles.detailBig, { color: type.color }]}>
                    {available}
                  </Text>
                  <Text style={styles.detailSmall}>available</Text>
                </View>
                <View style={styles.detailNumDivider} />
                <View style={styles.detailNum}>
                  <Text style={styles.detailBig}>{used}</Text>
                  <Text style={styles.detailSmall}>used</Text>
                </View>
                <View style={styles.detailNumDivider} />
                <View style={styles.detailNum}>
                  <Text style={styles.detailBig}>{total}</Text>
                  <Text style={styles.detailSmall}>total</Text>
                </View>
              </View>
              <View style={styles.progressTrack}>
                <View
                  style={[
                    styles.progressFill,
                    { width: `${pct}%`, backgroundColor: barColor },
                  ]}
                />
              </View>
              {carried > 0 ? (
                <Text style={styles.balanceMeta}>{carried} carried forward</Text>
              ) : null}
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

/* ───────────────────────── Styles ───────────────────────── */

const styles = StyleSheet.create({
  body: { padding: 16, paddingBottom: 40, gap: 12 },
  subTabRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  subTab: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: theme.radiusSm,
    alignItems: "center",
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
  },
  subTabActive: { backgroundColor: theme.primary, borderColor: theme.primary },
  subTabText: { fontSize: 13, color: theme.textSecondary, fontWeight: "600" },
  subTabTextActive: { color: "#fff" },

  // card / form
  card: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusLg,
    padding: 16,
    gap: 4,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: theme.text,
    marginBottom: 6,
  },
  label: {
    fontSize: 11,
    fontWeight: "600",
    color: theme.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 12,
    marginBottom: 6,
  },
  input: {
    backgroundColor: theme.inputBg,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: theme.text,
    fontSize: 15,
  },
  textarea: { minHeight: 70, textAlignVertical: "top" },
  timeRow: { flexDirection: "row", gap: 12 },
  segmented: {
    flexDirection: "row",
    backgroundColor: theme.surface,
    borderRadius: theme.radiusSm,
    padding: 3,
    gap: 3,
  },
  segBtn: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 5,
    alignItems: "center",
  },
  segActive: { backgroundColor: theme.primary },
  segText: { fontSize: 13, color: theme.textSecondary, fontWeight: "600" },
  segTextActive: { color: "#fff" },
  checkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 12,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: theme.inputBorder,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxOn: { backgroundColor: theme.primary, borderColor: theme.primary },
  checkMark: { color: "#fff", fontSize: 13, fontWeight: "700" },
  checkLabel: { color: theme.textSecondary, fontSize: 14 },
  rangePreview: {
    color: theme.primary,
    fontSize: 13,
    fontWeight: "600",
    marginTop: 8,
  },
  emptyHint: { color: theme.textMuted, fontSize: 13, marginTop: 4 },
  typeGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  typeChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: theme.radiusSm,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    backgroundColor: theme.glass,
  },
  typeChipText: { fontSize: 13, color: theme.textSecondary, fontWeight: "600" },
  submit: {
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 18,
  },
  submitDisabled: { opacity: 0.5 },
  submitText: { color: "#fff", fontSize: 15, fontWeight: "600" },

  // balance cards (horizontal row)
  balanceRow: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  balanceCard: {
    flexGrow: 1,
    flexBasis: "47%",
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radius,
    padding: 12,
    gap: 6,
  },
  balanceTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  balanceIcon: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  balanceType: { fontSize: 13, color: theme.text, fontWeight: "600", flex: 1 },
  balanceNums: { flexDirection: "row", alignItems: "baseline", gap: 6 },
  balanceAvail: { fontSize: 22, fontWeight: "800" },
  balanceOf: { fontSize: 12, color: theme.textMuted },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.surface,
    overflow: "hidden",
  },
  progressFill: { height: "100%", borderRadius: 3 },
  balanceMeta: { fontSize: 11, color: theme.textMuted },

  // month filter
  monthFilterRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 6,
  },
  sectionTitle: { fontSize: 15, fontWeight: "700", color: theme.text },
  monthInput: {
    backgroundColor: theme.inputBg,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: theme.text,
    fontSize: 14,
    minWidth: 110,
    textAlign: "center",
  },

  // stats strip
  statsStrip: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radius,
    paddingVertical: 12,
    paddingHorizontal: 8,
  },
  statItem: { flex: 1, alignItems: "center", gap: 2 },
  statNum: { fontSize: 16, fontWeight: "800", color: theme.text },
  statLabel: {
    fontSize: 9,
    color: theme.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  statDivider: { width: 1, height: 28, backgroundColor: theme.border },

  // leave list
  leaveList: { gap: 10 },
  leaveItem: {
    flexDirection: "row",
    gap: 12,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radius,
    padding: 12,
  },
  leaveIcon: {
    width: 34,
    height: 34,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  leaveTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  leaveTypeName: { fontSize: 14, fontWeight: "700", color: theme.text, flex: 1 },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: theme.radiusFull,
  },
  statusText: { fontSize: 11, fontWeight: "700" },
  leaveDate: { fontSize: 12, color: theme.textSecondary, marginTop: 3 },
  leaveReason: {
    fontSize: 12,
    color: theme.textMuted,
    fontStyle: "italic",
    marginTop: 4,
  },
  withdrawBtn: {
    alignSelf: "flex-start",
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: theme.radiusSm,
    borderWidth: 1,
    borderColor: theme.danger,
  },
  withdrawText: { color: theme.danger, fontSize: 12, fontWeight: "600" },
  emptyDetail: {
    color: theme.textMuted,
    fontSize: 13,
    paddingVertical: 16,
    textAlign: "center",
  },

  // balances tab
  yearRow: { flexDirection: "row", gap: 8 },
  yearChip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: theme.radiusFull,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
  },
  yearChipActive: { backgroundColor: theme.primary, borderColor: theme.primary },
  yearText: { fontSize: 13, color: theme.textSecondary, fontWeight: "600" },
  yearTextActive: { color: "#fff" },
  detailCard: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusLg,
    padding: 16,
    gap: 12,
  },
  detailTop: { flexDirection: "row", alignItems: "center", gap: 10 },
  detailType: { fontSize: 15, fontWeight: "700", color: theme.text },
  detailYear: { fontSize: 12, color: theme.textMuted },
  detailNums: { flexDirection: "row", alignItems: "center" },
  detailNum: { flex: 1, alignItems: "center", gap: 2 },
  detailBig: { fontSize: 20, fontWeight: "800", color: theme.text },
  detailSmall: {
    fontSize: 10,
    color: theme.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  detailNumDivider: { width: 1, height: 32, backgroundColor: theme.border },
});