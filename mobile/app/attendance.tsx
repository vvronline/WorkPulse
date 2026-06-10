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
import { Stack, useLocalSearchParams } from "expo-router";
import {
  BarChart3,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  FileEdit,
  Palmtree,
} from "lucide-react-native";
import { theme } from "../src/theme";
import { formatTime } from "../src/utils/time";
import LeavesTab from "../src/components/LeavesTab";
import {
  addManualEntry,
  getTrackerAnalytics,
  getTrackerHistory,
  type AnalyticsPoint,
  type HistoryEntry,
} from "../src/features";

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

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

type Tab = "overview" | "leaves" | "manual" | "analytics";

const VALID_TABS: Tab[] = ["overview", "leaves", "manual", "analytics"];

export default function AttendanceScreen() {
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
  return (
    <Pressable
      style={[styles.tabBtn, active && styles.tabBtnActive]}
      onPress={onPress}
    >
      <Icon size={15} color={active ? "#fff" : theme.textSecondary} />
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
    </Pressable>
  );
}

/* ───────────────────────── Overview (calendar + history) ───────────────────────── */
function OverviewTab() {
  const [cursor, setCursor] = useState(new Date());
  const [selected, setSelected] = useState(ymd(new Date()));
  const [entries, setEntries] = useState<Record<string, HistoryEntry>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const monthDays = useMemo(() => buildMonthGrid(cursor), [cursor]);
  const todayKey = ymd(new Date());

  const load = useCallback(async () => {
    const grid = buildMonthGrid(new Date(cursor.getFullYear(), cursor.getMonth(), 1));
    const from = ymd(grid[0]);
    const to = ymd(grid[41]);
    try {
      const { data } = await getTrackerHistory(from, to);
      const map: Record<string, HistoryEntry> = {};
      (data || []).forEach((e) => {
        const k = e.date.slice(0, 10);
        map[k] = e;
      });
      setEntries(map);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [cursor]);

  useEffect(() => {
    load();
  }, [load]);

  const sel = entries[selected];

  return (
    <ScrollView
      contentContainerStyle={styles.body}
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
    >
      <View style={styles.monthHeader}>
        <Text style={styles.monthLabel}>
          {cursor.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
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
          const entry = entries[key];
          const worked = entry?.floorMinutes ?? 0;
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
                {worked > 0 ? (
                  <View
                    style={[
                      styles.workDot,
                      {
                        backgroundColor:
                          worked >= 420
                            ? theme.success
                            : worked >= 240
                              ? theme.warning
                              : theme.danger,
                      },
                    ]}
                  />
                ) : (
                  <View style={styles.workDotSpacer} />
                )}
              </View>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.detailHeader}>
        <Text style={styles.detailTitle}>
          {new Date(selected).toLocaleDateString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
          })}
        </Text>
        {loading ? <ActivityIndicator color={theme.primary} size="small" /> : null}
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
      ) : (
        <Text style={styles.emptyDetail}>No attendance recorded for this day.</Text>
      )}
    </ScrollView>
  );
}

function fmtTime(iso: string) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

/* ───────────────────────── Manual entry ───────────────────────── */
const WORK_MODES: ("office" | "remote" | "hybrid")[] = ["office", "remote", "hybrid"];

function ManualTab() {
  const [date, setDate] = useState(ymd(new Date()));
  const [clockIn, setClockIn] = useState("09:00");
  const [clockOut, setClockOut] = useState("18:00");
  const [breakStart, setBreakStart] = useState("13:00");
  const [breakEnd, setBreakEnd] = useState("13:30");
  const [workMode, setWorkMode] = useState<"office" | "remote" | "hybrid">("office");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      Alert.alert("Invalid date", "Use the format YYYY-MM-DD.");
      return;
    }
    if (!/^\d{2}:\d{2}$/.test(clockIn) || !/^\d{2}:\d{2}$/.test(clockOut)) {
      Alert.alert("Invalid time", "Use the format HH:mm.");
      return;
    }
    setBusy(true);
    try {
      const breaks =
        /^\d{2}:\d{2}$/.test(breakStart) && /^\d{2}:\d{2}$/.test(breakEnd)
          ? [{ start: breakStart, end: breakEnd }]
          : [];
      await addManualEntry({
        date,
        clock_in: clockIn,
        clock_out: clockOut,
        breaks,
        timezoneOffset: new Date().getTimezoneOffset(),
        work_mode: workMode,
      });
      Alert.alert(
        "Submitted",
        "Your manual entry has been submitted. It may require approval.",
      );
    } catch (e: any) {
      Alert.alert(
        "Error",
        e?.response?.data?.error || "Failed to submit manual entry",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
      <Text style={styles.hint}>
        Submit a missed attendance entry. If you report to a manager it will be
        sent for approval.
      </Text>

      <Text style={styles.label}>Date</Text>
      <TextInput
        style={styles.input}
        value={date}
        onChangeText={setDate}
        placeholder="YYYY-MM-DD"
        placeholderTextColor={theme.textMuted}
      />

      <View style={styles.timeRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>Clock In</Text>
          <TextInput
            style={styles.input}
            value={clockIn}
            onChangeText={setClockIn}
            placeholder="HH:mm"
            placeholderTextColor={theme.textMuted}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>Clock Out</Text>
          <TextInput
            style={styles.input}
            value={clockOut}
            onChangeText={setClockOut}
            placeholder="HH:mm"
            placeholderTextColor={theme.textMuted}
          />
        </View>
      </View>

      <View style={styles.timeRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>Break Start</Text>
          <TextInput
            style={styles.input}
            value={breakStart}
            onChangeText={setBreakStart}
            placeholder="HH:mm"
            placeholderTextColor={theme.textMuted}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.label}>Break End</Text>
          <TextInput
            style={styles.input}
            value={breakEnd}
            onChangeText={setBreakEnd}
            placeholder="HH:mm"
            placeholderTextColor={theme.textMuted}
          />
        </View>
      </View>

      <Text style={styles.label}>Work Mode</Text>
      <View style={styles.modeRow}>
        {WORK_MODES.map((m) => (
          <Pressable
            key={m}
            style={[styles.modeChip, workMode === m && styles.modeChipActive]}
            onPress={() => setWorkMode(m)}
          >
            <Text
              style={[styles.modeText, workMode === m && styles.modeTextActive]}
            >
              {m[0].toUpperCase() + m.slice(1)}
            </Text>
          </Pressable>
        ))}
      </View>

      <Pressable
        style={[styles.submit, busy && styles.submitDisabled]}
        onPress={submit}
        disabled={busy}
      >
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.submitText}>Submit Entry</Text>
        )}
      </Pressable>
    </ScrollView>
  );
}

/* ───────────────────────── Analytics ───────────────────────── */
const RANGES: { value: number; label: string }[] = [
  { value: 7, label: "7d" },
  { value: 14, label: "14d" },
  { value: 30, label: "30d" },
];

function AnalyticsTab() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<AnalyticsPoint[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getTrackerAnalytics(days);
      setData(res.data || []);
    } catch {
      setData([]);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    load();
  }, [load]);

  const totalWorked = data.reduce((s, d) => s + (d.floorMinutes || 0), 0);
  const totalBreak = data.reduce((s, d) => s + (d.breakMinutes || 0), 0);
  const workedDays = data.filter((d) => (d.floorMinutes || 0) > 0).length;
  const avg = workedDays > 0 ? totalWorked / workedDays : 0;
  const maxVal = Math.max(1, ...data.map((d) => d.floorMinutes || 0));

  return (
    <ScrollView contentContainerStyle={styles.body}>
      <View style={styles.rangeRow}>
        {RANGES.map((r) => (
          <Pressable
            key={r.value}
            style={[styles.rangeChip, days === r.value && styles.rangeChipActive]}
            onPress={() => setDays(r.value)}
          >
            <Text
              style={[
                styles.rangeText,
                days === r.value && styles.rangeTextActive,
              ]}
            >
              {r.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.statsRow}>
        <StatCard label="Total" value={formatTime(totalWorked)} color={theme.primary} />
        <StatCard label="Avg/Day" value={formatTime(avg)} color={theme.success} />
        <StatCard label="Break" value={formatTime(totalBreak)} color={theme.warning} />
      </View>

      {loading ? (
        <ActivityIndicator color={theme.primary} style={{ marginTop: 24 }} />
      ) : data.length === 0 ? (
        <Text style={styles.emptyDetail}>No data for this period.</Text>
      ) : (
        <View style={styles.chartCard}>
          {data.map((d) => {
            const pct = ((d.floorMinutes || 0) / maxVal) * 100;
            const dt = new Date(d.date);
            return (
              <View key={d.date} style={styles.chartRow}>
                <Text style={styles.chartDate}>
                  {dt.toLocaleDateString("en-US", {
                    weekday: "short",
                    day: "numeric",
                  })}
                </Text>
                <View style={styles.chartBarTrack}>
                  <View style={[styles.chartBarFill, { width: `${pct}%` }]} />
                </View>
                <Text style={styles.chartValue}>
                  {formatTime(d.floorMinutes || 0)}
                </Text>
              </View>
            );
          })}
        </View>
      )}
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
  return (
    <View style={styles.statCard}>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  body: { padding: 16, paddingBottom: 40, gap: 6 },
  tabRow: {
    flexDirection: "row",
    backgroundColor: theme.surface,
    borderRadius: theme.radiusSm,
    padding: 3,
    gap: 3,
    margin: 16,
    marginBottom: 0,
  },
  tabBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 9,
    paddingHorizontal: 2,
    borderRadius: 5,
  },
  tabBtnActive: { backgroundColor: theme.primary },
  tabText: { fontSize: 12, color: theme.textSecondary, fontWeight: "600" },
  tabTextActive: { color: "#fff" },
  // calendar
  monthHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  monthLabel: {
    fontSize: 18,
    fontWeight: "800",
    color: theme.text,
    letterSpacing: -0.5,
  },
  monthNav: { flexDirection: "row", alignItems: "center", gap: 6 },
  navBtn: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    alignItems: "center",
    justifyContent: "center",
  },
  todayBtn: {
    paddingHorizontal: 12,
    height: 34,
    borderRadius: 8,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    alignItems: "center",
    justifyContent: "center",
  },
  todayText: { color: theme.textSecondary, fontSize: 13, fontWeight: "600" },
  weekRow: { flexDirection: "row", marginBottom: 4 },
  weekday: {
    flex: 1,
    textAlign: "center",
    fontSize: 11,
    fontWeight: "700",
    color: theme.textMuted,
  },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: { width: `${100 / 7}%`, aspectRatio: 1, padding: 2 },
  cellInner: {
    flex: 1,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
  },
  cellSelected: { backgroundColor: theme.primary },
  cellToday: { backgroundColor: theme.primaryGlow },
  cellNum: { fontSize: 14, color: theme.text, fontWeight: "500" },
  cellNumMuted: { color: theme.textMuted, opacity: 0.5 },
  cellNumActive: { fontWeight: "700" },
  workDot: { width: 6, height: 6, borderRadius: 3 },
  workDotSpacer: { height: 6 },
  detailHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 16,
    marginBottom: 8,
  },
  detailTitle: { fontSize: 15, fontWeight: "700", color: theme.text },
  detailCard: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusLg,
    paddingHorizontal: 16,
  },
  divider: { height: 1, backgroundColor: theme.border },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 13,
  },
  rowLabel: { color: theme.textSecondary, fontSize: 14 },
  rowValue: {
    color: theme.text,
    fontWeight: "600",
    fontSize: 14,
    textTransform: "capitalize",
  },
  emptyDetail: {
    color: theme.textMuted,
    fontSize: 13,
    paddingVertical: 16,
    textAlign: "center",
  },
  // manual
  hint: { color: theme.textMuted, fontSize: 13, marginBottom: 6 },
  label: {
    fontSize: 11,
    fontWeight: "600",
    color: theme.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 10,
    marginBottom: 4,
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
  timeRow: { flexDirection: "row", gap: 12 },
  modeRow: { flexDirection: "row", gap: 8 },
  modeChip: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 10,
    borderRadius: theme.radiusSm,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
  },
  modeChipActive: { backgroundColor: theme.primary, borderColor: theme.primary },
  modeText: { fontSize: 13, color: theme.textSecondary, fontWeight: "600" },
  modeTextActive: { color: "#fff" },
  submit: {
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 20,
  },
  submitDisabled: { opacity: 0.5 },
  submitText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  // analytics
  rangeRow: { flexDirection: "row", gap: 8, marginBottom: 6 },
  rangeChip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: theme.radiusFull,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
  },
  rangeChipActive: { backgroundColor: theme.primary, borderColor: theme.primary },
  rangeText: { fontSize: 13, color: theme.textSecondary, fontWeight: "600" },
  rangeTextActive: { color: "#fff" },
  statsRow: { flexDirection: "row", gap: 10, marginVertical: 8 },
  statCard: {
    flex: 1,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radius,
    paddingVertical: 14,
    alignItems: "center",
    gap: 3,
  },
  statValue: { fontSize: 17, fontWeight: "800" },
  statLabel: {
    fontSize: 10,
    color: theme.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  chartCard: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusLg,
    padding: 14,
    gap: 10,
  },
  chartRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  chartDate: { width: 54, fontSize: 11, color: theme.textSecondary },
  chartBarTrack: {
    flex: 1,
    height: 10,
    borderRadius: 5,
    backgroundColor: theme.surface,
    overflow: "hidden",
  },
  chartBarFill: { height: "100%", borderRadius: 5, backgroundColor: theme.primary },
  chartValue: {
    width: 56,
    fontSize: 11,
    color: theme.text,
    textAlign: "right",
    fontWeight: "600",
  },
});