import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import {
  Building2,
  Calendar,
  CheckCircle2,
  ClipboardList,
  Clock,
  Coffee,
  House,
  Users,
} from "lucide-react-native";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import { uploadUrl } from "../../src/config";
import { formatTime } from "../../src/utils/time";
import { getLeaveType } from "../../src/constants/leaves";
import {
  getMemberOverview,
  type Approval,
  type MemberOverview,
} from "../../src/features";

type Tab = "overview" | "leaves" | "requests";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "leaves", label: "Leaves" },
  { id: "requests", label: "Requests" },
];

const ROLE_LABELS: Record<string, string> = {
  employee: "Employee",
  team_lead: "Team Lead",
  manager: "Manager",
  hr_admin: "HR Admin",
  super_admin: "Super Admin",
  platform_admin: "Platform Admin",
};

function roleLabel(role?: string) {
  if (!role) return "";
  return ROLE_LABELS[role] || role;
}

function initials(name?: string) {
  if (!name) return "?";
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "?";
}

function statusMeta(status?: string) {
  if (status === "approved")
    return { label: "Approved", color: "#4daa57", bg: "rgba(77,170,87,0.12)" };
  if (status === "rejected")
    return { label: "Rejected", color: "#e03e3e", bg: "rgba(224,62,62,0.12)" };
  if (status === "withdraw_pending" || status === "withdrawn")
    return { label: "Withdrawn", color: "#0ea5e9", bg: "rgba(14,165,233,0.12)" };
  return { label: "Pending", color: "#cb912f", bg: "rgba(203,145,47,0.12)" };
}

function typeLabel(t: string) {
  if (t === "manual_entry") return "Manual Entry";
  if (t === "leave") return "Leave";
  if (t === "leave_withdraw") return "Leave Withdraw";
  if (t === "overtime") return "Overtime";
  return t.replace(/_/g, " ");
}

/** Short human-readable summary line for a request (mirrors team.tsx). */
function requestDetail(a: Approval): string {
  const m = a.metadata || {};
  if (a.type === "leave") {
    return `${m.leave_type || "Leave"} • ${m.date || ""}${
      m.duration && m.duration !== "full" ? ` (${m.duration})` : ""
    }`.trim();
  }
  if (a.type === "leave_withdraw") {
    return `Withdraw ${m.leave_type || ""} • ${m.date || ""}`.trim();
  }
  if (a.type === "manual_entry") {
    return `${m.date || ""} • ${m.clock_in || ""}${
      m.clock_out ? ` → ${m.clock_out}` : ""
    }${m.work_mode ? ` (${m.work_mode})` : ""}`.trim();
  }
  if (a.type === "overtime") {
    return `${m.date || ""} • ${(m as any).hours ?? ""}h`.trim();
  }
  const start = m.start_date || m.dates?.[0];
  const end = m.end_date || (m.dates ? m.dates[m.dates.length - 1] : undefined);
  if (start && end) return start === end ? start : `${start} → ${end}`;
  return m.date || "—";
}

function formatLeaveDate(date: string): string {
  try {
    return new Date(date + "T00:00:00").toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  } catch {
    return date;
  }
}

export default function MemberDetailScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const [data, setData] = useState<MemberOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");

  const load = useCallback(async () => {
    if (!userId) return;
    try {
      const { data } = await getMemberOverview(userId);
      setData(data);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  const maxTrend = useMemo(() => {
    const vals = (data?.weeklyTrend || []).map((d) => d.floorMinutes || 0);
    return Math.max(480, 1, ...vals);
  }, [data]);

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Stack.Screen options={{ title: "Member" }} />
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  if (error || !data) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Stack.Screen options={{ title: "Member" }} />
        <Users size={40} color={theme.textMuted} />
        <Text style={styles.emptyText}>Failed to load member details</Text>
      </View>
    );
  }

  const { user, stats30d, monthTaskStats } = data;
  const avatar = uploadUrl(user.avatar);

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: user.full_name || "Member" }} />
      <ScrollView
        contentContainerStyle={styles.list}
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
        {/* Profile header */}
        <View style={styles.profileCard}>
          <View style={styles.avatar}>
            {avatar ? (
              <Image source={{ uri: avatar }} style={styles.avatarImg} />
            ) : (
              <Text style={styles.avatarText}>{initials(user.full_name)}</Text>
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.profileName} numberOfLines={1}>
              {user.full_name}
            </Text>
            <View style={styles.roleBadge}>
              <Text style={styles.roleBadgeText}>{roleLabel(user.role)}</Text>
            </View>
            {user.email ? (
              <Text style={styles.profileMeta} numberOfLines={1}>
                {user.email}
              </Text>
            ) : null}
            {(user.department_name || user.team_name) && (
              <Text style={styles.profileMeta} numberOfLines={1}>
                {[user.department_name, user.team_name].filter(Boolean).join(" · ")}
              </Text>
            )}
          </View>
        </View>

        {/* Tab switcher */}
        <View style={styles.tabRow}>
          {TABS.map((t) => (
            <Pressable
              key={t.id}
              style={[styles.tabBtn, tab === t.id && styles.tabBtnActive]}
              onPress={() => setTab(t.id)}
            >
              <Text
                style={[styles.tabText, tab === t.id && styles.tabTextActive]}
              >
                {t.label}
              </Text>
            </Pressable>
          ))}
        </View>

        {tab === "overview" && (
          <>
            {/* Quick stats */}
            <View style={styles.statsGrid}>
              <QuickStat
                theme={theme}
                icon={<Clock size={18} color={theme.primary} />}
                value={`${data.todayHours}h`}
                label="Today's Hours"
              />
              <QuickStat
                theme={theme}
                icon={<Coffee size={18} color={theme.primary} />}
                value={formatTime(data.todayBreakMin || 0)}
                label="Today's Break"
              />
              <QuickStat
                theme={theme}
                icon={<ClipboardList size={18} color={theme.warning} />}
                value={String(data.pendingRequests)}
                label="Pending Requests"
                valueColor={theme.warning}
              />
              <QuickStat
                theme={theme}
                icon={<Calendar size={18} color={theme.primary} />}
                value={String(data.monthLeaves)}
                label="Leaves This Month"
              />
              <QuickStat
                theme={theme}
                icon={<ClipboardList size={18} color={theme.primary} />}
                value={String(data.todayTasks?.length || 0)}
                label="Today's Planner"
              />
            </View>

            {/* Weekly trend */}
            {data.weeklyTrend && data.weeklyTrend.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Weekly Trend (Last 7 Days)</Text>
                <View style={styles.trendRow}>
                  {data.weeklyTrend.map((day, i) => {
                    const barH = Math.round(
                      ((day.floorMinutes || 0) / maxTrend) * 90,
                    );
                    const color =
                      day.floorMinutes >= 480
                        ? theme.success
                        : day.floorMinutes > 0
                          ? theme.warning
                          : theme.glassBorder;
                    return (
                      <View key={i} style={styles.trendCol}>
                        <View style={styles.trendBarTrack}>
                          <View
                            style={[
                              styles.trendBar,
                              { height: Math.max(barH, 2), backgroundColor: color },
                            ]}
                          />
                        </View>
                        <Text style={styles.trendDay}>{day.dayLabel}</Text>
                        <Text style={styles.trendHours}>
                          {formatTime(day.floorMinutes)}
                        </Text>
                        {day.workMode ? (
                          day.workMode === "remote" ? (
                            <House size={11} color={theme.textMuted} />
                          ) : (
                            <Building2 size={11} color={theme.textMuted} />
                          )
                        ) : null}
                      </View>
                    );
                  })}
                </View>
              </View>
            )}

            {/* 30-day performance */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>30-Day Performance</Text>
              <View style={styles.perfGrid}>
                <PerfItem theme={theme} value={String(stats30d.daysWorked)} label="Days Worked" />
                <PerfItem theme={theme} value={formatTime(stats30d.totalFloorMinutes)} label="Total Work" />
                <PerfItem theme={theme} value={formatTime(stats30d.avgFloorMinutes)} label="Avg Work/Day" />
                <PerfItem theme={theme} value={formatTime(stats30d.avgBreakMinutes)} label="Avg Break/Day" />
                <PerfItem theme={theme} value={`${stats30d.targetMetPercent}%`} label="Target Met" />
                <PerfItem theme={theme} value={`${stats30d.punctualityPercent}%`} label="Punctuality" />
              </View>
            </View>

            {/* Planner this month */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Planner This Month</Text>
              <View style={styles.perfGrid}>
                <PerfItem theme={theme} value={String(monthTaskStats.total)} label="Total" />
                <PerfItem theme={theme} value={String(monthTaskStats.done)} label="Done" valueColor={theme.success} />
                <PerfItem theme={theme} value={String(monthTaskStats.inProgress)} label="In Progress" valueColor={theme.warning} />
                <PerfItem theme={theme} value={`${monthTaskStats.completionRate}%`} label="Completion" />
              </View>
            </View>

            {/* Today's planner */}
            {data.todayTasks && data.todayTasks.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Today's Planner</Text>
                <View style={{ gap: 8 }}>
                  {data.todayTasks.map((t) => (
                    <View key={t.id} style={styles.taskRow}>
                      {t.status === "done" ? (
                        <CheckCircle2 size={16} color={theme.success} />
                      ) : (
                        <Clock size={16} color={theme.textSecondary} />
                      )}
                      <Text style={styles.taskTitle} numberOfLines={1}>
                        {t.title}
                      </Text>
                      <Text style={styles.taskPriority}>{t.priority}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}
          </>
        )}

        {tab === "leaves" && (
          <>
            {/* Leave balances */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Leave Balances</Text>
              {data.leaveBalances.length === 0 ? (
                <Text style={styles.mutedText}>No leave balances</Text>
              ) : (
                <View style={{ gap: 12 }}>
                  {data.leaveBalances.map((lb, i) => {
                    const type = getLeaveType(lb.leave_type);
                    const total = lb.total_days || 0;
                    const used = lb.used || 0;
                    const pct = total > 0 ? Math.round((used / total) * 100) : 0;
                    const barColor =
                      pct >= 90 ? theme.danger : pct >= 60 ? theme.warning : theme.success;
                    return (
                      <View key={i} style={styles.balanceRow}>
                        <View style={styles.balanceHead}>
                          <View style={styles.balanceNameWrap}>
                            <type.Icon size={14} color={type.color} />
                            <Text style={styles.balanceName}>
                              {lb.policy_name || type.label}
                            </Text>
                          </View>
                          <Text style={styles.balanceCount}>
                            {lb.remaining} left · {used}/{total} used
                          </Text>
                        </View>
                        <View style={styles.balanceTrack}>
                          <View
                            style={[
                              styles.balanceFill,
                              { width: `${Math.min(pct, 100)}%`, backgroundColor: barColor },
                            ]}
                          />
                        </View>
                      </View>
                    );
                  })}
                </View>
              )}
            </View>

            {/* Recent leaves */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Recent Leaves</Text>
              {data.recentLeaves.length === 0 ? (
                <Text style={styles.mutedText}>No recent leaves</Text>
              ) : (
                <View style={{ gap: 10 }}>
                  {data.recentLeaves.map((l) => {
                    const sm = statusMeta(l.status);
                    const type = getLeaveType(l.leave_type);
                    return (
                      <View key={l.id} style={styles.itemRow}>
                        <View style={{ flex: 1 }}>
                          <View style={styles.itemTitleWrap}>
                            <type.Icon size={13} color={type.color} />
                            <Text style={styles.itemTitle}>{type.label}</Text>
                          </View>
                          <Text style={styles.itemSub}>
                            {formatLeaveDate(l.date)}
                            {l.reason ? ` · ${l.reason}` : ""}
                          </Text>
                        </View>
                        <View style={[styles.badge, { backgroundColor: sm.bg }]}>
                          <Text style={[styles.badgeText, { color: sm.color }]}>
                            {sm.label}
                          </Text>
                        </View>
                      </View>
                    );
                  })}
                </View>
              )}
            </View>
          </>
        )}

        {tab === "requests" && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Recent Requests</Text>
            {data.recentRequests.length === 0 ? (
              <Text style={styles.mutedText}>No recent requests</Text>
            ) : (
              <View style={{ gap: 10 }}>
                {data.recentRequests.map((r) => {
                  const sm = statusMeta(r.status);
                  return (
                    <View key={r.id} style={styles.itemRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.itemTitle}>{typeLabel(r.type)}</Text>
                        <Text style={styles.itemSub}>
                          {requestDetail(r)}
                          {r.created_at
                            ? ` · ${new Date(r.created_at).toLocaleDateString()}`
                            : ""}
                        </Text>
                      </View>
                      <View style={[styles.badge, { backgroundColor: sm.bg }]}>
                        <Text style={[styles.badgeText, { color: sm.color }]}>
                          {sm.label}
                        </Text>
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function QuickStat({
  theme,
  icon,
  value,
  label,
  valueColor,
}: {
  theme: Theme;
  icon: React.ReactNode;
  value: string;
  label: string;
  valueColor?: string;
}) {
  const styles = makeStyles(theme);
  return (
    <View style={styles.quickStat}>
      <View style={styles.quickStatIcon}>{icon}</View>
      <Text style={[styles.quickStatValue, valueColor ? { color: valueColor } : null]}>
        {value}
      </Text>
      <Text style={styles.quickStatLabel}>{label}</Text>
    </View>
  );
}

function PerfItem({
  theme,
  value,
  label,
  valueColor,
}: {
  theme: Theme;
  value: string;
  label: string;
  valueColor?: string;
}) {
  const styles = makeStyles(theme);
  return (
    <View style={styles.perfItem}>
      <Text style={[styles.perfValue, valueColor ? { color: valueColor } : null]}>
        {value}
      </Text>
      <Text style={styles.perfLabel}>{label}</Text>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.bg },
    center: { alignItems: "center", justifyContent: "center", gap: 12 },
    list: { padding: 16, gap: 16, paddingBottom: 40 },
    emptyText: { color: theme.textMuted, fontSize: 14 },

    // profile
    profileCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radius,
      padding: 16,
    },
    avatar: {
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: theme.primary,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarImg: { width: 56, height: 56, borderRadius: 28 },
    avatarText: { color: "#fff", fontSize: 20, fontWeight: "700" },
    profileName: { fontSize: 18, fontWeight: "700", color: theme.text },
    roleBadge: {
      alignSelf: "flex-start",
      backgroundColor: theme.surface,
      borderRadius: theme.radiusSm,
      paddingHorizontal: 8,
      paddingVertical: 3,
      marginTop: 4,
    },
    roleBadgeText: {
      fontSize: 11,
      fontWeight: "600",
      color: theme.textSecondary,
      textTransform: "capitalize",
    },
    profileMeta: { fontSize: 13, color: theme.textSecondary, marginTop: 3 },

    // tabs
    tabRow: {
      flexDirection: "row",
      backgroundColor: theme.surface,
      borderRadius: theme.radiusSm,
      padding: 3,
      gap: 3,
    },
    tabBtn: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 9,
      borderRadius: 5,
    },
    tabBtnActive: { backgroundColor: theme.primary },
    tabText: { fontSize: 13, color: theme.textSecondary, fontWeight: "600" },
    tabTextActive: { color: "#fff" },

    // quick stats
    statsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
    quickStat: {
      flexGrow: 1,
      flexBasis: "30%",
      minWidth: 100,
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radius,
      padding: 12,
      alignItems: "center",
      gap: 4,
    },
    quickStatIcon: { marginBottom: 2 },
    quickStatValue: { fontSize: 18, fontWeight: "800", color: theme.text },
    quickStatLabel: {
      fontSize: 10,
      color: theme.textMuted,
      textTransform: "uppercase",
      letterSpacing: 0.3,
      textAlign: "center",
    },

    // section
    section: {
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radius,
      padding: 16,
      gap: 12,
    },
    sectionTitle: { fontSize: 15, fontWeight: "700", color: theme.text },
    mutedText: { fontSize: 13, color: theme.textMuted },

    // weekly trend
    trendRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "flex-end",
    },
    trendCol: { flex: 1, alignItems: "center", gap: 4 },
    trendBarTrack: {
      height: 92,
      justifyContent: "flex-end",
      alignItems: "center",
      width: "100%",
    },
    trendBar: { width: 14, borderRadius: 4 },
    trendDay: { fontSize: 10, color: theme.textSecondary },
    trendHours: { fontSize: 9, color: theme.textMuted },

    // perf grid
    perfGrid: { flexDirection: "row", flexWrap: "wrap" },
    perfItem: { width: "33.33%", paddingVertical: 8, gap: 2 },
    perfValue: { fontSize: 17, fontWeight: "800", color: theme.text },
    perfLabel: { fontSize: 11, color: theme.textMuted },

    // tasks
    taskRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    taskTitle: { flex: 1, fontSize: 13, color: theme.text },
    taskPriority: {
      fontSize: 11,
      color: theme.textSecondary,
      textTransform: "capitalize",
    },

    // leave balances
    balanceRow: { gap: 6 },
    balanceHead: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
    },
    balanceNameWrap: { flexDirection: "row", alignItems: "center", gap: 6 },
    balanceName: {
      fontSize: 13,
      fontWeight: "600",
      color: theme.text,
      textTransform: "capitalize",
    },
    balanceCount: { fontSize: 12, color: theme.textSecondary },
    balanceTrack: {
      height: 6,
      borderRadius: 3,
      backgroundColor: theme.surface,
      overflow: "hidden",
    },
    balanceFill: { height: "100%", borderRadius: 3 },

    // list items (leaves / requests)
    itemRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10,
    },
    itemTitleWrap: { flexDirection: "row", alignItems: "center", gap: 6 },
    itemTitle: {
      fontSize: 14,
      fontWeight: "600",
      color: theme.text,
      textTransform: "capitalize",
    },
    itemSub: { fontSize: 12, color: theme.textSecondary, marginTop: 2 },

    badge: {
      borderRadius: theme.radiusSm,
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    badgeText: { fontSize: 11, fontWeight: "700" },
  });