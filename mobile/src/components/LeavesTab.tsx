import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { Pencil, Plus, Trash2, X } from "lucide-react-native";
import type { Theme } from "../theme";
import { useTheme } from "../theme/ThemeProvider";
import { useDialog } from "../hooks/useDialog";
import { useAuth } from "../auth/AuthContext";
import DatePicker from "./DatePicker";
import MonthPicker from "./MonthPicker";
import { Dropdown } from "./Dropdown";
import {
  addLeavesBatch,
  deleteLeavePolicy,
  getAllLeaveBalances,
  getLeaveBalance,
  getLeavePolicies,
  getLeaves,
  saveLeavePolicy,
  updateLeaveBalance,
  withdrawLeave,
  type AllBalanceRow,
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

const EMPTY_POLICIES: LeavePolicy[] = [];
const EMPTY_LEAVES: Leave[] = [];
const EMPTY_BALANCES: LeaveBalance[] = [];
const EMPTY_ALL_BALANCES: AllBalanceRow[] = [];

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
  for (
    let d = new Date(from + "T00:00:00");
    d <= end;
    d.setDate(d.getDate() + 1)
  ) {
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

type SubTab = "request" | "balances" | "policies" | "allBalances";

const BASE_TABS: { id: SubTab; label: string; hr?: boolean }[] = [
  { id: "request", label: "My Leaves" },
  { id: "balances", label: "My Balances" },
  { id: "policies", label: "Policies", hr: true },
  { id: "allBalances", label: "All Balances", hr: true },
];

export default function LeavesTab() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { user } = useAuth();
  const isHR = ["hr_admin", "super_admin", "platform_admin"].includes(
    user?.role || "",
  );
  const tabs = useMemo(() => BASE_TABS.filter((t) => !t.hr || isHR), [isHR]);
  const [subTab, setSubTab] = useState<SubTab>("request");

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.subTabRow}>
        {tabs.map((t) => (
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
              numberOfLines={1}
            >
              {t.label}
            </Text>
          </Pressable>
        ))}
      </View>
      {subTab === "request" ? (
        <RequestTab />
      ) : subTab === "balances" ? (
        <BalancesTab />
      ) : subTab === "policies" ? (
        <PoliciesTab />
      ) : (
        <AllBalancesTab />
      )}
    </View>
  );
}

/* ───────────────────────── Request tab ───────────────────────── */

function RequestTab() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { alert, confirm, dialog } = useDialog();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [filterMonth, setFilterMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  });
  const year = parseInt(filterMonth.split("-")[0]);

  const { data: policies = EMPTY_POLICIES } = useQuery({
    queryKey: ["leaves", "policies"],
    queryFn: async () => (await getLeavePolicies()).data || EMPTY_POLICIES,
  });

  const { data: leaves = EMPTY_LEAVES, isLoading: loading } = useQuery({
    queryKey: ["leaves", "history", filterMonth],
    queryFn: async () => {
      const [y, m] = filterMonth.split("-");
      const from = `${filterMonth}-01`;
      const lastDay = new Date(parseInt(y), parseInt(m), 0).getDate();
      const to = `${filterMonth}-${lastDay}`;
      return (await getLeaves(from, to)).data || EMPTY_LEAVES;
    },
  });

  const { data: balances = EMPTY_BALANCES } = useQuery({
    queryKey: ["leaves", "balance", year],
    queryFn: async () =>
      (await getLeaveBalance(year).catch(() => ({ data: EMPTY_BALANCES })))
        .data || EMPTY_BALANCES,
  });

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["leaves"] });
  }, [queryClient]);

  const confirmWithdraw = (leave: Leave) => {
    const needsApproval = leave.status === "approved";
    confirm({
      title: "Withdraw Leave Request",
      message: `Withdraw your ${leave.leave_type} leave for ${fmtDate(leave.date)}?${
        needsApproval ? " This requires manager approval." : ""
      }`,
      confirmText: "Withdraw",
      isDanger: true,
      onConfirm: async () => {
        try {
          const res = await withdrawLeave(leave.id);
          alert(
            "Done",
            (res.data as any)?.message || "Withdrawal request submitted",
          );
          refresh();
        } catch (err: any) {
          alert(
            "Error",
            err?.response?.data?.error || "Failed to withdraw leave",
          );
        }
      },
    });
  };

  return (
    <ScrollView
      contentContainerStyle={styles.body}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await queryClient.invalidateQueries({ queryKey: ["leaves"] });
            setRefreshing(false);
          }}
          tintColor={theme.primary}
        />
      }
    >
      <LeaveBalanceCards balances={balances} />
      <LeaveRequestForm policies={policies} onSuccess={refresh} />

      <View style={styles.monthFilterRow}>
        <Text style={styles.sectionTitle}>Leave History</Text>
        <MonthPicker value={filterMonth} onChange={setFilterMonth} />
      </View>

      <LeaveHistory
        leaves={leaves}
        policies={policies}
        loading={loading}
        onWithdraw={confirmWithdraw}
      />

      {dialog}
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
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { alert, dialog } = useDialog();
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
    if (
      !typeOptions.some((t) => t.value === leaveType) &&
      typeOptions.length > 0
    ) {
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
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)
        ) {
          alert("Invalid date", "Use the format YYYY-MM-DD.");
          return;
        }
        if (dateTo < dateFrom) {
          alert("Invalid range", "End date must be after start date.");
          return;
        }
        if (rangeDays.length === 0) {
          alert("No valid days", "No valid days in the selected range.");
          return;
        }
        const res = await addLeavesBatch({
          dates: rangeDays,
          leave_type: leaveType,
          reason: reason.trim() || undefined,
          duration,
        });
        alert(
          "Submitted",
          (res.data as any)?.message ||
            `${rangeDays.length} leave(s) submitted`,
        );
        setReason("");
        setDuration("full");
      } else {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          alert("Invalid date", "Use the format YYYY-MM-DD.");
          return;
        }
        const res = await addLeavesBatch({
          dates: [date],
          leave_type: leaveType,
          reason: reason.trim() || undefined,
          duration,
        });
        alert(
          "Submitted",
          (res.data as any)?.message || "Leave request submitted",
        );
        setReason("");
        setDuration("full");
      }
      onSuccess();
    } catch (err: any) {
      // Defense-in-depth: a transient/timeout error may occur after the
      // leave(s) were actually inserted on the server. Re-fetch the
      // submitted date range and, if they now exist, treat it as success.
      try {
        const from = isRange ? dateFrom : date;
        const to = isRange ? dateTo : date;
        const { data } = await getLeaves(from, to);
        if (Array.isArray(data) && data.length > 0) {
          alert("Submitted", "Your leave request has been submitted.");
          setReason("");
          setDuration("full");
          onSuccess();
          return;
        }
      } catch {
        // ignore reconciliation failure and fall through to error alert
      }
      alert("Error", err?.response?.data?.error || "Failed to submit leave");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.card}>
      {dialog}
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
          <DatePicker value={date} onChange={setDate} />
        </>
      ) : (
        <>
          <View style={styles.timeRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>From</Text>
              <DatePicker
                value={dateFrom}
                onChange={(v) => {
                  setDateFrom(v);
                  if (dateTo && v > dateTo) setDateTo(v);
                }}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>To</Text>
              <DatePicker
                value={dateTo}
                onChange={setDateTo}
                minDate={dateFrom || undefined}
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
              {rangeDays.length} working day{rangeDays.length !== 1 ? "s" : ""}{" "}
              selected
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
              style={[
                styles.segText,
                duration === d.value && styles.segTextActive,
              ]}
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
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
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
        const pct =
          total > 0 ? Math.min(Math.round((used / total) * 100), 100) : 0;
        const barColor =
          pct >= 80 ? "#ef4444" : pct >= 50 ? "#f59e0b" : type.color;
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
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
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
          acc +
          (l.duration === "half" ? 0.5 : l.duration === "quarter" ? 0.25 : 1),
        0,
      ),
    [personalLeaves],
  );

  const approved = personalLeaves.filter((l) => l.status === "approved").length;
  const pending = personalLeaves.filter((l) => l.status === "pending").length;
  const rejected = personalLeaves.filter((l) => l.status === "rejected").length;

  if (loading) {
    return (
      <ActivityIndicator color={theme.primary} style={{ marginTop: 20 }} />
    );
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
            const status = STATUS_CONFIG[leave.status] ?? STATUS_CONFIG.pending;
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
                      style={[
                        styles.statusBadge,
                        { backgroundColor: status.bg },
                      ]}
                    >
                      <Text
                        style={[styles.statusText, { color: status.color }]}
                      >
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
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View style={styles.statItem}>
      <Text style={[styles.statNum, color ? { color } : null]}>{num}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

/* ───────────────────────── Balances tab ───────────────────────── */

function BalancesTab() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [year, setYear] = useState(new Date().getFullYear());
  const { data: balances = EMPTY_BALANCES, isLoading: loading } = useQuery({
    queryKey: ["leaves", "balance", year],
    queryFn: async () =>
      (await getLeaveBalance(year).catch(() => ({ data: EMPTY_BALANCES })))
        .data || EMPTY_BALANCES,
  });

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
          const pct =
            total > 0 ? Math.min(Math.round((used / total) * 100), 100) : 0;
          const barColor =
            pct >= 80 ? "#ef4444" : pct >= 50 ? "#f59e0b" : type.color;
          const Icon = type.Icon;
          return (
            <View key={b.leave_type} style={styles.detailCard}>
              <View style={styles.detailTop}>
                <View
                  style={[styles.balanceIcon, { backgroundColor: type.bg }]}
                >
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
                <Text style={styles.balanceMeta}>
                  {carried} carried forward
                </Text>
              ) : null}
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

/* ───────────────────────── Policies tab (HR) ───────────────────────── */

/** Slugify a free-form leave-type name into a stable, URL-safe identifier. */
function slugify(s: string): string {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

const POLICY_COLORS = [
  "#6366f1",
  "#3b82f6",
  "#06b6d4",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#ec4899",
  "#8b5cf6",
];

const ACCRUAL_OPTIONS = [
  { value: "annual", label: "Annual — granted at year start" },
  { value: "monthly", label: "Monthly — accrues each month" },
  { value: "quarterly", label: "Quarterly — accrues each quarter" },
];

type PolicyDraft = {
  id?: number;
  leave_type: string;
  name: string;
  color: string;
  annual_quota: number;
  accrual_type: string;
  carry_forward_limit: number;
  half_day_allowed: boolean;
  quarter_day_allowed: boolean;
};

const POLICY_DEFAULTS: PolicyDraft = {
  leave_type: "",
  name: "",
  color: "#6366f1",
  annual_quota: 12,
  accrual_type: "annual",
  carry_forward_limit: 0,
  half_day_allowed: true,
  quarter_day_allowed: false,
};

function PoliciesTab() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { alert, confirm, dialog } = useDialog();
  const { user } = useAuth();
  const isHR = ["hr_admin", "super_admin", "platform_admin"].includes(
    user?.role || "",
  );
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<PolicyDraft | null>(null);
  const [saving, setSaving] = useState(false);

  const { data: policies = EMPTY_POLICIES, isLoading: loading } = useQuery({
    queryKey: ["leaves", "policies"],
    queryFn: async () => (await getLeavePolicies()).data || EMPTY_POLICIES,
  });
  const reloadPolicies = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["leaves", "policies"] });
  }, [queryClient]);

  const openCreate = () => setEditing({ ...POLICY_DEFAULTS });

  const openEdit = (p: LeavePolicy) =>
    setEditing({
      id: p.id,
      leave_type: p.leave_type,
      name: p.name || p.leave_type,
      color: p.color || "#6366f1",
      annual_quota: Number(p.annual_quota ?? 12) || 0,
      accrual_type: p.accrual_type || "annual",
      carry_forward_limit: Number(p.carry_forward_limit ?? 0) || 0,
      half_day_allowed: !!p.half_day_allowed,
      quarter_day_allowed: !!p.quarter_day_allowed,
    });

  const confirmDelete = (p: LeavePolicy) => {
    confirm({
      title: "Delete Policy",
      message: `Delete the "${p.name || p.leave_type}" leave policy? Existing balances and requests linked to it may be affected.`,
      confirmText: "Delete",
      isDanger: true,
      onConfirm: async () => {
        try {
          await deleteLeavePolicy(p.id);
          reloadPolicies();
        } catch (e: any) {
          alert("Error", e?.response?.data?.error || "Failed to delete policy");
        }
      },
    });
  };

  async function savePolicy() {
    if (!editing) return;
    const label = editing.name.trim();
    if (!label) {
      alert("Required", "Please enter a leave type name.");
      return;
    }
    const isExisting = !!editing.id;
    const payload: any = {
      name: label,
      color: editing.color,
      annual_quota: editing.annual_quota,
      accrual_type: editing.accrual_type,
      carry_forward_limit: editing.carry_forward_limit,
      half_day_allowed: editing.half_day_allowed ? 1 : 0,
      quarter_day_allowed: editing.quarter_day_allowed ? 1 : 0,
    };
    if (isExisting) {
      payload.leave_type = editing.leave_type;
    } else {
      const slug = slugify(label);
      if (!slug) {
        alert("Invalid name", "Enter a valid leave type name.");
        return;
      }
      payload.leave_type = slug;
    }
    setSaving(true);
    try {
      await saveLeavePolicy(payload);
      setEditing(null);
      reloadPolicies();
    } catch (e: any) {
      alert("Error", e?.response?.data?.error || "Failed to save policy");
    } finally {
      setSaving(false);
    }
  }

  const isExisting = !!editing?.id;

  return (
    <ScrollView contentContainerStyle={styles.body}>
      {dialog}
      <View style={styles.policyHeader}>
        <Text style={styles.sectionTitle}>Leave Policies</Text>
        {isHR ? (
          <Pressable style={styles.addPolicyBtn} onPress={openCreate}>
            <Plus size={16} color="#fff" />
            <Text style={styles.addPolicyText}>Add Policy</Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.emptyHint}>
        Leave types configured for your organization. Tap Add Policy to create a
        new type, or edit/delete existing ones.
      </Text>

      {loading ? (
        <ActivityIndicator color={theme.primary} style={{ marginTop: 24 }} />
      ) : policies.length === 0 ? (
        <Text style={styles.emptyDetail}>
          No leave policies configured yet.
        </Text>
      ) : (
        <View style={{ gap: 10, marginTop: 6 }}>
          {policies.map((p) => {
            const type = getLeaveType(p.leave_type);
            const Icon = type.Icon;
            const color = p.color || type.color;
            const canDelete = p.leave_type !== "holiday";
            return (
              <View key={p.id} style={styles.policyItem}>
                <View
                  style={[styles.balanceIcon, { backgroundColor: type.bg }]}
                >
                  <Icon size={18} color={color} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.policyName}>{p.name || type.label}</Text>
                  <Text style={styles.policyMeta}>
                    {p.annual_quota != null
                      ? `${p.annual_quota} days/year`
                      : "Quota not set"}
                    {p.half_day_allowed ? " · Half-day" : ""}
                    {p.quarter_day_allowed ? " · Quarter-day" : ""}
                  </Text>
                </View>
                {isHR ? (
                  <View style={styles.policyActions}>
                    <Pressable
                      style={styles.policyActionBtn}
                      onPress={() => openEdit(p)}
                      hitSlop={6}
                    >
                      <Pencil size={16} color={theme.textSecondary} />
                    </Pressable>
                    {canDelete ? (
                      <Pressable
                        style={styles.policyActionBtn}
                        onPress={() => confirmDelete(p)}
                        hitSlop={6}
                      >
                        <Trash2 size={16} color={theme.danger} />
                      </Pressable>
                    ) : null}
                  </View>
                ) : null}
              </View>
            );
          })}
        </View>
      )}

      {/* Create / edit modal */}
      <Modal
        visible={!!editing}
        transparent
        animationType="fade"
        onRequestClose={() => setEditing(null)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setEditing(null)}
        >
          <Pressable
            style={styles.modalBox}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={styles.policyModalHeader}>
              <Text style={styles.modalTitle}>
                {isExisting ? "Edit Policy" : "New Leave Policy"}
              </Text>
              <Pressable onPress={() => setEditing(null)} hitSlop={8}>
                <X size={20} color={theme.textSecondary} />
              </Pressable>
            </View>

            <ScrollView
              style={{ maxHeight: 460 }}
              keyboardShouldPersistTaps="handled"
            >
              <Text style={styles.label}>Leave Type Name</Text>
              <TextInput
                style={[styles.input, isExisting && styles.inputDisabled]}
                value={editing?.name}
                onChangeText={(v) =>
                  setEditing((p) => (p ? { ...p, name: v } : p))
                }
                placeholder="e.g. Sick, Casual, Comp Off…"
                placeholderTextColor={theme.textMuted}
                maxLength={40}
                editable={!isExisting}
              />
              {isExisting ? (
                <Text style={styles.emptyHint}>
                  The leave-type identifier is locked once created. Delete and
                  re-create the policy to rename it.
                </Text>
              ) : null}

              <Text style={styles.label}>Color</Text>
              <View style={styles.swatchRow}>
                {POLICY_COLORS.map((c) => {
                  const active = (editing?.color || "").toLowerCase() === c;
                  return (
                    <Pressable
                      key={c}
                      style={[
                        styles.swatch,
                        { backgroundColor: c },
                        active && styles.swatchActive,
                      ]}
                      onPress={() =>
                        setEditing((p) => (p ? { ...p, color: c } : p))
                      }
                    />
                  );
                })}
              </View>

              <Text style={styles.label}>Days Allowed / Year</Text>
              <TextInput
                style={styles.input}
                keyboardType="number-pad"
                value={String(editing?.annual_quota ?? "")}
                onChangeText={(v) =>
                  setEditing((p) =>
                    p ? { ...p, annual_quota: Number(v) || 0 } : p,
                  )
                }
              />

              <Text style={styles.label}>Carry-Forward Limit</Text>
              <TextInput
                style={styles.input}
                keyboardType="number-pad"
                value={String(editing?.carry_forward_limit ?? "")}
                onChangeText={(v) =>
                  setEditing((p) =>
                    p ? { ...p, carry_forward_limit: Number(v) || 0 } : p,
                  )
                }
              />

              <Text style={styles.label}>Accrual Type</Text>
              <Dropdown
                label="Accrual Type"
                value={editing?.accrual_type ?? "annual"}
                options={ACCRUAL_OPTIONS}
                onChange={(v) =>
                  setEditing((p) => (p ? { ...p, accrual_type: String(v) } : p))
                }
              />

              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>Allow Half-day requests</Text>
                <Switch
                  value={!!editing?.half_day_allowed}
                  onValueChange={(v) =>
                    setEditing((p) => (p ? { ...p, half_day_allowed: v } : p))
                  }
                  trackColor={{ true: theme.primary }}
                />
              </View>
              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>
                  Allow Quarter-day requests
                </Text>
                <Switch
                  value={!!editing?.quarter_day_allowed}
                  onValueChange={(v) =>
                    setEditing((p) =>
                      p ? { ...p, quarter_day_allowed: v } : p,
                    )
                  }
                  trackColor={{ true: theme.primary }}
                />
              </View>
            </ScrollView>

            <View style={styles.modalFooter}>
              <Pressable
                style={styles.modalCancel}
                onPress={() => setEditing(null)}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.modalSave, saving && styles.submitDisabled]}
                onPress={savePolicy}
                disabled={saving}
              >
                {saving ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.modalSaveText}>
                    {isExisting ? "Save Changes" : "Create Policy"}
                  </Text>
                )}
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </ScrollView>
  );
}

/* ───────────────────────── All balances tab (HR) ───────────────────────── */

function AllBalancesTab() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { alert, dialog } = useDialog();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [editItem, setEditItem] = useState<AllBalanceRow | null>(null);
  const [saving, setSaving] = useState(false);

  const { data: rows = EMPTY_ALL_BALANCES, isLoading: loading } = useQuery({
    queryKey: ["leaves", "allBalances"],
    queryFn: async () => {
      const { data } = await getAllLeaveBalances("all");
      return Array.isArray(data) ? data : EMPTY_ALL_BALANCES;
    },
  });

  const filtered = useMemo(
    () =>
      rows.filter(
        (b) =>
          !search || b.full_name?.toLowerCase().includes(search.toLowerCase()),
      ),
    [rows, search],
  );

  async function saveEdit() {
    if (!editItem) return;
    setSaving(true);
    try {
      await updateLeaveBalance(editItem.user_id as any, {
        policy_id: editItem.policy_id,
        year: editItem.year,
        total_days: editItem.total_days,
        used: editItem.used,
        carried_forward: editItem.carried_forward,
      });
      setEditItem(null);
      queryClient.invalidateQueries({ queryKey: ["leaves", "allBalances"] });
    } catch (e: any) {
      alert("Error", e?.response?.data?.error || "Failed to update balance");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.body}>
      {dialog}
      <Text style={styles.sectionTitle}>All Employee Balances</Text>
      <TextInput
        style={styles.input}
        value={search}
        onChangeText={setSearch}
        placeholder="Search by employee name…"
        placeholderTextColor={theme.textMuted}
      />

      {loading ? (
        <ActivityIndicator color={theme.primary} style={{ marginTop: 24 }} />
      ) : filtered.length === 0 ? (
        <Text style={styles.emptyDetail}>No balances found.</Text>
      ) : (
        <View style={{ gap: 10, marginTop: 6 }}>
          {filtered.map((b, i) => {
            const type = getLeaveType(b.leave_type || "other");
            const totalDays = Number(b.total_days ?? b.quota ?? 0) || 0;
            const carried = Number(b.carried_forward ?? 0) || 0;
            const used = Number(b.used ?? 0) || 0;
            const total = totalDays + carried;
            const balance =
              b.balance != null ? Number(b.balance) : total - used;
            const pct =
              total > 0 ? Math.min(Math.round((used / total) * 100), 100) : 0;
            const barColor =
              pct >= 80 ? "#ef4444" : pct >= 50 ? "#f59e0b" : type.color;
            return (
              <View
                key={`${b.user_id}-${b.leave_type}-${i}`}
                style={styles.detailCard}
              >
                <View style={styles.allBalTop}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.policyName}>{b.full_name}</Text>
                    <Text style={styles.policyMeta}>
                      {type.label} · Year {b.year}
                    </Text>
                  </View>
                  <Pressable
                    style={styles.editBalBtn}
                    onPress={() => setEditItem({ ...b })}
                  >
                    <Text style={styles.editBalText}>Edit</Text>
                  </Pressable>
                </View>
                <View style={styles.detailNums}>
                  <View style={styles.detailNum}>
                    <Text style={[styles.detailBig, { color: type.color }]}>
                      {balance}
                    </Text>
                    <Text style={styles.detailSmall}>balance</Text>
                  </View>
                  <View style={styles.detailNumDivider} />
                  <View style={styles.detailNum}>
                    <Text style={styles.detailBig}>{used}</Text>
                    <Text style={styles.detailSmall}>used</Text>
                  </View>
                  <View style={styles.detailNumDivider} />
                  <View style={styles.detailNum}>
                    <Text style={styles.detailBig}>{totalDays}</Text>
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
              </View>
            );
          })}
        </View>
      )}

      {/* Edit modal */}
      <Modal
        visible={!!editItem}
        transparent
        animationType="fade"
        onRequestClose={() => setEditItem(null)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setEditItem(null)}
        >
          <Pressable
            style={styles.modalBox}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={styles.modalTitle}>
              Edit Balance — {editItem?.full_name}
            </Text>

            <Text style={styles.label}>Total Days</Text>
            <TextInput
              style={styles.input}
              keyboardType="number-pad"
              value={String(editItem?.total_days ?? "")}
              onChangeText={(v) =>
                setEditItem((p) =>
                  p ? { ...p, total_days: Number(v) || 0 } : p,
                )
              }
            />

            <Text style={styles.label}>Used</Text>
            <TextInput
              style={styles.input}
              keyboardType="number-pad"
              value={String(editItem?.used ?? "")}
              onChangeText={(v) =>
                setEditItem((p) => (p ? { ...p, used: Number(v) || 0 } : p))
              }
            />

            <Text style={styles.label}>Carried Forward</Text>
            <TextInput
              style={styles.input}
              keyboardType="number-pad"
              value={String(editItem?.carried_forward ?? "")}
              onChangeText={(v) =>
                setEditItem((p) =>
                  p ? { ...p, carried_forward: Number(v) || 0 } : p,
                )
              }
            />

            <View style={styles.modalFooter}>
              <Pressable
                style={styles.modalCancel}
                onPress={() => setEditItem(null)}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.modalSave, saving && styles.submitDisabled]}
                onPress={saveEdit}
                disabled={saving}
              >
                {saving ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.modalSaveText}>Save Changes</Text>
                )}
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </ScrollView>
  );
}

/* ───────────────────────── Styles ───────────────────────── */

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
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
      paddingHorizontal: 6,
      borderRadius: theme.radiusSm,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
    },
    subTabActive: {
      backgroundColor: theme.primary,
      borderColor: theme.primary,
    },
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
    typeChipText: {
      fontSize: 13,
      color: theme.textSecondary,
      fontWeight: "600",
    },
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
    balanceType: {
      fontSize: 13,
      color: theme.text,
      fontWeight: "600",
      flex: 1,
    },
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
    leaveTypeName: {
      fontSize: 14,
      fontWeight: "700",
      color: theme.text,
      flex: 1,
    },
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
    yearChipActive: {
      backgroundColor: theme.primary,
      borderColor: theme.primary,
    },
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

    // policies / all balances (HR)
    policyItem: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radius,
      padding: 12,
    },
    policyName: { fontSize: 14, fontWeight: "700", color: theme.text },
    policyMeta: { fontSize: 12, color: theme.textSecondary, marginTop: 2 },
    policyHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
    },
    addPolicyBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: theme.radiusSm,
      backgroundColor: theme.primary,
    },
    addPolicyText: { color: "#fff", fontSize: 13, fontWeight: "700" },
    policyActions: { flexDirection: "row", alignItems: "center", gap: 4 },
    policyActionBtn: {
      width: 34,
      height: 34,
      borderRadius: theme.radiusSm,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: theme.glassBorder,
      backgroundColor: theme.glass,
    },
    policyModalHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginBottom: 4,
    },
    inputDisabled: { opacity: 0.6 },
    swatchRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    swatch: {
      width: 32,
      height: 32,
      borderRadius: 16,
      borderWidth: 2,
      borderColor: "transparent",
    },
    swatchActive: { borderColor: theme.text },
    toggleRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: 8,
      marginTop: 8,
    },
    toggleLabel: { fontSize: 14, color: theme.text, flex: 1 },
    allBalTop: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
    },
    editBalBtn: {
      paddingHorizontal: 14,
      paddingVertical: 7,
      borderRadius: theme.radiusSm,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      backgroundColor: theme.glass,
    },
    editBalText: { color: theme.primary, fontSize: 12, fontWeight: "700" },

    // modal
    modalBackdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.6)",
      justifyContent: "center",
      alignItems: "center",
      padding: 24,
    },
    modalBox: {
      width: "100%",
      maxWidth: 360,
      backgroundColor: theme.bgElevated,
      borderRadius: theme.radiusLg,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      padding: 18,
    },
    modalTitle: { fontSize: 16, fontWeight: "800", color: theme.text },
    modalFooter: {
      flexDirection: "row",
      justifyContent: "flex-end",
      gap: 8,
      marginTop: 18,
    },
    modalCancel: {
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: theme.radiusSm,
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
    },
    modalCancelText: { color: theme.text, fontSize: 13, fontWeight: "600" },
    modalSave: {
      paddingHorizontal: 18,
      paddingVertical: 10,
      borderRadius: theme.radiusSm,
      backgroundColor: theme.primary,
    },
    modalSaveText: { color: "#fff", fontSize: 13, fontWeight: "700" },
  });
