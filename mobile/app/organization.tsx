import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack } from "expo-router";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import {
  Building2,
  CheckCircle2,
  ChevronRight,
  Clock,
  CreditCard,
  Download,
  Edit3,
  GitBranch,
  Plus,
  Save,
  Search,
  Tag,
  Trash2,
  Users,
  X,
  XCircle,
} from "../src/icons";
import type { Theme } from "../src/theme";
import { useTheme } from "../src/theme/ThemeProvider";
import { useAuth } from "../src/auth/AuthContext";
import { uploadUrl, API_BASE_URL } from "../src/config";
import { getToken } from "../src/auth/tokenStore";
import {
  getCurrentOrg,
  getMyBankDetails,
  getMySalarySlips,
  getOrgChart,
  getOrgDepartments,
  getOrgTeams,
  mySalarySlipPdfPath,
  saveMyBankDetails,
  type MyBankDetails,
  type MySalarySlip,
  type OrgChart,
  type OrgChartMember,
  type OrgDepartment,
  type OrgInfo,
  type OrgTeam,
} from "../src/features";
import {
  createTaskLabel,
  deleteTaskLabel,
  getTaskLabelsManage,
  updateTaskLabel,
  type TaskLabelManage,
} from "../src/admin";
import { makeStyles } from "./organization.styles";

type TabKey = "salary-slips" | "departments" | "teams" | "chart" | "labels";

const ADMIN_ROLES = ["hr_admin", "super_admin", "platform_admin"];

// Label colour presets (mirrors the web TaskLabelsTab + mobile admin/agile).
const LABEL_PRESETS = [
  "#6366f1",
  "#8b5cf6",
  "#ec4899",
  "#ef4444",
  "#f59e0b",
  "#10b981",
  "#06b6d4",
  "#3b82f6",
  "#64748b",
];

const ALL_TABS: { key: TabKey; label: string; icon: typeof CreditCard }[] = [
  { key: "salary-slips", label: "Salary Slips", icon: CreditCard },
  { key: "departments", label: "My Department", icon: Building2 },
  { key: "teams", label: "My Team", icon: Users },
  { key: "chart", label: "Org Chart", icon: GitBranch },
];

const EMPTY_SLIPS: MySalarySlip[] = [];
const EMPTY_DEPARTMENTS: OrgDepartment[] = [];
const EMPTY_TEAMS: OrgTeam[] = [];
const EMPTY_LABELS: TaskLabelManage[] = [];

function initials(name?: string) {
  if (!name) return "?";
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "?";
}

function fmtMoney(v?: number | string | null): string {
  if (v == null || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

export default function OrganizationScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { user } = useAuth();
  const isAdmin = ADMIN_ROLES.includes(user?.role ?? "");
  // Managers (non-admin) can manage task labels here — mirrors the web
  // Organization page's `canManageLabels = !isAdmin && role === "manager"`.
  const canManageLabels = !isAdmin && user?.role === "manager";
  const { data: org = null, isLoading: loading } = useQuery({
    queryKey: ["org", "current"],
    queryFn: async () => (await getCurrentOrg()).data || null,
  });
  const [tab, setTab] = useState<TabKey>("salary-slips");

  // Admins (incl. platform admin) aren't scoped to a single org and only see
  // Salary Slips. Regular members get the full set of tabs; managers also get
  // the Task Labels tab.
  const tabs = useMemo(() => {
    if (isAdmin) return ALL_TABS.filter((t) => t.key === "salary-slips");
    const base = [...ALL_TABS];
    if (canManageLabels) {
      base.push({ key: "labels", label: "Task Labels", icon: Tag });
    }
    return base;
  }, [isAdmin, canManageLabels]);

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: "Organization" }} />
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  // Members without an org get the empty message; admins still see Salary Slips.
  if (!org && !isAdmin) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: "Organization" }} />
        <Text style={styles.emptyMsg}>
          You are not assigned to any organization yet. Please contact your
          administrator.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: org?.name || "Organization" }} />

      {/* Tab bar */}
      <View style={styles.tabRow}>
        {tabs.map((t) => {
          const active = tab === t.key;
          return (
            <Pressable
              key={t.key}
              style={[styles.tab, active && styles.tabActive]}
              onPress={() => setTab(t.key)}
            >
              <t.icon
                size={14}
                color={active ? theme.onAccent : theme.textSecondary}
              />
              <Text style={[styles.tabText, active && styles.tabTextActive]}>
                {t.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {tab === "salary-slips" && <SalarySlipsTab theme={theme} />}
      {tab === "departments" && <DepartmentsTab theme={theme} />}
      {tab === "teams" && <TeamsTab theme={theme} />}
      {tab === "chart" && <OrgChartTab theme={theme} />}
      {tab === "labels" && canManageLabels && <TaskLabelsTab theme={theme} />}
    </View>
  );
}

/* ───────────────────────── Salary Slips Tab ───────────────────────── */

const SLIP_STATUS_COLOR: Record<string, string> = {
  processed: "#10b981",
  processing: "#3b82f6",
  failed: "#ef4444",
  reversed: "#ef4444",
};

function SalarySlipsTab({ theme }: { theme: Theme }) {
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [downloadingId, setDownloadingId] = useState<number | null>(null);
  const [form, setForm] = useState({
    account_holder_name: "",
    account_number: "",
    ifsc_code: "",
    bank_name: "",
    account_type: "savings",
  });

  const { data, isLoading: loading } = useQuery({
    queryKey: ["org", "salarySlips"],
    queryFn: async () => {
      const [slipsRes, bankRes] = await Promise.allSettled([
        getMySalarySlips(),
        getMyBankDetails(),
      ]);
      let slips: MySalarySlip[] = EMPTY_SLIPS;
      let error: string | null = null;
      if (slipsRes.status === "fulfilled") {
        slips = Array.isArray(slipsRes.value.data)
          ? slipsRes.value.data
          : EMPTY_SLIPS;
      } else {
        error =
          (slipsRes.reason as any)?.response?.data?.error ||
          "Salary slips are unavailable.";
      }
      const bank =
        bankRes.status === "fulfilled" ? bankRes.value.data || null : null;
      return { slips, bank, error };
    },
  });
  const slips = data?.slips ?? EMPTY_SLIPS;
  const bank = data?.bank ?? null;
  const error = data?.error ?? null;

  async function handleSave() {
    if (!form.account_holder_name || !form.account_number || !form.ifsc_code) {
      Alert.alert("Missing fields", "Please fill in all required fields.");
      return;
    }
    setSaving(true);
    try {
      await saveMyBankDetails(form);
      setEditing(false);
      setForm({
        account_holder_name: "",
        account_number: "",
        ifsc_code: "",
        bank_name: "",
        account_type: "savings",
      });
      await queryClient.invalidateQueries({ queryKey: ["org", "salarySlips"] });
    } catch (e: any) {
      Alert.alert(
        "Error",
        e?.response?.data?.error || "Failed to save bank details",
      );
    } finally {
      setSaving(false);
    }
  }

  async function downloadPdf(slip: MySalarySlip) {
    setDownloadingId(slip.id);
    try {
      const token = await getToken();
      const safeName = String(slip.slip_month || slip.id).replace(
        /[^\w.-]/g,
        "_",
      );
      const target = `${FileSystem.cacheDirectory}salary_slip_${safeName}.pdf`;
      const res = await FileSystem.downloadAsync(
        `${API_BASE_URL}${mySalarySlipPdfPath(slip.id)}`,
        target,
        { headers: token ? { Authorization: `Bearer ${token}` } : undefined },
      );
      if (res.status !== 200) throw new Error(`Server returned ${res.status}`);
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

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={styles.tabContent}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await queryClient.invalidateQueries({
              queryKey: ["org", "salarySlips"],
            });
            setRefreshing(false);
          }}
          tintColor={theme.primary}
        />
      }
    >
      {/* Bank details card */}
      <View style={styles.card}>
        <View style={styles.cardHeaderRow}>
          <View style={styles.cardHeaderTitle}>
            <Building2 size={16} color={theme.text} />
            <Text style={styles.cardTitle}>Bank Details</Text>
          </View>
          {bank && !editing ? (
            <Pressable
              style={styles.editBtn}
              onPress={() => {
                setForm({
                  account_holder_name: bank.account_holder_name || "",
                  account_number: "",
                  ifsc_code: bank.ifsc_code || "",
                  bank_name: bank.bank_name || "",
                  account_type: bank.account_type || "savings",
                });
                setEditing(true);
              }}
            >
              <Edit3 size={12} color={theme.textSecondary} />
              <Text style={styles.editBtnText}>Edit</Text>
            </Pressable>
          ) : null}
        </View>

        {bank && !editing ? (
          <View style={styles.detailGrid}>
            <Detail
              theme={theme}
              label="Account Holder"
              value={bank.account_holder_name || "-"}
            />
            <Detail
              theme={theme}
              label="Account Number"
              value={bank.account_number || "-"}
            />
            <Detail
              theme={theme}
              label="IFSC Code"
              value={bank.ifsc_code || "-"}
            />
            <Detail
              theme={theme}
              label="Bank Name"
              value={bank.bank_name || "-"}
            />
            <View style={styles.detailItem}>
              <Text style={styles.detailLabel}>Status</Text>
              <Text
                style={[
                  styles.detailValue,
                  { color: bank.is_verified ? theme.success : theme.warning },
                ]}
              >
                {bank.is_verified ? "✓ Verified" : "Pending Verification"}
              </Text>
            </View>
          </View>
        ) : (
          <View style={styles.form}>
            {!bank ? (
              <Text style={styles.formHint}>
                Add your bank details to receive salary payouts directly to your
                account.
              </Text>
            ) : null}
            <Field
              theme={theme}
              label="Account Holder Name *"
              value={form.account_holder_name}
              onChangeText={(v) =>
                setForm((f) => ({ ...f, account_holder_name: v }))
              }
              placeholder="Full name as per bank"
            />
            <Field
              theme={theme}
              label="Account Number *"
              value={form.account_number}
              onChangeText={(v) =>
                setForm((f) => ({ ...f, account_number: v }))
              }
              placeholder="Enter account number"
              keyboardType="number-pad"
            />
            <Field
              theme={theme}
              label="IFSC Code *"
              value={form.ifsc_code}
              onChangeText={(v) =>
                setForm((f) => ({ ...f, ifsc_code: v.toUpperCase() }))
              }
              placeholder="e.g. SBIN0001234"
              autoCapitalize="characters"
            />
            <Field
              theme={theme}
              label="Bank Name"
              value={form.bank_name}
              onChangeText={(v) => setForm((f) => ({ ...f, bank_name: v }))}
              placeholder="e.g. State Bank of India"
            />
            <View>
              <Text style={styles.fieldLabel}>Account Type</Text>
              <View style={styles.toggleRow}>
                {["savings", "current"].map((t) => {
                  const active = form.account_type === t;
                  return (
                    <Pressable
                      key={t}
                      style={[
                        styles.toggleBtn,
                        active && styles.toggleBtnActive,
                      ]}
                      onPress={() =>
                        setForm((f) => ({ ...f, account_type: t }))
                      }
                    >
                      <Text
                        style={[
                          styles.toggleText,
                          active && styles.toggleTextActive,
                        ]}
                      >
                        {t === "savings" ? "Savings" : "Current"}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
            <View style={styles.formActions}>
              <Pressable
                style={[styles.primaryBtn, saving && styles.disabled]}
                onPress={handleSave}
                disabled={saving}
              >
                <Save size={14} color={theme.onAccent} />
                <Text style={styles.primaryBtnText}>
                  {saving ? "Saving…" : "Save Bank Details"}
                </Text>
              </Pressable>
              {editing ? (
                <Pressable
                  style={styles.ghostBtn}
                  onPress={() => setEditing(false)}
                >
                  <Text style={styles.ghostBtnText}>Cancel</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        )}
      </View>

      {/* Salary slips list */}
      <Text style={styles.sectionTitle}>My Salary Slips</Text>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      {slips.length === 0 ? (
        <Text style={styles.empty}>No salary slips available yet.</Text>
      ) : (
        slips.map((slip) => (
          <View key={slip.id} style={styles.slipCard}>
            <View style={styles.slipBody}>
              <Text style={styles.slipMonth}>{slip.slip_month}</Text>
              <Text style={styles.slipMeta}>
                Net <Text style={styles.slipNet}>{fmtMoney(slip.net_pay)}</Text>
                {"  ·  "}Gross {fmtMoney(slip.gross_earnings)}
                {"  ·  "}Ded {fmtMoney(slip.total_deductions)}
              </Text>
              <View style={styles.slipStatusRow}>
                {slip.disbursement_status ? (
                  <>
                    {slip.disbursement_status === "processed" ? (
                      <CheckCircle2
                        size={12}
                        color={SLIP_STATUS_COLOR.processed}
                      />
                    ) : slip.disbursement_status === "processing" ? (
                      <Clock size={12} color={SLIP_STATUS_COLOR.processing} />
                    ) : (
                      <XCircle size={12} color={SLIP_STATUS_COLOR.failed} />
                    )}
                    <Text
                      style={[
                        styles.slipStatusText,
                        {
                          color:
                            SLIP_STATUS_COLOR[slip.disbursement_status] ||
                            theme.textMuted,
                        },
                      ]}
                    >
                      {slip.disbursement_status === "processed"
                        ? "Paid"
                        : slip.disbursement_status}
                      {slip.utr ? ` · UTR ${slip.utr}` : ""}
                    </Text>
                  </>
                ) : (
                  <Text style={styles.slipPending}>Pending</Text>
                )}
              </View>
            </View>
            <Pressable
              style={styles.iconBtn}
              onPress={() => downloadPdf(slip)}
              disabled={downloadingId === slip.id}
              hitSlop={6}
            >
              {downloadingId === slip.id ? (
                <ActivityIndicator size="small" color={theme.primary} />
              ) : (
                <Download size={18} color={theme.textSecondary} />
              )}
            </Pressable>
          </View>
        ))
      )}
    </ScrollView>
  );
}

function Detail({
  theme,
  label,
  value,
}: {
  theme: Theme;
  label: string;
  value: string;
}) {
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View style={styles.detailItem}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

function Field({
  theme,
  label,
  ...props
}: {
  theme: Theme;
  label: string;
} & React.ComponentProps<typeof TextInput>) {
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.input}
        placeholderTextColor={theme.textMuted}
        {...props}
      />
    </View>
  );
}

/* ───────────────────────── Departments Tab ───────────────────────── */

function DepartmentsTab({ theme }: { theme: Theme }) {
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const { data: depts = EMPTY_DEPARTMENTS, isLoading: loading } = useQuery({
    queryKey: ["org", "departments"],
    queryFn: async () => {
      const r = await getOrgDepartments();
      return Array.isArray(r.data) ? r.data : EMPTY_DEPARTMENTS;
    },
  });

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  return (
    <FlatList
      data={depts}
      keyExtractor={(d) => String(d.id)}
      contentContainerStyle={styles.tabContent}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await queryClient.invalidateQueries({
              queryKey: ["org", "departments"],
            });
            setRefreshing(false);
          }}
          tintColor={theme.primary}
        />
      }
      renderItem={({ item }) => (
        <View style={styles.rowCard}>
          <View style={styles.rowIcon}>
            <Building2 size={18} color={theme.primary} />
          </View>
          <View style={styles.rowBody}>
            <Text style={styles.rowTitle}>{item.name}</Text>
            <Text style={styles.rowMeta}>Head: {item.head_name || "—"}</Text>
          </View>
          {item.member_count != null ? (
            <View style={styles.countBadge}>
              <Text style={styles.countText}>{item.member_count}</Text>
            </View>
          ) : null}
        </View>
      )}
      ListEmptyComponent={<Text style={styles.empty}>No departments yet.</Text>}
    />
  );
}

/* ───────────────────────── Teams Tab ───────────────────────── */

function TeamsTab({ theme }: { theme: Theme }) {
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const { data: teams = EMPTY_TEAMS, isLoading: loading } = useQuery({
    queryKey: ["org", "teams"],
    queryFn: async () => {
      const r = await getOrgTeams();
      return Array.isArray(r.data) ? r.data : EMPTY_TEAMS;
    },
  });

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  return (
    <FlatList
      data={teams}
      keyExtractor={(t) => String(t.id)}
      contentContainerStyle={styles.tabContent}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await queryClient.invalidateQueries({ queryKey: ["org", "teams"] });
            setRefreshing(false);
          }}
          tintColor={theme.primary}
        />
      }
      renderItem={({ item }) => (
        <View style={styles.rowCard}>
          <View style={styles.rowIcon}>
            <Users size={18} color={theme.primary} />
          </View>
          <View style={styles.rowBody}>
            <Text style={styles.rowTitle}>{item.name}</Text>
            <Text style={styles.rowMeta}>
              {[
                item.department_name && `Dept: ${item.department_name}`,
                `Lead: ${item.lead_name || "—"}`,
              ]
                .filter(Boolean)
                .join("  ·  ")}
            </Text>
            {item.sprint_duration_weeks ? (
              <Text style={styles.rowSubMeta}>
                Sprint: {item.sprint_duration_weeks} week
                {item.sprint_duration_weeks > 1 ? "s" : ""}
                {item.sprint_start_date
                  ? ` (from ${item.sprint_start_date})`
                  : ""}
              </Text>
            ) : null}
          </View>
          {item.member_count != null ? (
            <View style={styles.countBadge}>
              <Text style={styles.countText}>{item.member_count}</Text>
            </View>
          ) : null}
        </View>
      )}
      ListEmptyComponent={<Text style={styles.empty}>No teams yet.</Text>}
    />
  );
}

/* ───────────────────────── Org Chart Tab ───────────────────────── */

function OrgChartTab({ theme }: { theme: Theme }) {
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [view, setView] = useState<"dept" | "tree">("dept");
  const [search, setSearch] = useState("");

  const { data: chart = null, isLoading: loading } = useQuery({
    queryKey: ["org", "chart"],
    queryFn: async () => (await getOrgChart()).data || null,
  });

  const filteredMembers = useMemo(() => {
    if (!chart) return [];
    const q = search.trim().toLowerCase();
    if (!q) return chart.members;
    return chart.members.filter(
      (m) =>
        m.full_name?.toLowerCase().includes(q) ||
        m.email?.toLowerCase().includes(q) ||
        m.role?.toLowerCase().includes(q) ||
        m.manager_name?.toLowerCase().includes(q) ||
        m.department_name?.toLowerCase().includes(q) ||
        m.team_name?.toLowerCase().includes(q),
    );
  }, [chart, search]);

  const { childrenMap, roots } = useMemo(() => {
    if (!chart)
      return {
        childrenMap: {} as Record<string, OrgChartMember[]>,
        roots: [] as OrgChartMember[],
      };
    const allIds = new Set(chart.members.map((m) => String(m.id)));
    const map: Record<string, OrgChartMember[]> = {};
    for (const m of chart.members) {
      const pid =
        m.manager_id != null && allIds.has(String(m.manager_id))
          ? String(m.manager_id)
          : "null";
      if (!map[pid]) map[pid] = [];
      map[pid].push(m);
    }
    for (const k of Object.keys(map))
      map[k].sort((a, b) => a.full_name.localeCompare(b.full_name));
    return { childrenMap: map, roots: map["null"] || [] };
  }, [chart]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  if (!chart) {
    return (
      <View style={styles.center}>
        <Text style={styles.empty}>Org chart unavailable.</Text>
      </View>
    );
  }

  const filteredUnassigned = filteredMembers.filter(
    (m) => !m.department_id && !m.team_id,
  );

  return (
    <ScrollView
      contentContainerStyle={styles.tabContent}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await queryClient.invalidateQueries({ queryKey: ["org", "chart"] });
            setRefreshing(false);
          }}
          tintColor={theme.primary}
        />
      }
    >
      {/* View toggle */}
      <View style={styles.toggleRow}>
        <Pressable
          style={[styles.toggleBtn, view === "dept" && styles.toggleBtnActive]}
          onPress={() => setView("dept")}
        >
          <Building2
            size={13}
            color={view === "dept" ? theme.onAccent : theme.textSecondary}
          />
          <Text
            style={[
              styles.toggleText,
              view === "dept" && styles.toggleTextActive,
            ]}
          >
            By Department
          </Text>
        </Pressable>
        <Pressable
          style={[styles.toggleBtn, view === "tree" && styles.toggleBtnActive]}
          onPress={() => setView("tree")}
        >
          <Users
            size={13}
            color={view === "tree" ? theme.onAccent : theme.textSecondary}
          />
          <Text
            style={[
              styles.toggleText,
              view === "tree" && styles.toggleTextActive,
            ]}
          >
            Reporting Lines
          </Text>
        </Pressable>
      </View>

      {/* Search */}
      <View style={styles.searchBox}>
        <Search size={14} color={theme.textMuted} />
        <TextInput
          style={styles.searchInput}
          placeholder="Filter by name, role, or manager…"
          placeholderTextColor={theme.textMuted}
          value={search}
          onChangeText={setSearch}
        />
        {search ? (
          <Pressable onPress={() => setSearch("")} hitSlop={8}>
            <Text style={styles.searchClear}>✕</Text>
          </Pressable>
        ) : null}
      </View>

      {view === "dept" ? (
        <>
          {chart.departments.map((dept) => {
            const hasMatch = filteredMembers.some(
              (m) => String(m.department_id) === String(dept.id),
            );
            if (search && !hasMatch) return null;
            const deptTeams = chart.teams.filter(
              (t) => String(t.department_id) === String(dept.id),
            );
            const deptDirect = filteredMembers.filter(
              (m) => String(m.department_id) === String(dept.id) && !m.team_id,
            );
            const total = filteredMembers.filter(
              (m) => String(m.department_id) === String(dept.id),
            ).length;
            return (
              <View key={String(dept.id)} style={styles.card}>
                <View style={styles.deptHeader}>
                  <Building2 size={16} color={theme.primary} />
                  <Text style={styles.deptName}>{dept.name}</Text>
                  <View style={styles.countBadge}>
                    <Text style={styles.countText}>{total}</Text>
                  </View>
                </View>
                {dept.head_name ? (
                  <Text style={styles.rowSubMeta}>Head: {dept.head_name}</Text>
                ) : null}
                {deptTeams.map((team) => {
                  const tMembers = filteredMembers.filter(
                    (m) => String(m.team_id) === String(team.id),
                  );
                  return (
                    <View key={String(team.id)} style={styles.teamBlock}>
                      <View style={styles.teamTitleRow}>
                        <Users size={12} color={theme.textSecondary} />
                        <Text style={styles.teamTitle}>{team.name}</Text>
                        <Text style={styles.teamCount}>{tMembers.length}</Text>
                        {team.lead_name ? (
                          <Text style={styles.teamLead}>
                            · Lead: {team.lead_name}
                          </Text>
                        ) : null}
                      </View>
                      {tMembers.length > 0 ? (
                        tMembers.map((m) => (
                          <MemberChip key={String(m.id)} theme={theme} m={m} />
                        ))
                      ) : (
                        <Text style={styles.rowSubMeta}>No members</Text>
                      )}
                    </View>
                  );
                })}
                {deptDirect.length > 0 ? (
                  <View style={styles.teamBlock}>
                    <Text style={styles.rowSubMeta}>
                      Not assigned to a team:
                    </Text>
                    {deptDirect.map((m) => (
                      <MemberChip key={String(m.id)} theme={theme} m={m} />
                    ))}
                  </View>
                ) : null}
              </View>
            );
          })}
          {filteredUnassigned.length > 0 ? (
            <View style={styles.card}>
              <View style={styles.deptHeader}>
                <Text style={styles.deptName}>Unassigned</Text>
                <View style={styles.countBadge}>
                  <Text style={styles.countText}>
                    {filteredUnassigned.length}
                  </Text>
                </View>
              </View>
              {filteredUnassigned.map((m) => (
                <MemberChip key={String(m.id)} theme={theme} m={m} />
              ))}
            </View>
          ) : null}
          {search && filteredMembers.length === 0 ? (
            <Text style={styles.empty}>No members match "{search}"</Text>
          ) : null}
        </>
      ) : (
        <>
          {roots.length === 0 ? (
            <Text style={styles.empty}>
              No reporting lines configured — assign managers to employees to
              build the hierarchy.
            </Text>
          ) : (
            roots.map((r) => (
              <TreeNode
                key={String(r.id)}
                theme={theme}
                member={r}
                childrenMap={childrenMap}
                depth={0}
                search={search}
              />
            ))
          )}
        </>
      )}
    </ScrollView>
  );
}

function MemberChip({ theme, m }: { theme: Theme; m: OrgChartMember }) {
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const avatar = uploadUrl(m.avatar);
  const deptTeam = [m.department_name, m.team_name].filter(Boolean).join(" › ");
  return (
    <View style={styles.chip}>
      <View style={styles.chipAvatar}>
        {avatar ? (
          <Image source={{ uri: avatar }} style={styles.chipAvatarImg} />
        ) : (
          <Text style={styles.chipAvatarText}>{initials(m.full_name)}</Text>
        )}
      </View>
      <View style={styles.chipBody}>
        <Text style={styles.chipName} numberOfLines={1}>
          {m.full_name}
        </Text>
        {deptTeam ? (
          <Text style={styles.chipMeta} numberOfLines={1}>
            {deptTeam}
          </Text>
        ) : null}
      </View>
      <View style={styles.chipRole}>
        <Text style={styles.chipRoleText}>{m.role?.replace(/_/g, " ")}</Text>
      </View>
    </View>
  );
}

function TreeNode({
  theme,
  member,
  childrenMap,
  depth,
  search,
}: {
  theme: Theme;
  member: OrgChartMember;
  childrenMap: Record<string, OrgChartMember[]>;
  depth: number;
  search: string;
}) {
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [open, setOpen] = useState(depth < 2);
  const children = childrenMap[String(member.id)] || [];
  const hasChildren = children.length > 0;
  const avatar = uploadUrl(member.avatar);
  const highlight =
    search && member.full_name.toLowerCase().includes(search.toLowerCase());

  return (
    <View style={{ marginLeft: depth > 0 ? 14 : 0 }}>
      <Pressable
        style={[styles.treeRow, highlight && styles.treeRowHl]}
        onPress={() => hasChildren && setOpen((o) => !o)}
      >
        {hasChildren ? (
          <ChevronRight
            size={14}
            color={theme.textMuted}
            style={{
              transform: [{ rotate: open ? "90deg" : "0deg" }],
            }}
          />
        ) : (
          <View style={styles.treeDot} />
        )}
        <View style={styles.chipAvatar}>
          {avatar ? (
            <Image source={{ uri: avatar }} style={styles.chipAvatarImg} />
          ) : (
            <Text style={styles.chipAvatarText}>
              {initials(member.full_name)}
            </Text>
          )}
        </View>
        <View style={styles.chipBody}>
          <Text style={styles.chipName} numberOfLines={1}>
            {member.full_name}
          </Text>
          <Text style={styles.chipMeta} numberOfLines={1}>
            {member.role?.replace(/_/g, " ")}
            {member.department_name ? ` · ${member.department_name}` : ""}
          </Text>
        </View>
        {hasChildren ? (
          <Text style={styles.treeCount}>{children.length}</Text>
        ) : null}
      </Pressable>
      {hasChildren && open ? (
        <View style={styles.treeChildren}>
          {children.map((c) => (
            <TreeNode
              key={String(c.id)}
              theme={theme}
              member={c}
              childrenMap={childrenMap}
              depth={depth + 1}
              search={search}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/* ───────────────────────── Task Labels Tab (managers) ───────────────────────── */

function TaskLabelsTab({ theme }: { theme: Theme }) {
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<TaskLabelManage | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState(LABEL_PRESETS[0]);
  const [saving, setSaving] = useState(false);

  const { data: labels = EMPTY_LABELS, isLoading: loading } = useQuery({
    queryKey: ["org", "taskLabels"],
    queryFn: async () => {
      const r = await getTaskLabelsManage();
      return Array.isArray(r.data) ? r.data : EMPTY_LABELS;
    },
  });
  const reloadLabels = () =>
    queryClient.invalidateQueries({ queryKey: ["org", "taskLabels"] });

  function startCreate() {
    setEditing(null);
    setName("");
    setColor(LABEL_PRESETS[0]);
    setCreating(true);
  }

  function startEdit(l: TaskLabelManage) {
    setCreating(false);
    setEditing(l);
    setName(l.name);
    setColor(l.color || LABEL_PRESETS[0]);
  }

  function cancel() {
    setCreating(false);
    setEditing(null);
    setName("");
    setColor(LABEL_PRESETS[0]);
  }

  async function save() {
    if (!name.trim()) {
      Alert.alert("Missing name", "Please enter a label name.");
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await updateTaskLabel(editing.id, { name: name.trim(), color });
      } else {
        await createTaskLabel({ name: name.trim(), color });
      }
      cancel();
      await reloadLabels();
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to save label");
    } finally {
      setSaving(false);
    }
  }

  function confirmDelete(l: TaskLabelManage) {
    Alert.alert(
      "Delete label",
      `Delete "${l.name}"? It will be removed from all tasks. This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () =>
            deleteTaskLabel(l.id)
              .then(() => reloadLabels())
              .catch((e: any) =>
                Alert.alert(
                  "Error",
                  e?.response?.data?.error || "Failed to delete label",
                ),
              ),
        },
      ],
    );
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  const formOpen = creating || !!editing;

  return (
    <ScrollView
      contentContainerStyle={styles.tabContent}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await queryClient.invalidateQueries({
              queryKey: ["org", "taskLabels"],
            });
            setRefreshing(false);
          }}
          tintColor={theme.primary}
        />
      }
    >
      <Text style={styles.formHint}>
        Free-form tags for cross-cutting filtering (e.g. frontend, tech-debt). A
        ticket can carry many labels.
      </Text>

      {/* Create / edit form */}
      {formOpen ? (
        <View style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <View style={styles.cardHeaderTitle}>
              <Tag size={16} color={theme.text} />
              <Text style={styles.cardTitle}>
                {editing ? "Edit Label" : "New Label"}
              </Text>
            </View>
            <Pressable onPress={cancel} hitSlop={8}>
              <X size={18} color={theme.textSecondary} />
            </Pressable>
          </View>
          <Field
            theme={theme}
            label="Label Name"
            value={name}
            onChangeText={setName}
            placeholder="e.g. frontend"
          />
          <View>
            <Text style={styles.fieldLabel}>Colour</Text>
            <View style={styles.colorRow}>
              {LABEL_PRESETS.map((c) => (
                <Pressable
                  key={c}
                  style={[
                    styles.colorSwatch,
                    { backgroundColor: c },
                    color === c && styles.colorSwatchActive,
                  ]}
                  onPress={() => setColor(c)}
                >
                  {color === c ? <CheckCircle2 size={14} color="#fff" /> : null}
                </Pressable>
              ))}
            </View>
          </View>
          <View style={styles.formActions}>
            <Pressable
              style={[styles.primaryBtn, saving && styles.disabled]}
              onPress={save}
              disabled={saving}
            >
              <Save size={14} color={theme.onAccent} />
              <Text style={styles.primaryBtnText}>
                {saving ? "Saving…" : editing ? "Save Changes" : "Create Label"}
              </Text>
            </Pressable>
            <Pressable style={styles.ghostBtn} onPress={cancel}>
              <Text style={styles.ghostBtnText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable style={styles.primaryBtn} onPress={startCreate}>
          <Plus size={14} color={theme.onAccent} />
          <Text style={styles.primaryBtnText}>New Label</Text>
        </Pressable>
      )}

      {/* Label list */}
      <Text style={styles.sectionTitle}>Labels</Text>
      {labels.length === 0 ? (
        <Text style={styles.empty}>No labels yet.</Text>
      ) : (
        labels.map((l) => (
          <View key={l.id} style={styles.labelRow}>
            <View
              style={[
                styles.labelBadge,
                { backgroundColor: l.color || "#888" },
              ]}
            >
              <Text style={styles.labelBadgeText}>{l.name}</Text>
            </View>
            <View style={styles.labelActions}>
              <Pressable
                style={styles.labelActionBtn}
                onPress={() => startEdit(l)}
                hitSlop={6}
              >
                <Edit3 size={16} color={theme.textSecondary} />
              </Pressable>
              <Pressable
                style={styles.labelActionBtn}
                onPress={() => confirmDelete(l)}
                hitSlop={6}
              >
                <Trash2 size={16} color={theme.danger} />
              </Pressable>
            </View>
          </View>
        ))
      )}
    </ScrollView>
  );
}
