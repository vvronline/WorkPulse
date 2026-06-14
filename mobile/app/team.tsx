import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack } from "expo-router";
import {
  Building2,
  CheckCircle2,
  ClipboardList,
  Clock,
  FileEdit,
  House,
  RotateCcw,
  Target,
  Timer,
  Users,
  XCircle,
} from "lucide-react-native";
import type { Theme } from "../src/theme";
import { useTheme } from "../src/theme/ThemeProvider";
import { useDialog } from "../src/hooks/useDialog";
import { PromptModal } from "../src/components/PromptModal";
import { uploadUrl } from "../src/config";
import { formatTime } from "../src/utils/time";
import {
  approveRequest,
  getApprovals,
  getMyRequests,
  getTeamAnalytics,
  getTeamAttendance,
  rejectRequest,
  type Approval,
  type TeamAnalytics,
  type TeamMember,
} from "../src/features";

type Tab = "attendance" | "approvals" | "analytics" | "requests";

const TABS: { id: Tab; label: string }[] = [
  { id: "attendance", label: "Attendance" },
  { id: "approvals", label: "Approvals" },
  { id: "analytics", label: "Analytics" },
  { id: "requests", label: "My Requests" },
];

const ROLE_LABELS: Record<string, string> = {
  employee: "Employee",
  team_lead: "Team Lead",
  manager: "Manager",
  hr_admin: "HR Admin",
  super_admin: "Super Admin",
  platform_admin: "Platform Admin",
};

const STATUS_META: Record<
  TeamMember["status"],
  { label: string; sectionLabel: string; color: string; bg: string }
> = {
  working: {
    label: "Working",
    sectionLabel: "🟢 Working",
    color: "#4daa57",
    bg: "rgba(77,170,87,0.12)",
  },
  away: {
    label: "Away",
    sectionLabel: "🟡 Away",
    color: "#cb912f",
    bg: "rgba(203,145,47,0.12)",
  },
  not_started: {
    label: "Not Started",
    sectionLabel: "⚪ Not Started",
    color: "#94a3b8",
    bg: "rgba(148,163,184,0.12)",
  },
  on_leave: {
    label: "On Leave",
    sectionLabel: "🔴 On Leave",
    color: "#0ea5e9",
    bg: "rgba(14,165,233,0.12)",
  },
};

const STATUS_ORDER: TeamMember["status"][] = [
  "working",
  "away",
  "not_started",
  "on_leave",
];

function roleLabel(role?: string) {
  if (!role) return "";
  return ROLE_LABELS[role] || role;
}

function initials(name?: string) {
  if (!name) return "?";
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "?";
}

function statusConfig(status?: string) {
  if (status === "approved")
    return { label: "Approved", color: "#4daa57", bg: "rgba(77,170,87,0.12)" };
  if (status === "rejected")
    return { label: "Rejected", color: "#e03e3e", bg: "rgba(224,62,62,0.12)" };
  return { label: "Pending", color: "#cb912f", bg: "rgba(203,145,47,0.12)" };
}

function typeLabel(t: string) {
  if (t === "manual_entry") return "Manual Entry";
  if (t === "leave") return "Leave";
  if (t === "leave_withdraw") return "Leave Withdraw";
  if (t === "overtime") return "Overtime";
  return t.replace(/_/g, " ");
}

/** Mirrors the web RequestDetails — a short human-readable summary line. */
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

function DetailIcon({ type, color }: { type: string; color: string }) {
  if (type === "leave_withdraw") return <RotateCcw size={13} color={color} />;
  if (type === "manual_entry") return <FileEdit size={13} color={color} />;
  if (type === "overtime") return <Clock size={13} color={color} />;
  return <ClipboardList size={13} color={color} />;
}

export default function TeamScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [tab, setTab] = useState<Tab>("attendance");

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "My Team" }} />
      <View style={styles.tabRow}>
        {TABS.map((t) => (
          <Pressable
            key={t.id}
            style={[styles.tabBtn, tab === t.id && styles.tabBtnActive]}
            onPress={() => setTab(t.id)}
          >
            <Text
              style={[styles.tabText, tab === t.id && styles.tabTextActive]}
              numberOfLines={1}
            >
              {t.label}
            </Text>
          </Pressable>
        ))}
      </View>
      {tab === "attendance" ? (
        <AttendanceTab />
      ) : tab === "approvals" ? (
        <ApprovalsTab />
      ) : tab === "analytics" ? (
        <AnalyticsTab />
      ) : (
        <MyRequestsTab />
      )}
    </View>
  );
}

/* ───────────────────────── Attendance tab ───────────────────────── */

function AttendanceTab() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await getTeamAttendance();
      setMembers(Array.isArray(data) ? data : []);
    } catch {
      setMembers([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const groups = useMemo(() => {
    const g: Record<TeamMember["status"], TeamMember[]> = {
      working: [],
      away: [],
      not_started: [],
      on_leave: [],
    };
    members.forEach((m) => {
      (g[m.status] || g.not_started).push(m);
    });
    return g;
  }, [members]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  return (
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
      {/* Stats grid */}
      <View style={styles.statsGrid}>
        <View style={styles.statCard}>
          <Text style={[styles.statValue, { color: STATUS_META.working.color }]}>
            {groups.working.length}
          </Text>
          <Text style={styles.statLabel}>Working</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={[styles.statValue, { color: STATUS_META.away.color }]}>
            {groups.away.length}
          </Text>
          <Text style={styles.statLabel}>Away</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={styles.statValue}>{groups.not_started.length}</Text>
          <Text style={styles.statLabel}>Not Started</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={[styles.statValue, { color: STATUS_META.on_leave.color }]}>
            {groups.on_leave.length}
          </Text>
          <Text style={styles.statLabel}>On Leave</Text>
        </View>
      </View>

      {members.length === 0 ? (
        <View style={styles.empty}>
          <Users size={40} color={theme.textMuted} />
          <Text style={styles.emptyText}>No team members</Text>
        </View>
      ) : (
        STATUS_ORDER.map((status) => {
          const list = groups[status];
          if (!list.length) return null;
          const meta = STATUS_META[status];
          return (
            <View key={status} style={styles.groupSection}>
              <Text style={styles.groupTitle}>{meta.sectionLabel}</Text>
              <View style={{ gap: 10 }}>
                {list.map((item) => (
                  <MemberRow key={item.id} item={item} />
                ))}
              </View>
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

function MemberRow({ item }: { item: TeamMember }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const meta = STATUS_META[item.status] || STATUS_META.not_started;
  const avatar = uploadUrl(item.avatar);
  const hours =
    item.hours_today != null
      ? `${item.hours_today}h`
      : item.floorMinutes
        ? formatTime(item.floorMinutes)
        : null;
  return (
    <View style={styles.memberCard}>
      <View style={styles.avatar}>
        {avatar ? (
          <Image source={{ uri: avatar }} style={styles.avatarImg} />
        ) : (
          <Text style={styles.avatarText}>{initials(item.full_name)}</Text>
        )}
      </View>
      <View style={styles.memberBody}>
        <Text style={styles.memberName} numberOfLines={1}>
          {item.full_name}
        </Text>
        <Text style={styles.memberRole}>{roleLabel(item.role)}</Text>
        <View style={styles.memberMetaRow}>
          {hours ? (
            <View style={styles.metaItem}>
              <Clock size={12} color={theme.textSecondary} />
              <Text style={styles.memberMeta}>{hours}</Text>
            </View>
          ) : null}
          {item.workMode ? (
            <View style={styles.metaItem}>
              {item.workMode === "remote" ? (
                <House size={12} color={theme.textSecondary} />
              ) : (
                <Building2 size={12} color={theme.textSecondary} />
              )}
              <Text style={styles.memberMeta}>{item.workMode}</Text>
            </View>
          ) : null}
          {item.leave_type ? (
            <Text style={styles.memberMeta}>{item.leave_type}</Text>
          ) : null}
        </View>
        {item.current_task ? (
          <Text style={styles.taskHighlight} numberOfLines={1}>
            • {item.current_task}
          </Text>
        ) : null}
      </View>
      <View style={[styles.badge, { backgroundColor: meta.bg }]}>
        <Text style={[styles.badgeText, { color: meta.color }]}>{meta.label}</Text>
      </View>
    </View>
  );
}

/* ───────────────────────── Approvals tab ───────────────────────── */

const APPROVAL_FILTERS: { value: string; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "", label: "All" },
];

function ApprovalsTab() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { alert, dialog } = useDialog();
  const [items, setItems] = useState<Approval[]>([]);
  const [filter, setFilter] = useState("pending");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [rejectId, setRejectId] = useState<number | null>(null);
  const [rejecting, setRejecting] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await getApprovals(
        filter ? { status: filter } : undefined,
      );
      setItems(data || []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [filter]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  async function approve(item: Approval) {
    setBusyId(item.id);
    try {
      await approveRequest(item.id);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
    } catch (e: any) {
      alert("Error", e?.response?.data?.error || "Action failed");
    } finally {
      setBusyId(null);
    }
  }

  async function submitReject(values: Record<string, string>) {
    if (rejectId == null) return;
    setRejecting(true);
    try {
      await rejectRequest(rejectId, values.reason?.trim() || undefined);
      const id = rejectId;
      setRejectId(null);
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch (e: any) {
      alert("Error", e?.response?.data?.error || "Failed to reject");
    } finally {
      setRejecting(false);
    }
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.filterRow}>
        {APPROVAL_FILTERS.map((f) => (
          <Pressable
            key={f.value || "all"}
            style={[styles.filterChip, filter === f.value && styles.filterChipActive]}
            onPress={() => setFilter(f.value)}
          >
            <Text
              style={[
                styles.filterChipText,
                filter === f.value && styles.filterChipTextActive,
              ]}
            >
              {f.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <FlatList
        data={items}
        keyExtractor={(a) => String(a.id)}
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
        renderItem={({ item }) => {
          const name = item.requester_name || "User";
          const st = statusConfig(item.status);
          const isPending = item.status === "pending";
          return (
            <View style={styles.approvalCard}>
              <View style={styles.approvalHeader}>
                <View style={styles.avatarSm}>
                  <Text style={styles.avatarTextSm}>{initials(name)}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.approvalName}>{name}</Text>
                  <Text style={styles.approvalType}>{typeLabel(item.type)}</Text>
                </View>
                <View style={[styles.badge, { backgroundColor: st.bg }]}>
                  <Text style={[styles.badgeText, { color: st.color }]}>
                    {st.label}
                  </Text>
                </View>
              </View>

              <View style={styles.detailRow}>
                <DetailIcon type={item.type} color={theme.textSecondary} />
                <Text style={styles.approvalDetail}>{requestDetail(item)}</Text>
              </View>
              {item.metadata?.reason ? (
                <Text style={styles.approvalReason}>"{item.metadata.reason}"</Text>
              ) : null}

              {isPending ? (
                <View style={styles.actionRow}>
                  <Pressable
                    style={[styles.actionBtn, styles.rejectBtn]}
                    onPress={() => setRejectId(item.id)}
                    disabled={busyId === item.id}
                  >
                    <XCircle size={16} color={theme.danger} />
                    <Text style={[styles.actionText, { color: theme.danger }]}>
                      Reject
                    </Text>
                  </Pressable>
                  <Pressable
                    style={[styles.actionBtn, styles.approveBtn]}
                    onPress={() => approve(item)}
                    disabled={busyId === item.id}
                  >
                    {busyId === item.id ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <>
                        <CheckCircle2 size={16} color="#fff" />
                        <Text style={[styles.actionText, { color: "#fff" }]}>
                          Approve
                        </Text>
                      </>
                    )}
                  </Pressable>
                </View>
              ) : item.reject_reason ? (
                <Text style={styles.rejectReasonNote}>
                  Reason: {item.reject_reason}
                </Text>
              ) : null}
            </View>
          );
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <CheckCircle2 size={40} color={theme.textMuted} />
            <Text style={styles.emptyText}>No {filter || ""} requests</Text>
          </View>
        }
      />

      <PromptModal
        visible={rejectId != null}
        title="Reject Request"
        message="Optionally provide a reason for the rejection."
        confirmLabel="Reject"
        destructive
        busy={rejecting}
        fields={[
          {
            key: "reason",
            label: "Reason (optional)",
            placeholder: "Provide a reason…",
            multiline: true,
          },
        ]}
        onCancel={() => setRejectId(null)}
        onSubmit={submitReject}
      />

      {dialog}
    </View>
  );
}

/* ───────────────────────── Analytics tab ───────────────────────── */

const RANGE_OPTIONS: { value: string; label: string }[] = [
  { value: "7", label: "This Week" },
  { value: "30", label: "This Month" },
  { value: "90", label: "This Quarter" },
];

function SummaryCard({
  icon,
  value,
  label,
  valueColor,
}: {
  icon: React.ReactNode;
  value: string;
  label: string;
  valueColor?: string;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View style={styles.summaryCard}>
      <View style={styles.summaryIcon}>{icon}</View>
      <Text style={[styles.summaryValue, valueColor ? { color: valueColor } : null]}>
        {value}
      </Text>
      <Text style={styles.summaryLabel}>{label}</Text>
    </View>
  );
}

function PercentBar({ value, color }: { value?: number; color: string }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const pct = Math.max(0, Math.min(100, Math.round(value || 0)));
  return (
    <View style={styles.percentWrap}>
      <View style={styles.percentTrack}>
        <View
          style={[styles.percentFill, { width: `${pct}%`, backgroundColor: color }]}
        />
      </View>
      <Text style={styles.percentLabel}>{pct}%</Text>
    </View>
  );
}

function AnalyticsTab() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [data, setData] = useState<TeamAnalytics | null>(null);
  const [range, setRange] = useState("7");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await getTeamAnalytics(Number(range));
      setData(data);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [range]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const members = useMemo(() => {
    const list = data?.members || [];
    return [...list].sort((a, b) => (b.hours || 0) - (a.hours || 0));
  }, [data]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  return (
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
      <View style={styles.filterRow}>
        {RANGE_OPTIONS.map((r) => (
          <Pressable
            key={r.value}
            style={[styles.filterChip, range === r.value && styles.filterChipActive]}
            onPress={() => setRange(r.value)}
          >
            <Text
              style={[
                styles.filterChipText,
                range === r.value && styles.filterChipTextActive,
              ]}
            >
              {r.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Summary cards */}
      <View style={styles.summaryGrid}>
        <SummaryCard
          icon={<Users size={20} color={theme.primary} />}
          value={String(data?.totalMembers ?? 0)}
          label="Team Members"
        />
        <SummaryCard
          icon={<Timer size={20} color={theme.primary} />}
          value={`${(data?.avgHours ?? 0).toFixed(1)}h`}
          label="Avg Hours/Day"
        />
        <SummaryCard
          icon={<ClipboardList size={20} color={theme.primary} />}
          value={String(data?.totalTasksDone ?? 0)}
          label="Planner Done"
        />
        <SummaryCard
          icon={<Target size={20} color={theme.primary} />}
          value={`${data?.avgTargetMet ?? 0}%`}
          label="Avg Target Met"
        />
        <SummaryCard
          icon={<Timer size={20} color={theme.primary} />}
          value={`${data?.avgPunctuality ?? 0}%`}
          label="Avg Punctuality"
        />
        <SummaryCard
          icon={<ClipboardList size={20} color={theme.warning} />}
          value={String(data?.pendingApprovals ?? 0)}
          label="Pending Approvals"
          valueColor={theme.warning}
        />
      </View>

      {/* Member performance */}
      <Text style={styles.sectionTitle}>
        Member Performance{" "}
        <Text style={styles.memberCount}>({members.length})</Text>
      </Text>

      {members.length === 0 ? (
        <View style={styles.empty}>
          <Users size={40} color={theme.textMuted} />
          <Text style={styles.emptyText}>No member data</Text>
        </View>
      ) : (
        <View style={{ gap: 10 }}>
          {members.map((mem) => {
            const avatar = uploadUrl(mem.avatar);
            return (
              <View key={mem.id} style={styles.perfCard}>
                <View style={styles.perfHeader}>
                  <View style={styles.avatarSm}>
                    {avatar ? (
                      <Image source={{ uri: avatar }} style={styles.avatarImgSm} />
                    ) : (
                      <Text style={styles.avatarTextSm}>
                        {initials(mem.full_name)}
                      </Text>
                    )}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.perfName} numberOfLines={1}>
                      {mem.full_name}
                    </Text>
                    <Text style={styles.perfMeta} numberOfLines={1}>
                      {[roleLabel(mem.role), mem.department_name, mem.team_name]
                        .filter(Boolean)
                        .join(" · ")}
                    </Text>
                  </View>
                  <View style={styles.perfHours}>
                    <Text style={styles.perfHoursValue}>
                      {(mem.hours ?? 0).toFixed(1)}h
                    </Text>
                    <Text style={styles.perfHoursLabel}>total</Text>
                  </View>
                </View>

                <View style={styles.perfStatsRow}>
                  <View style={styles.perfStat}>
                    <Text style={styles.perfStatLabel}>Avg/Day</Text>
                    <Text style={styles.perfStatValue}>
                      {formatTime(mem.avgFloorMinutes || 0)}
                    </Text>
                  </View>
                  <View style={styles.perfStat}>
                    <Text style={styles.perfStatLabel}>Planner</Text>
                    <Text style={styles.perfStatValue}>
                      {mem.tasksDone ?? 0}/{mem.tasksTotal ?? 0}
                    </Text>
                  </View>
                </View>

                <View style={styles.perfBarRow}>
                  <Text style={styles.perfBarLabel}>Target Met</Text>
                  <PercentBar value={mem.targetMetPercent} color={theme.success} />
                </View>
                <View style={styles.perfBarRow}>
                  <Text style={styles.perfBarLabel}>Punctuality</Text>
                  <PercentBar value={mem.punctualityPercent} color="#3b82f6" />
                </View>
              </View>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}

/* ───────────────────────── My Requests tab ───────────────────────── */

function MyRequestsTab() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [items, setItems] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await getMyRequests({ status: "all" });
      setItems(data || []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  return (
    <FlatList
      data={items}
      keyExtractor={(a) => String(a.id)}
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
      ListHeaderComponent={
        <Text style={styles.sectionTitle}>Your Submitted Requests</Text>
      }
      renderItem={({ item }) => {
        const st = statusConfig(item.status);
        return (
          <View style={styles.requestCard}>
            <View style={styles.requestTop}>
              <View style={styles.typePill}>
                <Text style={styles.typePillText}>{typeLabel(item.type)}</Text>
              </View>
              <View style={[styles.badge, { backgroundColor: st.bg }]}>
                <Text style={[styles.badgeText, { color: st.color }]}>
                  {st.label}
                </Text>
              </View>
            </View>
            <View style={styles.detailRow}>
              <DetailIcon type={item.type} color={theme.textSecondary} />
              <Text style={styles.approvalDetail}>{requestDetail(item)}</Text>
            </View>
            <Text style={styles.requestMeta}>
              {item.created_at
                ? new Date(item.created_at).toLocaleDateString()
                : "—"}
              {item.approver_name ? ` · Reviewed by ${item.approver_name}` : ""}
            </Text>
            {item.reject_reason ? (
              <Text style={styles.rejectReasonNote}>
                Reason: {item.reject_reason}
              </Text>
            ) : null}
          </View>
        );
      }}
      ListEmptyComponent={
        <View style={styles.empty}>
          <ClipboardList size={40} color={theme.textMuted} />
          <Text style={styles.emptyText}>No requests submitted</Text>
        </View>
      }
    />
  );
}

/* ───────────────────────── Styles ───────────────────────── */

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.bg },
    center: { flex: 1, alignItems: "center", justifyContent: "center" },
    tabRow: {
      flexDirection: "row",
      backgroundColor: theme.surface,
      borderRadius: theme.radiusSm,
      padding: 3,
      gap: 3,
      margin: 16,
      marginBottom: 8,
    },
    tabBtn: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 9,
      paddingHorizontal: 4,
      borderRadius: 5,
    },
    tabBtnActive: { backgroundColor: theme.primary },
    tabText: { fontSize: 12, color: theme.textSecondary, fontWeight: "600" },
    tabTextActive: { color: "#fff" },
    list: { padding: 16, paddingTop: 8, gap: 12, paddingBottom: 40 },

    // stats grid
    statsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
    statCard: {
      flexGrow: 1,
      flexBasis: "22%",
      minWidth: 70,
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radius,
      paddingVertical: 14,
      alignItems: "center",
      gap: 2,
    },
    statValue: { fontSize: 22, fontWeight: "800", color: theme.text },
    statLabel: {
      fontSize: 10,
      color: theme.textMuted,
      textTransform: "uppercase",
      letterSpacing: 0.3,
    },

    // group sections
    groupSection: { gap: 10 },
    groupTitle: { fontSize: 14, fontWeight: "700", color: theme.text },

    // member card
    memberCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radius,
      padding: 12,
    },
    avatar: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: theme.primary,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarImg: { width: 44, height: 44, borderRadius: 22 },
    avatarText: { color: "#fff", fontSize: 15, fontWeight: "700" },
    memberBody: { flex: 1, gap: 2 },
    memberName: { fontSize: 15, fontWeight: "600", color: theme.text },
    memberRole: { fontSize: 12, color: theme.textSecondary },
    memberMetaRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 10,
      marginTop: 2,
    },
    metaItem: { flexDirection: "row", alignItems: "center", gap: 4 },
    memberMeta: {
      fontSize: 12,
      color: theme.textSecondary,
      textTransform: "capitalize",
    },
    taskHighlight: { fontSize: 12, color: theme.primary, marginTop: 2 },
    badge: {
      borderRadius: theme.radiusSm,
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    badgeText: { fontSize: 11, fontWeight: "700" },

    // filters
    filterRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      paddingHorizontal: 16,
      paddingBottom: 8,
    },
    filterChip: {
      paddingHorizontal: 14,
      paddingVertical: 7,
      borderRadius: theme.radiusFull,
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
    },
    filterChipActive: {
      backgroundColor: theme.primary,
      borderColor: theme.primary,
    },
    filterChipText: { fontSize: 13, color: theme.textSecondary, fontWeight: "600" },
    filterChipTextActive: { color: "#fff" },

    // approval card
    approvalCard: {
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radius,
      padding: 14,
      gap: 8,
    },
    approvalHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
    avatarSm: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: theme.primary,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarImgSm: { width: 36, height: 36, borderRadius: 18 },
    avatarTextSm: { color: "#fff", fontSize: 13, fontWeight: "700" },
    approvalName: { fontSize: 15, fontWeight: "600", color: theme.text },
    approvalType: {
      fontSize: 12,
      color: theme.textSecondary,
      textTransform: "capitalize",
    },
    detailRow: { flexDirection: "row", alignItems: "center", gap: 6 },
    approvalDetail: { fontSize: 13, color: theme.text, flex: 1 },
    approvalReason: { fontSize: 13, color: theme.textMuted, fontStyle: "italic" },
    rejectReasonNote: { fontSize: 12, color: theme.danger },
    actionRow: { flexDirection: "row", gap: 10, marginTop: 4 },
    actionBtn: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingVertical: 10,
      borderRadius: theme.radiusSm,
    },
    rejectBtn: {
      backgroundColor: "rgba(224,62,62,0.1)",
      borderWidth: 1,
      borderColor: "rgba(224,62,62,0.25)",
    },
    approveBtn: { backgroundColor: theme.primary },
    actionText: { fontSize: 14, fontWeight: "600" },

    // analytics summary
    summaryGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
    summaryCard: {
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
    summaryIcon: { marginBottom: 2 },
    summaryValue: { fontSize: 20, fontWeight: "800", color: theme.text },
    summaryLabel: {
      fontSize: 10,
      color: theme.textMuted,
      textTransform: "uppercase",
      letterSpacing: 0.3,
      textAlign: "center",
    },
    sectionTitle: { fontSize: 15, fontWeight: "700", color: theme.text },
    memberCount: { fontSize: 13, color: theme.textMuted, fontWeight: "500" },

    // member performance
    perfCard: {
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radius,
      padding: 14,
      gap: 10,
    },
    perfHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
    perfName: { fontSize: 15, fontWeight: "600", color: theme.text },
    perfMeta: { fontSize: 12, color: theme.textSecondary, marginTop: 2 },
    perfHours: { alignItems: "flex-end" },
    perfHoursValue: { fontSize: 16, fontWeight: "800", color: theme.text },
    perfHoursLabel: {
      fontSize: 9,
      color: theme.textMuted,
      textTransform: "uppercase",
    },
    perfStatsRow: { flexDirection: "row", gap: 10 },
    perfStat: {
      flex: 1,
      backgroundColor: theme.surface,
      borderRadius: theme.radiusSm,
      paddingVertical: 8,
      alignItems: "center",
      gap: 2,
    },
    perfStatLabel: {
      fontSize: 9,
      color: theme.textMuted,
      textTransform: "uppercase",
      letterSpacing: 0.3,
    },
    perfStatValue: { fontSize: 14, fontWeight: "700", color: theme.text },
    perfBarRow: { flexDirection: "row", alignItems: "center", gap: 10 },
    perfBarLabel: { fontSize: 12, color: theme.textSecondary, width: 80 },
    percentWrap: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8 },
    percentTrack: {
      flex: 1,
      height: 6,
      borderRadius: 3,
      backgroundColor: theme.surface,
      overflow: "hidden",
    },
    percentFill: { height: "100%", borderRadius: 3 },
    percentLabel: {
      fontSize: 11,
      fontWeight: "700",
      color: theme.text,
      width: 34,
      textAlign: "right",
    },

    // my requests
    requestCard: {
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radius,
      padding: 14,
      gap: 8,
    },
    requestTop: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    typePill: {
      backgroundColor: theme.surface,
      borderRadius: theme.radiusSm,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    typePillText: {
      fontSize: 12,
      color: theme.text,
      fontWeight: "600",
      textTransform: "capitalize",
    },
    requestMeta: { fontSize: 12, color: theme.textMuted },

    // empty
    empty: { alignItems: "center", gap: 10, paddingTop: 60 },
    emptyText: { color: theme.textMuted, fontSize: 14 },
  });