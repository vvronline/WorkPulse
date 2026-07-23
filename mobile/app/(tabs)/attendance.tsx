import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BarChart3,
  Building2,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Download,
  FileEdit,
  FileText,
  House,
  Palmtree,
  PieChart,
  Plus,
  Timer,
  X,
} from "../../src/icons";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import { useDialog } from "../../src/hooks/useDialog";
import { socket } from "../../src/realtime/socket";
import { formatTime } from "../../src/utils/time";
import LeavesTab from "../../src/components/LeavesTab";
import DatePicker from "../../src/components/DatePicker";
import TimePicker from "../../src/components/TimePicker";
import PendingRequestsList from "../../src/components/manualEntry/PendingRequestsList";
import AnalyticsWidgetsGrid from "../../src/components/analytics/WidgetsGrid";
import AnalyticsSummaryStats from "../../src/components/analytics/SummaryStats";
import WorkBreakChart from "../../src/components/analytics/WorkBreakChart";
import TrendChart from "../../src/components/analytics/TrendChart";
import DoughnutChart from "../../src/components/analytics/DoughnutChart";
import AnalyticsHistoryTable from "../../src/components/analytics/HistoryTable";
import { exportMyAnalytics } from "../../src/components/analytics/analyticsExport";
import {
  addManualEntry,
  getCurrentOrg,
  getEntries,
  getHolidays,
  getLeaves,
  getManualEntryRequests,
  getOvertimeRequests,
  getTrackerAnalytics,
  getTrackerHistory,
  getTrackerStatus,
  getTrackerWidgets,
  submitOvertimeRequest,
  updateManualEntry,
  type AnalyticsPoint,
  type Holiday,
  type HistoryEntry,
  type Leave,
  type ManualEntryRequest,
  type OrgInfo,
  type OvertimeRequest,
  type TrackerEntry,
} from "../../src/features";
import type { WidgetsData } from "../../src/components/analytics/WidgetsGrid";
import { makeStyles } from "../../src/screens/tabStyles/attendance.styles";

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

// Stable empty references so memoized derivations don't recompute every render
// while the query is still loading (data is undefined until the first resolve).
const EMPTY_ENTRIES: Record<string, HistoryEntry> = {};
const EMPTY_LEAVES: Leave[] = [];
const EMPTY_HOLIDAYS: Holiday[] = [];
const EMPTY_ANALYTICS: AnalyticsPoint[] = [];
const EMPTY_HISTORY: HistoryEntry[] = [];

type OverviewData = {
  entries: Record<string, HistoryEntry>;
  leaves: Leave[];
  holidays: Holiday[];
  org: OrgInfo | null;
};

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function buildMonthGrid(cursor: Date): Date[] {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const startOffset = first.getDay();
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - startOffset);
  const days: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    days.push(d);
  }
  return days;
}

/** Parse "1,2,3,4,5" work_days into a Set of JS DOW values (0=Sun..6=Sat). */
function workDaysToJsDowSet(value: unknown): Set<number> {
  const raw = value && typeof value === "string" ? value : "1,2,3,4,5";
  const nums = raw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  return new Set(nums.length > 0 ? nums : [1, 2, 3, 4, 5]);
}

function toYMD(v: unknown): string {
  if (!v) return "";
  if (typeof v === "string") return v.slice(0, 10);
  const d = new Date(v as any);
  if (isNaN(d.getTime())) return "";
  return ymd(d);
}

type Tab = "overview" | "leaves" | "manual" | "analytics";

const VALID_TABS: Tab[] = ["overview", "leaves", "manual", "analytics"];

export default function AttendanceScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const params = useLocalSearchParams<{ tab?: string }>();
  const initialTab: Tab = VALID_TABS.includes(params.tab as Tab)
    ? (params.tab as Tab)
    : "overview";
  const [tab, setTab] = useState<Tab>(initialTab);

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Attendance" }} />
      <View style={styles.tabRow}>
        <TabBtn
          label="Overview"
          icon={CalendarDays}
          active={tab === "overview"}
          onPress={() => setTab("overview")}
        />
        <TabBtn
          label="Leaves"
          icon={Palmtree}
          active={tab === "leaves"}
          onPress={() => setTab("leaves")}
        />
        <TabBtn
          label="Manual"
          icon={FileEdit}
          active={tab === "manual"}
          onPress={() => setTab("manual")}
        />
        <TabBtn
          label="Analytics"
          icon={BarChart3}
          active={tab === "analytics"}
          onPress={() => setTab("analytics")}
        />
      </View>
      {tab === "overview" ? (
        <OverviewTab />
      ) : tab === "leaves" ? (
        <LeavesTab />
      ) : tab === "manual" ? (
        <ManualTab />
      ) : (
        <AnalyticsTab />
      )}
    </View>
  );
}

function TabBtn({
  label,
  icon: Icon,
  active,
  onPress,
}: {
  label: string;
  icon: typeof CalendarDays;
  active: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <Pressable
      style={[styles.tabBtn, active && styles.tabBtnActive]}
      onPress={onPress}
    >
      <Icon size={15} color={active ? "#fff" : theme.textSecondary} />
      <Text style={[styles.tabText, active && styles.tabTextActive]}>
        {label}
      </Text>
    </Pressable>
  );
}

/* ───────────────────────── Overview (calendar + history) ───────────────────────── */

type DayKind =
  | "present"
  | "leave"
  | "leave-pending"
  | "holiday"
  | "weekend"
  | "absent"
  | "in_progress"
  | "future"
  | "none";

async function fetchOverview(cursor: Date): Promise<OverviewData> {
  const grid = buildMonthGrid(
    new Date(cursor.getFullYear(), cursor.getMonth(), 1),
  );
  const from = ymd(grid[0]);
  const to = ymd(grid[41]);
  const [histRes, leavesRes, holRes, orgRes] = await Promise.allSettled([
    getTrackerHistory(from, to),
    getLeaves(from, to),
    getHolidays(cursor.getFullYear()),
    getCurrentOrg(),
  ]);
  const entries: Record<string, HistoryEntry> = {};
  if (histRes.status === "fulfilled") {
    (histRes.value.data || []).forEach((e) => {
      entries[e.date.slice(0, 10)] = e;
    });
  }
  return {
    entries,
    leaves: leavesRes.status === "fulfilled" ? leavesRes.value.data || [] : [],
    holidays: holRes.status === "fulfilled" ? holRes.value.data || [] : [],
    org: orgRes.status === "fulfilled" ? orgRes.value.data || null : null,
  };
}

function OverviewTab() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const KIND_DOT = useMemo(() => makeKindDot(theme), [theme]);
  const queryClient = useQueryClient();
  const [cursor, setCursor] = useState(new Date());
  const [selected, setSelected] = useState(ymd(new Date()));
  const [refreshing, setRefreshing] = useState(false);

  // Stale-while-revalidate per visible month. Cached data (restored from MMKV on
  // a cold start, or from a previous visit) renders the calendar instantly while
  // a background refetch keeps it current — no full-screen spinner on tab switch.
  const overviewKey = useMemo(
    () => ["attendance", "overview", cursor.getFullYear(), cursor.getMonth()],
    [cursor],
  );
  const { data, isLoading, refetch } = useQuery({
    queryKey: overviewKey,
    queryFn: () => fetchOverview(cursor),
  });
  const entries = data?.entries ?? EMPTY_ENTRIES;
  const leaves = data?.leaves ?? EMPTY_LEAVES;
  const holidays = data?.holidays ?? EMPTY_HOLIDAYS;
  const org = data?.org ?? null;
  const loading = isLoading;

  const monthDays = useMemo(() => buildMonthGrid(cursor), [cursor]);
  const todayKey = ymd(new Date());
  const today = useMemo(() => new Date(todayKey + "T00:00:00"), [todayKey]);

  const workDayJsDowSet = useMemo(
    () => workDaysToJsDowSet(org?.work_days),
    [org],
  );

  const minHoursPresent = useMemo(() => {
    if (org?.min_hours_present != null && org.min_hours_present !== "") {
      const v = Number(org.min_hours_present);
      if (!isNaN(v) && v >= 0) return v;
    }
    if (org?.work_hours_per_day) {
      const v = Number(org.work_hours_per_day) / 2;
      if (!isNaN(v) && v > 0) return v;
    }
    return 4;
  }, [org]);

  // Background-refresh the visible month whenever the tab regains focus: marks
  // the query stale so it refetches while cached calendar data stays on screen.
  useFocusEffect(
    useCallback(() => {
      queryClient.invalidateQueries({ queryKey: overviewKey });
    }, [queryClient, overviewKey]),
  );

  const leaveMap = useMemo(() => {
    const m = new Map<string, Leave>();
    leaves.forEach((l) => {
      const k = toYMD(l.date);
      if (k) m.set(k, l);
    });
    return m;
  }, [leaves]);

  const holidayMap = useMemo(() => {
    const m = new Map<string, Holiday>();
    holidays.forEach((h) => {
      const k = toYMD(h.date);
      if (k) m.set(k, h);
    });
    return m;
  }, [holidays]);

  const minMinutes = minHoursPresent * 60;

  const classify = useCallback(
    (d: Date): DayKind => {
      const key = ymd(d);
      const isFuture = d > today;
      const isToday = key === todayKey;
      const isWeekend = !workDayJsDowSet.has(d.getDay());
      const leave = leaveMap.get(key);
      const isHoliday = holidayMap.has(key);
      const entry = entries[key];
      const isPresent = (entry?.floorMinutes ?? 0) >= minMinutes;

      if (isPresent) return "present";
      if (leave) return leave.status === "approved" ? "leave" : "leave-pending";
      if (isHoliday || isWeekend) return isWeekend ? "weekend" : "holiday";
      if (isToday) return "in_progress";
      if (isFuture) return "future";
      return "absent";
    },
    [
      today,
      todayKey,
      workDayJsDowSet,
      leaveMap,
      holidayMap,
      entries,
      minMinutes,
    ],
  );

  const stats = useMemo(() => {
    let present = 0,
      absent = 0,
      leaveCount = 0,
      holidayCount = 0;
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    for (let d = 1; d <= daysInMonth; d++) {
      const dt = new Date(year, month, d);
      if (dt > today) continue;
      const kind = classify(dt);
      if (kind === "present") present++;
      else if (kind === "leave") leaveCount++;
      else if (kind === "holiday" || kind === "weekend") holidayCount++;
      else if (kind === "absent") absent++;
    }
    return { present, absent, leave: leaveCount, holiday: holidayCount };
  }, [cursor, classify, today]);

  const sel = entries[selected];
  const selLeave = leaveMap.get(selected);
  const selHoliday = holidayMap.get(selected);

  return (
    <ScrollView
      contentContainerStyle={styles.body}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => {
            setRefreshing(true);
            refetch().finally(() => setRefreshing(false));
          }}
          tintColor={theme.primary}
        />
      }
    >
      <View style={styles.monthHeader}>
        <Text style={styles.monthLabel}>
          {cursor.toLocaleDateString("en-US", {
            month: "long",
            year: "numeric",
          })}
        </Text>
        <View style={styles.monthNav}>
          <Pressable
            style={styles.navBtn}
            onPress={() =>
              setCursor((c) => new Date(c.getFullYear(), c.getMonth() - 1, 1))
            }
            hitSlop={6}
          >
            <ChevronLeft size={20} color={theme.textSecondary} />
          </Pressable>
          <Pressable
            style={styles.todayBtn}
            onPress={() => {
              const now = new Date();
              setCursor(new Date(now.getFullYear(), now.getMonth(), 1));
              setSelected(ymd(now));
            }}
          >
            <Text style={styles.todayText}>Today</Text>
          </Pressable>
          <Pressable
            style={styles.navBtn}
            onPress={() =>
              setCursor((c) => new Date(c.getFullYear(), c.getMonth() + 1, 1))
            }
            hitSlop={6}
          >
            <ChevronRight size={20} color={theme.textSecondary} />
          </Pressable>
        </View>
      </View>

      {/* Legend */}
      <View style={styles.legend}>
        <LegendItem
          color={theme.success}
          label={`Present (≥${minHoursPresent}h)`}
        />
        <LegendItem color={theme.danger} label="Absent" />
        <LegendItem color="#0ea5e9" label="Leave" />
        <LegendItem color={theme.warning} label="Pending" />
        <LegendItem color={theme.textMuted} label="Holiday/Weekend" />
      </View>

      <View style={styles.weekRow}>
        {WEEKDAYS.map((w, i) => (
          <Text key={i} style={styles.weekday}>
            {w}
          </Text>
        ))}
      </View>
      <View style={styles.grid}>
        {monthDays.map((d) => {
          const key = ymd(d);
          const inMonth = d.getMonth() === cursor.getMonth();
          const isToday = key === todayKey;
          const isSelected = key === selected;
          const kind = classify(d);
          const dotColor = KIND_DOT[kind];
          return (
            <Pressable
              key={key}
              style={styles.cell}
              onPress={() => setSelected(key)}
            >
              <View
                style={[
                  styles.cellInner,
                  isSelected && styles.cellSelected,
                  isToday && !isSelected && styles.cellToday,
                ]}
              >
                <Text
                  style={[
                    styles.cellNum,
                    !inMonth && styles.cellNumMuted,
                    (isSelected || isToday) && styles.cellNumActive,
                  ]}
                >
                  {d.getDate()}
                </Text>
                {dotColor ? (
                  <View
                    style={[styles.workDot, { backgroundColor: dotColor }]}
                  />
                ) : (
                  <View style={styles.workDotSpacer} />
                )}
              </View>
            </Pressable>
          );
        })}
      </View>

      {/* Monthly stats */}
      <View style={styles.statsRow}>
        <StatCard
          label="Present"
          value={String(stats.present)}
          color={theme.success}
        />
        <StatCard
          label="Absent"
          value={String(stats.absent)}
          color={theme.danger}
        />
        <StatCard label="Leave" value={String(stats.leave)} color="#0ea5e9" />
        <StatCard
          label="Holiday"
          value={String(stats.holiday)}
          color={theme.textMuted}
        />
      </View>

      <View style={styles.detailHeader}>
        <Text style={styles.detailTitle}>
          {new Date(selected + "T00:00:00").toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
          })}
        </Text>
        {loading ? (
          <ActivityIndicator color={theme.primary} size="small" />
        ) : null}
      </View>

      {sel && (sel.clock_in || (sel.floorMinutes ?? 0) > 0) ? (
        <View style={styles.detailCard}>
          <DetailRow
            label="Clock In"
            value={sel.clock_in ? fmtTime(sel.clock_in) : "—"}
          />
          <View style={styles.divider} />
          <DetailRow
            label="Clock Out"
            value={sel.clock_out ? fmtTime(sel.clock_out) : "—"}
          />
          <View style={styles.divider} />
          <DetailRow label="Worked" value={formatTime(sel.floorMinutes ?? 0)} />
          <View style={styles.divider} />
          <DetailRow label="Break" value={formatTime(sel.breakMinutes ?? 0)} />
          {sel.work_mode ? (
            <>
              <View style={styles.divider} />
              <DetailRow label="Mode" value={sel.work_mode} />
            </>
          ) : null}
        </View>
      ) : selLeave ? (
        <View style={styles.detailCard}>
          <DetailRow label="Status" value={`${selLeave.leave_type} leave`} />
          <View style={styles.divider} />
          <DetailRow label="Approval" value={selLeave.status} />
          {selLeave.reason ? (
            <>
              <View style={styles.divider} />
              <DetailRow label="Reason" value={selLeave.reason} />
            </>
          ) : null}
        </View>
      ) : selHoliday ? (
        <View style={styles.detailCard}>
          <DetailRow
            label="Holiday"
            value={selHoliday.name || "Public holiday"}
          />
        </View>
      ) : (
        <Text style={styles.emptyDetail}>
          No attendance recorded for this day.
        </Text>
      )}
    </ScrollView>
  );
}

const makeKindDot = (theme: Theme): Record<DayKind, string | null> => ({
  present: theme.success,
  leave: "#0ea5e9",
  "leave-pending": theme.warning,
  holiday: theme.textMuted,
  weekend: null,
  absent: theme.danger,
  in_progress: null,
  future: null,
  none: null,
});

function LegendItem({ color, label }: { color: string; label: string }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={styles.legendText}>{label}</Text>
    </View>
  );
}

function fmtTime(iso: string) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function tsToLocalHHMM(ts?: string | null): string {
  if (!ts) return "09:00";
  const normalized = ts.includes("T") ? ts : ts.replace(" ", "T") + "Z";
  const d = new Date(normalized);
  if (isNaN(d.getTime())) return "09:00";
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

/* ───────────────────────── Manual entry ───────────────────────── */

type BreakItem = { start: string; end: string };

const ENTRY_LABELS: Record<string, string> = {
  clock_in: "Logged In",
  break_start: "Break Started",
  break_end: "Break Ended",
  clock_out: "Logged Out",
};

function ManualTab() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [date, setDate] = useState(ymd(new Date()));
  const [clockIn, setClockIn] = useState("09:00");
  const [clockOut, setClockOut] = useState("18:00");
  const [skipClockOut, setSkipClockOut] = useState(false);
  const [breaks, setBreaks] = useState<BreakItem[]>([
    { start: "13:00", end: "13:30" },
  ]);
  const [workMode, setWorkMode] = useState<"office" | "remote">("office");
  const [busy, setBusy] = useState(false);

  const [checking, setChecking] = useState(false);
  const [existingEntries, setExistingEntries] = useState<TrackerEntry[] | null>(
    null,
  );
  const [leaveOnDate, setLeaveOnDate] = useState<Leave | null>(null);
  const [currentlyClocked, setCurrentlyClocked] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);

  const [pendingRequests, setPendingRequests] = useState<ManualEntryRequest[]>(
    [],
  );

  const todayKey = ymd(new Date());

  const loadPending = useCallback(async () => {
    try {
      const r = await getManualEntryRequests();
      setPendingRequests(Array.isArray(r.data) ? r.data : []);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadPending();
  }, [loadPending]);

  // Refresh the pending-request list whenever the tab regains focus (e.g. after
  // the entry was approved/rejected on another screen).
  useFocusEffect(
    useCallback(() => {
      loadPending();
    }, [loadPending]),
  );

  // Real-time refresh: the server broadcasts `approval_update` to the requester
  // when a manual entry is approved/rejected. Re-pull the request list so its
  // status badge flips without needing a manual reload (mirrors the web client).
  useEffect(() => {
    const off = socket.subscribe((msg) => {
      if (msg.type === "approval_update") {
        loadPending();
      }
    });
    return off;
  }, [loadPending]);

  const checkDate = useCallback(
    async (dateVal: string) => {
      setExistingEntries(null);
      setLeaveOnDate(null);
      setCurrentlyClocked(false);
      setIsEditMode(false);
      if (!dateVal) return;
      setChecking(true);
      try {
        const [entriesRes, leavesRes] = await Promise.all([
          getEntries(dateVal),
          getLeaves(dateVal, dateVal),
        ]);
        if (entriesRes.data.length > 0) setExistingEntries(entriesRes.data);
        if (leavesRes.data.length > 0) setLeaveOnDate(leavesRes.data[0]);
        if (dateVal === todayKey) {
          const statusRes = await getTrackerStatus();
          if (statusRes.data.state !== "logged_out") setCurrentlyClocked(true);
        }
      } catch {
        /* ignore */
      } finally {
        setChecking(false);
      }
    },
    [todayKey],
  );

  useEffect(() => {
    checkDate(date);
  }, [date, checkDate]);

  const handleEditExisting = () => {
    if (!existingEntries) return;
    const ci = existingEntries.find((e) => e.entry_type === "clock_in");
    const co = existingEntries.find((e) => e.entry_type === "clock_out");
    const bs = existingEntries.filter((e) => e.entry_type === "break_start");
    const be = existingEntries.filter((e) => e.entry_type === "break_end");
    setClockIn(ci ? tsToLocalHHMM(ci.timestamp) : "09:00");
    setClockOut(co ? tsToLocalHHMM(co.timestamp) : "");
    setSkipClockOut(!co);
    setBreaks(
      bs.length > 0
        ? bs.map((b, i) => ({
            start: tsToLocalHHMM(b.timestamp),
            end: be[i] ? tsToLocalHHMM(be[i].timestamp) : "",
          }))
        : [{ start: "", end: "" }],
    );
    setWorkMode((ci?.work_mode as any) === "remote" ? "remote" : "office");
    setIsEditMode(true);
  };

  const addBreak = () => setBreaks((b) => [...b, { start: "", end: "" }]);
  const removeBreak = (i: number) =>
    setBreaks((b) => b.filter((_, idx) => idx !== i));
  const updateBreak = (i: number, field: keyof BreakItem, value: string) =>
    setBreaks((b) =>
      b.map((item, idx) => (idx === i ? { ...item, [field]: value } : item)),
    );

  async function submit() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      Alert.alert("Invalid date", "Please pick a date.");
      return;
    }
    if (!/^\d{2}:\d{2}$/.test(clockIn)) {
      Alert.alert("Invalid time", "Please set a login time.");
      return;
    }
    if (!skipClockOut && !/^\d{2}:\d{2}$/.test(clockOut)) {
      Alert.alert(
        "Invalid time",
        'Set a logout time or check "Still working".',
      );
      return;
    }
    setBusy(true);
    try {
      const validBreaks = breaks.filter(
        (b) => /^\d{2}:\d{2}$/.test(b.start) && /^\d{2}:\d{2}$/.test(b.end),
      );
      const payload = {
        clock_in: clockIn,
        clock_out: skipClockOut ? undefined : clockOut,
        breaks: validBreaks.length > 0 ? validBreaks : undefined,
        timezoneOffset: new Date().getTimezoneOffset(),
        work_mode: workMode,
      };
      let serverMsg = "";
      if (isEditMode) {
        // For days that already hold recorded (approved / live-tracked)
        // entries the server keeps the originals intact and files a pending
        // manager-approval request instead of overwriting them.
        const res = await updateManualEntry(date, payload);
        serverMsg = (res?.data as any)?.message || "";
      } else {
        const res = await addManualEntry({ date, ...payload });
        serverMsg = (res?.data as any)?.message || "";
      }
      Alert.alert(
        "Submitted",
        serverMsg ||
          `${isEditMode ? "Entry updated" : "Manual entry submitted"} for ${date}. It may require approval.`,
      );
      setIsEditMode(false);
      loadPending();
      checkDate(date);
    } catch (e: any) {
      Alert.alert(
        "Error",
        e?.response?.data?.error || "Failed to submit manual entry",
      );
    } finally {
      setBusy(false);
    }
  }

  const showForm =
    !leaveOnDate && !currentlyClocked && (!existingEntries || isEditMode);

  return (
    <ScrollView
      contentContainerStyle={styles.body}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.hint}>
        Add or edit time entries for days you forgot to use the tracker. If you
        report to a manager, entries are sent for approval.
      </Text>

      {/* Date picker */}
      {!isEditMode ? (
        <>
          <Text style={styles.label}>Date</Text>
          <DatePicker value={date} onChange={setDate} maxDate={todayKey} />
        </>
      ) : (
        <>
          <View style={styles.editBanner}>
            <Text style={styles.editBannerText}>
              Editing entry for <Text style={{ fontWeight: "800" }}>{date}</Text>
            </Text>
            <Pressable onPress={() => setIsEditMode(false)} hitSlop={8}>
              <X size={16} color={theme.textSecondary} />
            </Pressable>
          </View>
          {existingEntries && existingEntries.length > 0 ? (
            <View style={[styles.warnCard, styles.warnExisting]}>
              <Text style={styles.warnTitle}>
                Edits to recorded days require manager approval
              </Text>
              <Text style={styles.warnBody}>
                Your existing entries stay in place. This edit will be sent to
                your manager for approval and only applied once approved.
              </Text>
            </View>
          ) : null}
        </>
      )}

      {checking ? (
        <Text style={styles.infoText}>Checking for existing entries…</Text>
      ) : null}

      {/* Leave warning */}
      {leaveOnDate ? (
        <View style={[styles.warnCard, styles.warnLeave]}>
          <Text style={styles.warnTitle}>Leave recorded on this date</Text>
          <Text style={styles.warnBody}>
            You have a {leaveOnDate.leave_type} leave on {date}. Remove the
            leave from the Leaves tab first to add a manual entry.
          </Text>
        </View>
      ) : null}

      {/* Clocked-in warning */}
      {currentlyClocked ? (
        <View style={[styles.warnCard, styles.warnClocked]}>
          <Text style={styles.warnTitle}>You're currently clocked in</Text>
          <Text style={styles.warnBody}>
            Manual entry for today is only allowed after you've clocked out.
            Logout from the dashboard first.
          </Text>
        </View>
      ) : null}

      {/* Existing entries panel */}
      {existingEntries && !isEditMode && !currentlyClocked && !leaveOnDate ? (
        <View style={[styles.warnCard, styles.warnExisting]}>
          <Text style={styles.warnTitle}>
            Entries already exist for this date
          </Text>
          <View style={{ gap: 6, marginTop: 8 }}>
            {existingEntries.map((e, i) => (
              <View key={i} style={styles.existingRow}>
                <Text style={styles.existingLabel}>
                  {ENTRY_LABELS[e.entry_type] || e.entry_type}
                </Text>
                <Text style={styles.existingTime}>
                  {tsToLocalHHMM(e.timestamp)}
                </Text>
              </View>
            ))}
          </View>
          <Pressable
            style={styles.editExistingBtn}
            onPress={handleEditExisting}
          >
            <FileEdit size={14} color="#fff" />
            <Text style={styles.editExistingText}>Edit These Entries</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Form */}
      {showForm ? (
        <>
          <Text style={styles.label}>Work Mode</Text>
          <View style={styles.modeRow}>
            <Pressable
              style={[
                styles.modeChip,
                workMode === "office" && styles.modeChipActive,
              ]}
              onPress={() => setWorkMode("office")}
            >
              <Building2
                size={14}
                color={workMode === "office" ? "#fff" : theme.textSecondary}
              />
              <Text
                style={[
                  styles.modeText,
                  workMode === "office" && styles.modeTextActive,
                ]}
              >
                Office
              </Text>
            </Pressable>
            <Pressable
              style={[
                styles.modeChip,
                workMode === "remote" && styles.modeChipActive,
              ]}
              onPress={() => setWorkMode("remote")}
            >
              <House
                size={14}
                color={workMode === "remote" ? "#fff" : theme.textSecondary}
              />
              <Text
                style={[
                  styles.modeText,
                  workMode === "remote" && styles.modeTextActive,
                ]}
              >
                Remote
              </Text>
            </Pressable>
          </View>

          <View style={styles.timeRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Login Time</Text>
              <TimePicker value={clockIn} onChange={setClockIn} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Logout Time</Text>
              <TimePicker
                value={clockOut}
                onChange={setClockOut}
                disabled={skipClockOut}
              />
            </View>
          </View>

          <Pressable
            style={styles.checkRow}
            onPress={() => {
              setSkipClockOut((v) => {
                if (!v) setClockOut("");
                return !v;
              });
            }}
          >
            <View style={[styles.checkbox, skipClockOut && styles.checkboxOn]}>
              {skipClockOut ? <Text style={styles.checkMark}>✓</Text> : null}
            </View>
            <Text style={styles.checkLabel}>Still working (skip logout)</Text>
          </Pressable>

          {/* Breaks */}
          <View style={styles.breaksHeader}>
            <Text style={styles.label}>Breaks</Text>
            <Pressable style={styles.addBreakBtn} onPress={addBreak}>
              <Plus size={13} color={theme.primary} />
              <Text style={styles.addBreakText}>Add Break</Text>
            </Pressable>
          </View>
          {breaks.map((brk, i) => (
            <View key={i} style={styles.breakRow}>
              <View style={{ flex: 1 }}>
                <TimePicker
                  value={brk.start}
                  onChange={(v) => updateBreak(i, "start", v)}
                  placeholder="Start"
                />
              </View>
              <View style={{ flex: 1 }}>
                <TimePicker
                  value={brk.end}
                  onChange={(v) => updateBreak(i, "end", v)}
                  placeholder="End"
                />
              </View>
              <Pressable
                style={styles.removeBreakBtn}
                onPress={() => removeBreak(i)}
                hitSlop={6}
              >
                <X size={16} color={theme.danger} />
              </Pressable>
            </View>
          ))}

          <Pressable
            style={[styles.submit, busy && styles.submitDisabled]}
            onPress={submit}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.submitText}>
                {isEditMode ? "Update Entry" : "Save Manual Entry"}
              </Text>
            )}
          </Pressable>
        </>
      ) : null}

      {/* Pending manual-entry requests */}
      <View style={styles.requestsSection}>
        <View style={styles.sectionTitleRow}>
          <ClipboardList size={16} color={theme.text} />
          <Text style={styles.sectionTitle}>Your Manual-Entry Requests</Text>
        </View>
        <PendingRequestsList
          requests={pendingRequests}
          keyField="request_id"
          statusField="approval_status"
          emptyText="No pending manual-entry requests."
          renderTime={(meta) =>
            `${meta.clock_in || ""}${meta.clock_out ? ` → ${meta.clock_out}` : ""}` ||
            "—"
          }
        />
      </View>

      {/* Overtime */}
      <OvertimeSection />
    </ScrollView>
  );
}

const STATUS_BADGE: Record<
  string,
  { label: string; color: string; bg: string }
> = {
  pending: { label: "Pending", color: "#f59e0b", bg: "rgba(245,158,11,0.12)" },
  approved: {
    label: "Approved",
    color: "#10b981",
    bg: "rgba(16,185,129,0.12)",
  },
  rejected: { label: "Rejected", color: "#ef4444", bg: "rgba(239,68,68,0.12)" },
};

/* ───────────────────────── Overtime ───────────────────────── */

function OvertimeSection() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [otDate, setOtDate] = useState(ymd(new Date()));
  const [otHours, setOtHours] = useState("");
  const [otReason, setOtReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [requests, setRequests] = useState<OvertimeRequest[]>([]);

  const load = useCallback(async () => {
    try {
      const r = await getOvertimeRequests();
      setRequests(Array.isArray(r.data) ? r.data : []);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function submit() {
    const hours = parseFloat(otHours);
    if (!otDate || !otHours || isNaN(hours) || hours <= 0) {
      Alert.alert("Invalid", "Enter a valid date and number of hours.");
      return;
    }
    if (!otReason.trim()) {
      Alert.alert("Reason required", "Please provide a reason for overtime.");
      return;
    }
    setBusy(true);
    try {
      await submitOvertimeRequest({
        date: otDate,
        hours,
        reason: otReason.trim(),
      });
      Alert.alert("Submitted", "Your overtime request has been submitted.");
      setOtHours("");
      setOtReason("");
      load();
    } catch (e: any) {
      Alert.alert(
        "Error",
        e?.response?.data?.error || "Failed to submit overtime request",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.requestsSection}>
      <View style={styles.sectionTitleRow}>
        <Timer size={16} color={theme.text} />
        <Text style={styles.sectionTitle}>Overtime Request</Text>
      </View>

      <Text style={styles.label}>Date</Text>
      <DatePicker
        value={otDate}
        onChange={setOtDate}
        maxDate={ymd(new Date())}
      />

      <Text style={styles.label}>Extra Hours</Text>
      <TextInput
        style={styles.input}
        value={otHours}
        onChangeText={setOtHours}
        placeholder="e.g. 2"
        placeholderTextColor={theme.textMuted}
        keyboardType="decimal-pad"
      />

      <Text style={styles.label}>Reason</Text>
      <TextInput
        style={[styles.input, styles.textarea]}
        value={otReason}
        onChangeText={setOtReason}
        placeholder="Why do you need overtime?"
        placeholderTextColor={theme.textMuted}
        multiline
        numberOfLines={3}
      />

      <Pressable
        style={[styles.submit, busy && styles.submitDisabled]}
        onPress={submit}
        disabled={busy}
      >
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.submitText}>Submit Overtime Request</Text>
        )}
      </Pressable>

      {requests.length > 0 ? (
        <View style={{ marginTop: 14 }}>
          <PendingRequestsList
            requests={requests}
            keyField="id"
            statusField="status"
            showReason
            emptyText="No overtime requests yet."
            renderTime={(meta) =>
              meta.hours != null ? `${meta.hours}h overtime` : "—"
            }
          />
        </View>
      ) : null}
    </View>
  );
}

/* ───────────────────────── Analytics ───────────────────────── */
const RANGES: { value: number | "custom"; label: string }[] = [
  { value: 7, label: "7d" },
  { value: 14, label: "14d" },
  { value: 30, label: "30d" },
  { value: "custom", label: "Custom" },
];

function localDateNDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return ymd(d);
}

function AnalyticsTab() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { alert, dialog } = useDialog();
  const [range, setRange] = useState<number | "custom">(7);
  const [customFrom, setCustomFrom] = useState(localDateNDaysAgo(7));
  const [customTo, setCustomTo] = useState(ymd(new Date()));
  const [exporting, setExporting] = useState<"csv" | "pdf" | null>(null);

  const isCustom = range === "custom";
  const fromDate = isCustom ? customFrom : localDateNDaysAgo(range as number);
  const toDate = isCustom ? customTo : ymd(new Date());

  const { data: analytics, isLoading } = useQuery({
    queryKey: ["attendance", "analytics", range, fromDate, toDate],
    enabled: !isCustom || (!!customFrom && !!customTo),
    queryFn: async () => {
      const [aRes, hRes, wRes] = await Promise.allSettled([
        isCustom
          ? getTrackerHistory(fromDate, toDate)
          : getTrackerAnalytics(range as number),
        getTrackerHistory(fromDate, toDate),
        getTrackerWidgets(),
      ]);
      // history endpoint returns HistoryEntry[]; analytics returns AnalyticsPoint[]
      const arr =
        aRes.status === "fulfilled" ? ((aRes.value.data || []) as any[]) : [];
      return {
        data: arr.map((d) => ({
          date: d.date.slice(0, 10),
          floorMinutes: d.floorMinutes || 0,
          breakMinutes: d.breakMinutes || 0,
          workMode: d.work_mode || d.workMode,
        })) as AnalyticsPoint[],
        history: (hRes.status === "fulfilled"
          ? hRes.value.data || []
          : []) as HistoryEntry[],
        widgets: (wRes.status === "fulfilled"
          ? wRes.value.data || null
          : null) as WidgetsData | null,
      };
    },
  });

  const data = analytics?.data ?? EMPTY_ANALYTICS;
  const history = analytics?.history ?? EMPTY_HISTORY;
  const widgets = analytics?.widgets ?? null;
  // Only block on a true cold cache; cached data renders instantly on revisit.
  const loading = isLoading;

  const onExport = useCallback(
    async (format: "csv" | "pdf") => {
      setExporting(format);
      try {
        await exportMyAnalytics(fromDate, toDate, format);
      } catch (e: any) {
        alert("Export failed", e?.message || "Could not export analytics.");
      } finally {
        setExporting(null);
      }
    },
    [fromDate, toDate, alert],
  );

  const labels = useMemo(
    () =>
      data.map((d) =>
        new Date(d.date + "T00:00:00").toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
        }),
      ),
    [data],
  );
  const floorHours = useMemo(
    () => data.map((d) => +((d.floorMinutes || 0) / 60).toFixed(2)),
    [data],
  );
  const breakHours = useMemo(
    () => data.map((d) => +((d.breakMinutes || 0) / 60).toFixed(2)),
    [data],
  );

  const totalWorked = data.reduce((s, d) => s + (d.floorMinutes || 0), 0);
  const totalBreak = data.reduce((s, d) => s + (d.breakMinutes || 0), 0);
  const officeDays = data.filter(
    (d) => (d.floorMinutes || 0) > 0 && d.workMode !== "remote",
  ).length;
  const remoteDays = data.filter(
    (d) => (d.floorMinutes || 0) > 0 && d.workMode === "remote",
  ).length;

  return (
    <ScrollView contentContainerStyle={styles.body}>
      <View style={styles.analyticsHeaderRow}>
        <View style={styles.sectionTitleRow}>
          <BarChart3 size={18} color={theme.text} />
          <Text style={styles.analyticsTitle}>Analytics &amp; History</Text>
        </View>
      </View>

      <View style={styles.rangeRow}>
        {RANGES.map((r) => (
          <Pressable
            key={String(r.value)}
            style={[
              styles.rangeChip,
              range === r.value && styles.rangeChipActive,
            ]}
            onPress={() => setRange(r.value)}
          >
            <Text
              style={[
                styles.rangeText,
                range === r.value && styles.rangeTextActive,
              ]}
            >
              {r.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {isCustom ? (
        <View style={styles.customRange}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>From</Text>
            <DatePicker
              value={customFrom}
              onChange={setCustomFrom}
              maxDate={customTo || ymd(new Date())}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>To</Text>
            <DatePicker
              value={customTo}
              onChange={setCustomTo}
              minDate={customFrom}
              maxDate={ymd(new Date())}
            />
          </View>
        </View>
      ) : null}

      {/* Export toolbar */}
      <View style={styles.exportRow}>
        <Pressable
          style={[
            styles.exportBtn,
            exporting === "csv" && styles.exportBtnBusy,
          ]}
          onPress={() => onExport("csv")}
          disabled={!!exporting}
        >
          {exporting === "csv" ? (
            <ActivityIndicator size="small" color={theme.primary} />
          ) : (
            <Download size={14} color={theme.primary} />
          )}
          <Text style={styles.exportText}>CSV</Text>
        </Pressable>
        <Pressable
          style={[
            styles.exportBtn,
            exporting === "pdf" && styles.exportBtnBusy,
          ]}
          onPress={() => onExport("pdf")}
          disabled={!!exporting}
        >
          {exporting === "pdf" ? (
            <ActivityIndicator size="small" color={theme.primary} />
          ) : (
            <FileText size={14} color={theme.primary} />
          )}
          <Text style={styles.exportText}>PDF</Text>
        </Pressable>
      </View>

      {loading ? (
        <ActivityIndicator color={theme.primary} style={{ marginTop: 24 }} />
      ) : (
        <>
          {/* Dashboard widgets */}
          <AnalyticsWidgetsGrid widgets={widgets} />

          {/* Summary stats */}
          <AnalyticsSummaryStats data={data} />

          {data.length === 0 ? (
            <Text style={styles.emptyDetail}>No data for this period.</Text>
          ) : (
            <>
              <WorkBreakChart
                labels={labels}
                floorHours={floorHours}
                breakHours={breakHours}
              />
              <TrendChart labels={labels} floorHours={floorHours} />

              <View style={styles.doughnutRow}>
                <DoughnutChart
                  title="Time Distribution"
                  icon={<PieChart size={16} color={theme.text} />}
                  slices={[
                    {
                      label: "Work Time",
                      value: totalWorked,
                      color: "#0ea5e9",
                    },
                    {
                      label: "Break Time",
                      value: totalBreak,
                      color: "#f59e0b",
                    },
                  ]}
                  formatValue={(v) => formatTime(v)}
                />
                <DoughnutChart
                  title="Office vs Remote"
                  icon={<Building2 size={16} color={theme.text} />}
                  slices={[
                    { label: "Office", value: officeDays, color: "#0ea5e9" },
                    {
                      label: "Remote",
                      value: remoteDays,
                      color: theme.success,
                    },
                  ]}
                  formatValue={(v) => `${v} days`}
                />
              </View>
            </>
          )}

          {/* Daily Log */}
          <AnalyticsHistoryTable history={history} />
        </>
      )}

      {/* Themed export error dialog */}
      {dialog}
    </ScrollView>
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View style={styles.statCard}>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}
