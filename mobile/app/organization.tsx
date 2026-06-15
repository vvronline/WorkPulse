import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
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
  Save,
  Search,
  Users,
  XCircle,
} from "lucide-react-native";
import type { Theme } from "../src/theme";
import { useTheme } from "../src/theme/ThemeProvider";
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

type TabKey = "salary-slips" | "departments" | "teams" | "chart";

const TABS: { key: TabKey; label: string; icon: typeof CreditCard }[] = [
  { key: "salary-slips", label: "Salary Slips", icon: CreditCard },
  { key: "departments", label: "My Department", icon: Building2 },
  { key: "teams", label: "My Team", icon: Users },
  { key: "chart", label: "Org Chart", icon: GitBranch },
];

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
  const [org, setOrg] = useState<OrgInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabKey>("salary-slips");

  useEffect(() => {
    getCurrentOrg()
      .then((r) => setOrg(r.data || null))
      .catch(() => setOrg(null))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: "Organization" }} />
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  if (!org) {
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
      <Stack.Screen options={{ title: org.name || "Organization" }} />

      {/* Tab bar */}
      <View style={styles.tabBarWrap}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tabBar}
        >
          {TABS.map((t) => {
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
        </ScrollView>
      </View>

      {tab === "salary-slips" && <SalarySlipsTab theme={theme} />}
      {tab === "departments" && <DepartmentsTab theme={theme} />}
      {tab === "teams" && <TeamsTab theme={theme} />}
      {tab === "chart" && <OrgChartTab theme={theme} />}
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
  const [slips, setSlips] = useState<MySalarySlip[]>([]);
  const [bank, setBank] = useState<MyBankDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [downloadingId, setDownloadingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    account_holder_name: "",
    account_number: "",
    ifsc_code: "",
    bank_name: "",
    account_type: "savings",
  });

  const load = useCallback(async () => {
    setError(null);
    const [slipsRes, bankRes] = await Promise.allSettled([
      getMySalarySlips(),
      getMyBankDetails(),
    ]);
    if (slipsRes.status === "fulfilled") {
      setSlips(Array.isArray(slipsRes.value.data) ? slipsRes.value.data : []);
    } else {
      setSlips([]);
      setError(
        (slipsRes.reason as any)?.response?.data?.error ||
          "Salary slips are unavailable.",
      );
    }
    if (bankRes.status === "fulfilled") setBank(bankRes.value.data || null);
    else setBank(null);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSave() {
    if (
      !form.account_holder_name ||
      !form.account_number ||
      !form.ifsc_code
    ) {
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
      await load();
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
          onRefresh={() => {
            setRefreshing(true);
            load();
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
  const [depts, setDepts] = useState<OrgDepartment[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await getOrgDepartments();
      setDepts(Array.isArray(r.data) ? r.data : []);
    } catch {
      setDepts([]);
    }
    setLoading(false);
    setRefreshing(false);
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
      data={depts}
      keyExtractor={(d) => String(d.id)}
      contentContainerStyle={styles.tabContent}
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
      renderItem={({ item }) => (
        <View style={styles.rowCard}>
          <View style={styles.rowIcon}>
            <Building2 size={18} color={theme.primary} />
          </View>
          <View style={styles.rowBody}>
            <Text style={styles.rowTitle}>{item.name}</Text>
            <Text style={styles.rowMeta}>
              Head: {item.head_name || "—"}
            </Text>
          </View>
          {item.member_count != null ? (
            <View style={styles.countBadge}>
              <Text style={styles.countText}>{item.member_count}</Text>
            </View>
          ) : null}
        </View>
      )}
      ListEmptyComponent={
        <Text style={styles.empty}>No departments yet.</Text>
      }
    />
  );
}

/* ───────────────────────── Teams Tab ───────────────────────── */

function TeamsTab({ theme }: { theme: Theme }) {
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [teams, setTeams] = useState<OrgTeam[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await getOrgTeams();
      setTeams(Array.isArray(r.data) ? r.data : []);
    } catch {
      setTeams([]);
    }
    setLoading(false);
    setRefreshing(false);
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
      data={teams}
      keyExtractor={(t) => String(t.id)}
      contentContainerStyle={styles.tabContent}
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
  const [chart, setChart] = useState<OrgChart | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [view, setView] = useState<"dept" | "tree">("dept");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await getOrgChart();
      setChart(r.data || null);
    } catch {
      setChart(null);
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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
          onRefresh={() => {
            setRefreshing(true);
            load();
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
              (m) =>
                String(m.department_id) === String(dept.id) && !m.team_id,
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
                        <Text style={styles.teamCount}>
                          {tMembers.length}
                        </Text>
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
    search &&
    member.full_name.toLowerCase().includes(search.toLowerCase());

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

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.bg },
    center: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.bg,
      padding: 24,
    },
    emptyMsg: {
      color: theme.textSecondary,
      fontSize: 14,
      textAlign: "center",
      lineHeight: 20,
    },

    /* Tabs */
    tabBarWrap: {
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    tabBar: { paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
    tab: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: theme.radiusFull,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      backgroundColor: theme.glass,
    },
    tabActive: {
      backgroundColor: theme.primary,
      borderColor: theme.primary,
    },
    tabText: { fontSize: 13, fontWeight: "600", color: theme.textSecondary },
    tabTextActive: { color: theme.onAccent },

    tabContent: { padding: 16, gap: 12, paddingBottom: 40 },

    /* Cards */
    card: {
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radiusLg,
      padding: 16,
      gap: 10,
    },
    cardHeaderRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    cardHeaderTitle: { flexDirection: "row", alignItems: "center", gap: 8 },
    cardTitle: { fontSize: 14, fontWeight: "700", color: theme.text },
    editBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: theme.radiusSm,
      paddingHorizontal: 10,
      paddingVertical: 5,
    },
    editBtnText: { fontSize: 12, color: theme.textSecondary },

    detailGrid: { gap: 12 },
    detailItem: { gap: 2 },
    detailLabel: { fontSize: 11, color: theme.textMuted },
    detailValue: { fontSize: 13, fontWeight: "500", color: theme.text },

    /* Forms */
    form: { gap: 12 },
    formHint: { fontSize: 12, color: theme.textMuted, lineHeight: 17 },
    fieldLabel: {
      fontSize: 11,
      color: theme.textSecondary,
      marginBottom: 5,
    },
    input: {
      backgroundColor: theme.inputBg,
      borderWidth: 1,
      borderColor: theme.inputBorder,
      borderRadius: theme.radiusSm,
      paddingHorizontal: 12,
      paddingVertical: 9,
      color: theme.text,
      fontSize: 13,
    },
    toggleRow: { flexDirection: "row", gap: 8 },
    toggleBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      backgroundColor: theme.glass,
      borderRadius: theme.radiusSm,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    toggleBtnActive: {
      backgroundColor: theme.primary,
      borderColor: theme.primary,
    },
    toggleText: { fontSize: 12, fontWeight: "600", color: theme.textSecondary },
    toggleTextActive: { color: theme.onAccent },
    formActions: { flexDirection: "row", gap: 10, marginTop: 4 },
    primaryBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: theme.primary,
      borderRadius: theme.radiusSm,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    primaryBtnText: { color: theme.onAccent, fontSize: 13, fontWeight: "600" },
    ghostBtn: {
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: theme.radiusSm,
      paddingHorizontal: 16,
      paddingVertical: 10,
      justifyContent: "center",
    },
    ghostBtnText: { color: theme.textSecondary, fontSize: 13 },
    disabled: { opacity: 0.6 },

    sectionTitle: {
      fontSize: 13,
      fontWeight: "700",
      color: theme.textSecondary,
      textTransform: "uppercase",
      letterSpacing: 0.6,
      marginTop: 6,
    },
    errorText: { color: theme.danger, fontSize: 12 },
    empty: {
      color: theme.textMuted,
      fontSize: 13,
      textAlign: "center",
      paddingTop: 24,
    },

    /* Salary slip cards */
    slipCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radius,
      padding: 14,
    },
    slipBody: { flex: 1, gap: 4 },
    slipMonth: { fontSize: 15, fontWeight: "700", color: theme.text },
    slipMeta: { fontSize: 12, color: theme.textSecondary },
    slipNet: { fontWeight: "700", color: theme.text },
    slipStatusRow: { flexDirection: "row", alignItems: "center", gap: 4 },
    slipStatusText: { fontSize: 11, fontWeight: "600" },
    slipPending: { fontSize: 11, color: theme.textMuted },
    iconBtn: { padding: 6 },

    /* Row cards (dept/team) */
    rowCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radius,
      padding: 14,
    },
    rowIcon: {
      width: 40,
      height: 40,
      borderRadius: 11,
      backgroundColor: theme.primaryGlow,
      alignItems: "center",
      justifyContent: "center",
    },
    rowBody: { flex: 1, gap: 3 },
    rowTitle: { fontSize: 15, fontWeight: "600", color: theme.text },
    rowMeta: { fontSize: 12, color: theme.textSecondary },
    rowSubMeta: { fontSize: 11, color: theme.textMuted },
    countBadge: {
      backgroundColor: theme.primaryGlow,
      borderRadius: theme.radiusFull,
      minWidth: 26,
      paddingHorizontal: 8,
      paddingVertical: 3,
      alignItems: "center",
    },
    countText: {
      color: theme.primaryLight,
      fontSize: 12,
      fontWeight: "700",
    },

    /* Org chart */
    searchBox: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      backgroundColor: theme.inputBg,
      borderWidth: 1,
      borderColor: theme.inputBorder,
      borderRadius: theme.radiusSm,
      paddingHorizontal: 12,
      paddingVertical: 4,
    },
    searchInput: { flex: 1, color: theme.text, fontSize: 13, paddingVertical: 6 },
    searchClear: { color: theme.textMuted, fontSize: 14, paddingHorizontal: 4 },

    deptHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
    deptName: { flex: 1, fontSize: 15, fontWeight: "700", color: theme.text },
    teamBlock: {
      gap: 6,
      marginTop: 6,
      paddingTop: 8,
      borderTopWidth: 1,
      borderTopColor: theme.border,
    },
    teamTitleRow: { flexDirection: "row", alignItems: "center", gap: 5 },
    teamTitle: { fontSize: 13, fontWeight: "600", color: theme.text },
    teamCount: {
      fontSize: 11,
      fontWeight: "700",
      color: theme.primaryLight,
      backgroundColor: theme.primaryGlow,
      borderRadius: theme.radiusFull,
      paddingHorizontal: 6,
      paddingVertical: 1,
    },
    teamLead: { fontSize: 11, color: theme.textMuted },

    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      backgroundColor: theme.surface,
      borderRadius: theme.radiusSm,
      padding: 8,
    },
    chipAvatar: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: theme.primary,
      alignItems: "center",
      justifyContent: "center",
    },
    chipAvatarImg: { width: 32, height: 32, borderRadius: 16 },
    chipAvatarText: { color: "#fff", fontSize: 12, fontWeight: "700" },
    chipBody: { flex: 1, gap: 1 },
    chipName: { fontSize: 13, fontWeight: "600", color: theme.text },
    chipMeta: { fontSize: 11, color: theme.textSecondary },
    chipRole: {
      backgroundColor: theme.primaryGlow,
      borderRadius: theme.radiusFull,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    chipRoleText: {
      color: theme.primaryLight,
      fontSize: 10,
      fontWeight: "600",
      textTransform: "capitalize",
    },

    treeRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radiusSm,
      padding: 8,
      marginBottom: 6,
    },
    treeRowHl: { borderColor: theme.primary },
    treeDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: theme.textMuted,
      marginHorizontal: 4,
    },
    treeCount: {
      fontSize: 11,
      fontWeight: "700",
      color: theme.primaryLight,
      backgroundColor: theme.primaryGlow,
      borderRadius: theme.radiusFull,
      paddingHorizontal: 7,
      paddingVertical: 2,
    },
    treeChildren: {
      borderLeftWidth: 1,
      borderLeftColor: theme.border,
      paddingLeft: 6,
    },
  });