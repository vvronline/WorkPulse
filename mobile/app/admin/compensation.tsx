import {
  useCallback,
  useEffect,
  useMemo,
  useState } from "react";
import { ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View
} from "react-native";
import { Stack } from "expo-router";
import {
  Building2,
  Check,
  LayoutTemplate,
  Pencil,
  Plus,
  Settings as SettingsIcon,
  Trash2,
  Users,
  Wallet,
  X,
} from "lucide-react-native";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import { useKeyboardInset } from "../../src/hooks/useKeyboardInset";
import { Dropdown, type DropdownOption } from "../../src/components/Dropdown";
import {
  approveBankDetails,
  assignCompensation,
  createCompensationTemplate,
  deleteCompensationTemplate,
  getBankVerifications,
  getCompensationTemplates,
  getCtcConfig,
  getEmployeeCompensations,
  getOrgMembers,
  rejectBankDetails,
  saveCtcConfig,
  updateCompensationTemplate,
  type BankVerification,
  type CompensationTemplate,
  type CtcConfig,
  type EmployeeCompensation,
  type OrgMember,
} from "../../src/admin";
import { makeStyles } from "./compensation.styles";

/* ── Constants mirroring web CompensationSetup ── */

type Component = {
  key: string;
  label: string;
  type: string;
  calc_type?: string;
  taxable?: boolean;
};

const DEFAULT_COMPONENTS: Component[] = [
  { key: "basic", label: "Basic Salary", type: "earning", calc_type: "fixed", taxable: true },
  { key: "hra", label: "HRA", type: "earning", calc_type: "fixed", taxable: true },
  { key: "conveyance", label: "Conveyance Allowance", type: "earning", calc_type: "fixed", taxable: false },
  { key: "special_allowance", label: "Special Allowance", type: "earning", calc_type: "fixed", taxable: true },
  { key: "_ded_pf", label: "Provident Fund", type: "deduction", calc_type: "fixed", taxable: false },
  { key: "_ded_professional_tax", label: "Professional Tax", type: "deduction", calc_type: "fixed", taxable: false },
  { key: "_ded_tds", label: "Income Tax (TDS)", type: "deduction", calc_type: "fixed", taxable: false },
];

const CTC_DEFAULTS: CtcConfig = {
  basic_pct: 40,
  hra_pct: 50,
  conveyance_pct: 5,
  pf_pct: 12,
  pf_max: 1800,
  pt_fixed: 200,
};

function calcFromCtc(
  ctcAnnual: number,
  config: CtcConfig | null,
  currentComponents: Record<string, any>,
) {
  const cfg = config || CTC_DEFAULTS;
  const monthly = Math.round(ctcAnnual / 12);
  const basic = Math.round((monthly * Number(cfg.basic_pct)) / 100);
  const hra = Math.round((basic * Number(cfg.hra_pct)) / 100);
  const conveyance = Math.round((monthly * Number(cfg.conveyance_pct)) / 100);
  const specialAllowance = Math.max(0, monthly - basic - hra - conveyance);
  const pf = Math.min(Number(cfg.pf_max), Math.round((basic * Number(cfg.pf_pct)) / 100));
  const ctcMap: Record<string, number> = {
    basic,
    hra,
    conveyance,
    special_allowance: specialAllowance,
    _ded_pf: pf,
    _ded_professional_tax: Number(cfg.pt_fixed),
    _ded_tds: 0,
  };
  const updated: Record<string, any> = { ...currentComponents };
  Object.keys(updated).forEach((key) => {
    if (ctcMap[key] !== undefined) updated[key] = ctcMap[key];
  });
  return { base_salary: monthly, components: updated };
}

function fmtMoney(v?: number | string | null): string {
  if (v == null || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return "₹" + n.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function parseComponents(
  raw: CompensationTemplate["components"],
): Component[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as unknown as Component[];
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const TABS = [
  { key: "templates", label: "Templates", icon: LayoutTemplate },
  { key: "employees", label: "Employees", icon: Users },
  { key: "ctc", label: "CTC Settings", icon: SettingsIcon },
  { key: "bank", label: "Bank", icon: Building2 },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export default function CompensationScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const kbInset = useKeyboardInset();
  const [tab, setTab] = useState<TabKey>("templates");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [templates, setTemplates] = useState<CompensationTemplate[]>([]);
  const [employees, setEmployees] = useState<EmployeeCompensation[]>([]);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [bankVerifications, setBankVerifications] = useState<BankVerification[]>(
    [],
  );
  const [ctcConfig, setCtcConfig] = useState<CtcConfig>(CTC_DEFAULTS);

  /* ── Template modal ── */
  const [tmplModal, setTmplModal] = useState(false);
  const [editingTmpl, setEditingTmpl] = useState<CompensationTemplate | null>(
    null,
  );
  const [tmplName, setTmplName] = useState("");
  const [tmplDesc, setTmplDesc] = useState("");
  const [tmplDefault, setTmplDefault] = useState(false);
  const [tmplComponents, setTmplComponents] =
    useState<Component[]>(DEFAULT_COMPONENTS);

  /* ── Assign modal ── */
  const [assignModal, setAssignModal] = useState(false);
  const [assignEmp, setAssignEmp] = useState<EmployeeCompensation | null>(null);
  const [assignUserId, setAssignUserId] = useState<string | number | null>(null);
  const [assignCtc, setAssignCtc] = useState("");
  const [assignBase, setAssignBase] = useState("");
  const [assignEffective, setAssignEffective] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [assignTemplateId, setAssignTemplateId] = useState<
    string | number | null
  >(null);
  const [assignComponents, setAssignComponents] = useState<
    Record<string, any>
  >({});

  /* ── CTC config form ── */
  const [ctcForm, setCtcForm] = useState<CtcConfig>(CTC_DEFAULTS);

  const load = useCallback(async () => {
    setLoading(true);
    const [tmplR, empR, memR, bankR, ctcR] = await Promise.allSettled([
      getCompensationTemplates(),
      getEmployeeCompensations(),
      getOrgMembers({ perPage: 500 }),
      getBankVerifications(),
      getCtcConfig(),
    ]);
    if (tmplR.status === "fulfilled")
      setTemplates(Array.isArray(tmplR.value.data) ? tmplR.value.data : []);
    if (empR.status === "fulfilled")
      setEmployees(Array.isArray(empR.value.data) ? empR.value.data : []);
    if (memR.status === "fulfilled")
      setMembers(memR.value.data?.data ?? []);
    if (bankR.status === "fulfilled")
      setBankVerifications(
        Array.isArray(bankR.value.data) ? bankR.value.data : [],
      );
    if (ctcR.status === "fulfilled" && ctcR.value.data) {
      setCtcConfig(ctcR.value.data);
      setCtcForm(ctcR.value.data);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /* ── Templates ── */

  function openCreateTemplate() {
    setEditingTmpl(null);
    setTmplName("");
    setTmplDesc("");
    setTmplDefault(false);
    setTmplComponents(DEFAULT_COMPONENTS);
    setTmplModal(true);
  }

  function openEditTemplate(t: CompensationTemplate) {
    setEditingTmpl(t);
    setTmplName(t.name);
    setTmplDesc(t.description || "");
    setTmplDefault(!!t.is_default);
    setTmplComponents(parseComponents(t.components));
    setTmplModal(true);
  }

  function addTmplComponent() {
    setTmplComponents((c) => [
      ...c,
      { key: "", label: "", type: "earning", calc_type: "fixed", taxable: false },
    ]);
  }

  function updateTmplComponent(idx: number, field: keyof Component, value: any) {
    setTmplComponents((c) =>
      c.map((comp, i) => (i === idx ? { ...comp, [field]: value } : comp)),
    );
  }

  function removeTmplComponent(idx: number) {
    setTmplComponents((c) => c.filter((_, i) => i !== idx));
  }

  async function saveTemplate() {
    if (!tmplName.trim()) {
      Alert.alert("Required", "Template name is required");
      return;
    }
    const comps = tmplComponents.filter((c) => c.key.trim() && c.label.trim());
    if (comps.length === 0) {
      Alert.alert("Required", "Add at least one component with key and label");
      return;
    }
    setBusy(true);
    try {
      if (editingTmpl) {
        await updateCompensationTemplate(editingTmpl.id, {
          name: tmplName.trim(),
          description: tmplDesc.trim(),
          components: comps,
          is_default: tmplDefault,
        });
      } else {
        await createCompensationTemplate({
          name: tmplName.trim(),
          description: tmplDesc.trim(),
          components: comps,
          is_default: tmplDefault,
        });
      }
      setTmplModal(false);
      load();
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to save template");
    } finally {
      setBusy(false);
    }
  }

  function confirmDeleteTemplate(t: CompensationTemplate) {
    Alert.alert("Delete template", `Delete "${t.name}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          deleteCompensationTemplate(t.id)
            .then(() => load())
            .catch((e: any) =>
              Alert.alert(
                "Error",
                e?.response?.data?.error || "Cannot delete template",
              ),
            ),
      },
    ]);
  }

  /* ── Assign compensation ── */

  function openAssignNew() {
    setAssignEmp(null);
    setAssignUserId(null);
    setAssignCtc("");
    setAssignBase("");
    setAssignEffective(new Date().toISOString().slice(0, 10));
    setAssignTemplateId(null);
    setAssignComponents({});
    setAssignModal(true);
  }

  function openAssignEdit(emp: EmployeeCompensation) {
    setAssignEmp(emp);
    setAssignUserId(emp.user_id);
    setAssignCtc(
      emp.annual_ctc != null && Number(emp.annual_ctc) > 0
        ? String(emp.annual_ctc)
        : "",
    );
    setAssignBase(
      (emp as any).base_salary != null ? String((emp as any).base_salary) : "",
    );
    setAssignEffective(new Date().toISOString().slice(0, 10));
    setAssignTemplateId(emp.template_id ?? null);
    setAssignComponents(((emp as any).components as Record<string, any>) || {});
    setAssignModal(true);
  }

  function applyCtc(value: string) {
    setAssignCtc(value);
    const ctc = parseFloat(value) || 0;
    if (ctc > 0) {
      const { base_salary, components } = calcFromCtc(
        ctc,
        ctcConfig,
        assignComponents,
      );
      setAssignBase(String(base_salary));
      setAssignComponents(components);
    }
  }

  function applyTemplate(tid: string | number | null) {
    setAssignTemplateId(tid);
    if (tid) {
      const tmpl = templates.find((t) => String(t.id) === String(tid));
      if (tmpl) {
        const comps: Record<string, number> = {};
        parseComponents(tmpl.components).forEach((c) => {
          if (c.key) comps[c.key] = 0;
        });
        const ctc = parseFloat(assignCtc) || 0;
        if (ctc > 0) {
          const { base_salary, components } = calcFromCtc(ctc, ctcConfig, comps);
          setAssignBase(String(base_salary));
          setAssignComponents(components);
        } else {
          setAssignComponents(comps);
        }
      }
    }
  }

  async function saveAssign() {
    const userId = assignEmp?.user_id ?? assignUserId;
    if (!userId) {
      Alert.alert("Required", "Please select an employee");
      return;
    }
    const base = Number(assignBase);
    if (!assignBase || !Number.isFinite(base) || base <= 0) {
      Alert.alert("Required", "Enter a valid monthly base salary");
      return;
    }
    if (!assignEffective) {
      Alert.alert("Required", "Effective date is required");
      return;
    }
    setBusy(true);
    try {
      await assignCompensation(userId, {
        effective_from: assignEffective,
        base_salary: base,
        ctc_annual: assignCtc ? Number(assignCtc) : 0,
        template_id: assignTemplateId ? Number(assignTemplateId) : null,
        components: assignComponents,
      });
      setAssignModal(false);
      load();
    } catch (e: any) {
      Alert.alert(
        "Error",
        e?.response?.data?.error || "Failed to assign compensation",
      );
    } finally {
      setBusy(false);
    }
  }

  /* ── CTC config ── */

  async function saveCtc() {
    setBusy(true);
    try {
      const r = await saveCtcConfig(ctcForm);
      if (r.data) {
        setCtcConfig(r.data);
        setCtcForm(r.data);
      }
      Alert.alert("Saved", "CTC settings updated");
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to save CTC config");
    } finally {
      setBusy(false);
    }
  }

  /* ── Bank verifications ── */

  function approveBank(b: BankVerification) {
    approveBankDetails(b.user_id)
      .then(() => load())
      .catch((e: any) =>
        Alert.alert("Error", e?.response?.data?.error || "Failed to approve"),
      );
  }

  function rejectBank(b: BankVerification) {
    Alert.alert("Reject bank detail", `Reject ${b.full_name || "this"}?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Reject",
        style: "destructive",
        onPress: () =>
          rejectBankDetails(b.user_id)
            .then(() => load())
            .catch((e: any) =>
              Alert.alert("Error", e?.response?.data?.error || "Failed to reject"),
            ),
      },
    ]);
  }

  const pendingBank = bankVerifications.filter((b) => !b.is_verified).length;

  const templateOptions: DropdownOption[] = [
    { value: null, label: "— No template —" },
    ...templates.map((t) => ({ value: t.id, label: t.name })),
  ];

  const memberOptions: DropdownOption[] = [
    { value: null, label: "Select an employee" },
    ...members
      .filter(
        (m) =>
          m.is_active !== false &&
          !employees.some((e) => e.user_id === m.id),
      )
      .map((m) => ({
        value: m.id,
        label: `${m.full_name || m.name || m.username}`,
      })),
  ];

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Stack.Screen options={{ title: "Compensation" }} />
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Compensation" }} />

      {/* Tab bar */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.tabBarScroll}
        contentContainerStyle={styles.tabBar}
      >
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <Pressable
              key={t.key}
              style={[styles.tabBtn, active && styles.tabBtnActive]}
              onPress={() => setTab(t.key)}
            >
              <t.icon
                size={14}
                color={active ? theme.primary : theme.textSecondary}
              />
              <Text style={[styles.tabText, active && styles.tabTextActive]}>
                {t.label}
              </Text>
              {t.key === "bank" && pendingBank > 0 ? (
                <View style={styles.tabBadge}>
                  <Text style={styles.tabBadgeText}>{pendingBank}</Text>
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[styles.content, { paddingBottom: 40 + kbInset }]}
      >
        {/* ── Templates ── */}
        {tab === "templates" ? (
          <>
            <Pressable style={styles.primaryBtn} onPress={openCreateTemplate}>
              <Plus size={16} color="#fff" />
              <Text style={styles.primaryBtnText}>New template</Text>
            </Pressable>
            {templates.length === 0 ? (
              <Text style={styles.empty}>No templates yet.</Text>
            ) : (
              templates.map((t) => (
                <View key={t.id} style={styles.card}>
                  <View style={styles.iconWrap}>
                    <LayoutTemplate size={18} color={theme.primary} />
                  </View>
                  <View style={styles.body}>
                    <Text style={styles.name}>
                      {t.name}
                      {t.is_default ? "  ·  default" : ""}
                    </Text>
                    <Text style={styles.meta}>
                      {parseComponents(t.components).length} components
                      {t.description ? ` · ${t.description}` : ""}
                    </Text>
                  </View>
                  <Pressable
                    style={styles.iconBtn}
                    onPress={() => openEditTemplate(t)}
                    hitSlop={6}
                  >
                    <Pencil size={16} color={theme.textSecondary} />
                  </Pressable>
                  <Pressable
                    style={styles.iconBtn}
                    onPress={() => confirmDeleteTemplate(t)}
                    hitSlop={6}
                  >
                    <Trash2 size={16} color={theme.danger} />
                  </Pressable>
                </View>
              ))
            )}
          </>
        ) : null}

        {/* ── Employees ── */}
        {tab === "employees" ? (
          <>
            <Pressable style={styles.primaryBtn} onPress={openAssignNew}>
              <Plus size={16} color="#fff" />
              <Text style={styles.primaryBtnText}>Assign compensation</Text>
            </Pressable>
            {employees.length === 0 ? (
              <Text style={styles.empty}>
                No compensation records. Assign salary to employees.
              </Text>
            ) : (
              employees.map((emp) => (
                <View key={emp.user_id} style={styles.card}>
                  <View style={styles.iconWrap}>
                    <Wallet size={18} color={theme.primary} />
                  </View>
                  <View style={styles.body}>
                    <Text style={styles.name} numberOfLines={1}>
                      {emp.full_name || emp.username}
                    </Text>
                    <Text style={styles.meta} numberOfLines={1}>
                      {Number(emp.annual_ctc) > 0
                        ? `CTC ${fmtMoney(emp.annual_ctc)}/yr`
                        : "No CTC set"}
                      {(emp as any).base_salary
                        ? ` · Base ${fmtMoney((emp as any).base_salary)}/mo`
                        : ""}
                      {emp.department_name ? ` · ${emp.department_name}` : ""}
                    </Text>
                  </View>
                  <Pressable
                    style={styles.iconBtn}
                    onPress={() => openAssignEdit(emp)}
                    hitSlop={6}
                  >
                    <Pencil size={16} color={theme.textSecondary} />
                  </Pressable>
                </View>
              ))
            )}
          </>
        ) : null}

        {/* ── CTC Settings ── */}
        {tab === "ctc" ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>CTC Breakdown Settings</Text>
            <Text style={styles.hint}>
              These percentages auto-calculate monthly component amounts when an
              Annual CTC is entered during compensation assignment.
            </Text>
            <Text style={styles.fieldLabel}>Basic — % of Monthly CTC</Text>
            <TextInput
              style={styles.input}
              value={String(ctcForm.basic_pct)}
              onChangeText={(v) =>
                setCtcForm((f) => ({ ...f, basic_pct: Number(v) || 0 }))
              }
              keyboardType="numeric"
              placeholderTextColor={theme.textMuted}
            />
            <Text style={styles.fieldLabel}>HRA — % of Basic</Text>
            <TextInput
              style={styles.input}
              value={String(ctcForm.hra_pct)}
              onChangeText={(v) =>
                setCtcForm((f) => ({ ...f, hra_pct: Number(v) || 0 }))
              }
              keyboardType="numeric"
              placeholderTextColor={theme.textMuted}
            />
            <Text style={styles.fieldLabel}>Conveyance — % of Monthly CTC</Text>
            <TextInput
              style={styles.input}
              value={String(ctcForm.conveyance_pct)}
              onChangeText={(v) =>
                setCtcForm((f) => ({ ...f, conveyance_pct: Number(v) || 0 }))
              }
              keyboardType="numeric"
              placeholderTextColor={theme.textMuted}
            />
            <Text style={styles.fieldLabel}>PF — % of Basic</Text>
            <TextInput
              style={styles.input}
              value={String(ctcForm.pf_pct)}
              onChangeText={(v) =>
                setCtcForm((f) => ({ ...f, pf_pct: Number(v) || 0 }))
              }
              keyboardType="numeric"
              placeholderTextColor={theme.textMuted}
            />
            <Text style={styles.fieldLabel}>PF Maximum Cap (₹/month)</Text>
            <TextInput
              style={styles.input}
              value={String(ctcForm.pf_max)}
              onChangeText={(v) =>
                setCtcForm((f) => ({ ...f, pf_max: Number(v) || 0 }))
              }
              keyboardType="numeric"
              placeholderTextColor={theme.textMuted}
            />
            <Text style={styles.fieldLabel}>
              Professional Tax — Fixed (₹/month)
            </Text>
            <TextInput
              style={styles.input}
              value={String(ctcForm.pt_fixed)}
              onChangeText={(v) =>
                setCtcForm((f) => ({ ...f, pt_fixed: Number(v) || 0 }))
              }
              keyboardType="numeric"
              placeholderTextColor={theme.textMuted}
            />
            <Text style={styles.hint}>
              Special Allowance is the remaining balance after Basic, HRA, and
              Conveyance. TDS defaults to ₹0 and can be set per employee.
            </Text>
            <Pressable style={styles.saveBtn} onPress={saveCtc} disabled={busy}>
              <Text style={styles.saveBtnText}>
                {busy ? "Saving…" : "Save settings"}
              </Text>
            </Pressable>
          </View>
        ) : null}

        {/* ── Bank Verifications ── */}
        {tab === "bank" ? (
          bankVerifications.length === 0 ? (
            <Text style={styles.empty}>No bank details submitted yet.</Text>
          ) : (
            bankVerifications.map((b) => (
              <View key={b.id} style={styles.card}>
                <View style={styles.iconWrap}>
                  <Building2 size={18} color={theme.primary} />
                </View>
                <View style={styles.body}>
                  <Text style={styles.name} numberOfLines={1}>
                    {b.full_name || b.account_holder_name}
                  </Text>
                  <Text style={styles.meta} numberOfLines={1}>
                    {b.account_number} · {b.ifsc_code}
                    {b.bank_name ? ` · ${b.bank_name}` : ""}
                  </Text>
                  <Text
                    style={[
                      styles.statusText,
                      {
                        color: b.is_verified ? theme.success : theme.warning,
                      },
                    ]}
                  >
                    {b.is_verified ? "Verified" : "Pending"}
                  </Text>
                </View>
                {!b.is_verified ? (
                  <>
                    <Pressable
                      style={styles.iconBtn}
                      onPress={() => approveBank(b)}
                      hitSlop={6}
                    >
                      <Check size={18} color={theme.success} />
                    </Pressable>
                    <Pressable
                      style={styles.iconBtn}
                      onPress={() => rejectBank(b)}
                      hitSlop={6}
                    >
                      <X size={18} color={theme.danger} />
                    </Pressable>
                  </>
                ) : null}
              </View>
            ))
          )
        ) : null}
      </ScrollView>

      {/* ── Template modal ── */}
      <Modal
        visible={tmplModal}
        transparent
        animationType="slide"
        onRequestClose={() => setTmplModal(false)}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <Pressable
            style={styles.modalScrim}
            onPress={() => setTmplModal(false)}
          />
          <View style={[styles.sheet, { marginBottom: kbInset }]}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>
                {editingTmpl ? "Edit template" : "New template"}
              </Text>
              <Pressable onPress={() => setTmplModal(false)} hitSlop={8}>
                <X size={22} color={theme.textSecondary} />
              </Pressable>
            </View>
            <ScrollView style={{ maxHeight: 460 }}>
              <Text style={styles.fieldLabel}>Name</Text>
              <TextInput
                style={styles.input}
                value={tmplName}
                onChangeText={setTmplName}
                placeholder="e.g. Standard"
                placeholderTextColor={theme.textMuted}
              />
              <Text style={styles.fieldLabel}>Description (optional)</Text>
              <TextInput
                style={styles.input}
                value={tmplDesc}
                onChangeText={setTmplDesc}
                placeholder="Description"
                placeholderTextColor={theme.textMuted}
              />
              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>Default template</Text>
                <Switch
                  value={tmplDefault}
                  onValueChange={setTmplDefault}
                  trackColor={{ true: theme.primary, false: theme.surface }}
                  thumbColor="#fff"
                />
              </View>
              <Text style={[styles.fieldLabel, { marginTop: 8 }]}>
                Components
              </Text>
              {tmplComponents.map((comp, idx) => (
                <View key={idx} style={styles.compRow}>
                  <TextInput
                    style={[styles.input, styles.compInput]}
                    value={comp.key}
                    onChangeText={(v) => updateTmplComponent(idx, "key", v)}
                    placeholder="key"
                    placeholderTextColor={theme.textMuted}
                    autoCapitalize="none"
                  />
                  <TextInput
                    style={[styles.input, styles.compInput]}
                    value={comp.label}
                    onChangeText={(v) => updateTmplComponent(idx, "label", v)}
                    placeholder="Label"
                    placeholderTextColor={theme.textMuted}
                  />
                  <Pressable
                    style={[
                      styles.typeChip,
                      comp.type === "deduction" && styles.typeChipDed,
                    ]}
                    onPress={() =>
                      updateTmplComponent(
                        idx,
                        "type",
                        comp.type === "earning" ? "deduction" : "earning",
                      )
                    }
                  >
                    <Text style={styles.typeChipText}>
                      {comp.type === "deduction" ? "Ded" : "Earn"}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => removeTmplComponent(idx)}
                    hitSlop={6}
                  >
                    <Trash2 size={16} color={theme.danger} />
                  </Pressable>
                </View>
              ))}
              <Pressable style={styles.addBtn} onPress={addTmplComponent}>
                <Plus size={14} color={theme.primary} />
                <Text style={styles.addBtnText}>Add component</Text>
              </Pressable>
            </ScrollView>
            <Pressable
              style={styles.saveBtn}
              onPress={saveTemplate}
              disabled={busy}
            >
              <Text style={styles.saveBtnText}>
                {busy ? "Saving…" : editingTmpl ? "Save changes" : "Create"}
              </Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Assign modal ── */}
      <Modal
        visible={assignModal}
        transparent
        animationType="slide"
        onRequestClose={() => setAssignModal(false)}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <Pressable
            style={styles.modalScrim}
            onPress={() => setAssignModal(false)}
          />
          <View style={[styles.sheet, { marginBottom: kbInset }]}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle} numberOfLines={1}>
                {assignEmp
                  ? assignEmp.full_name || assignEmp.username
                  : "Assign compensation"}
              </Text>
              <Pressable onPress={() => setAssignModal(false)} hitSlop={8}>
                <X size={22} color={theme.textSecondary} />
              </Pressable>
            </View>
            <ScrollView style={{ maxHeight: 460 }}>
              {!assignEmp ? (
                <>
                  <Text style={styles.fieldLabel}>Employee</Text>
                  <Dropdown
                    label="Employee"
                    value={assignUserId}
                    options={memberOptions}
                    onChange={setAssignUserId}
                  />
                </>
              ) : null}
              <Text style={styles.fieldLabel}>Annual CTC (₹)</Text>
              <TextInput
                style={styles.input}
                value={assignCtc}
                onChangeText={applyCtc}
                placeholder="e.g. 600000 — auto-fills fields below"
                placeholderTextColor={theme.textMuted}
                keyboardType="numeric"
              />
              <Text style={styles.fieldLabel}>Effective from (YYYY-MM-DD)</Text>
              <TextInput
                style={styles.input}
                value={assignEffective}
                onChangeText={setAssignEffective}
                placeholder="2026-01-01"
                placeholderTextColor={theme.textMuted}
                autoCapitalize="none"
              />
              <Text style={styles.fieldLabel}>Base Salary (Monthly ₹)</Text>
              <TextInput
                style={styles.input}
                value={assignBase}
                onChangeText={setAssignBase}
                placeholder="Monthly base"
                placeholderTextColor={theme.textMuted}
                keyboardType="numeric"
              />
              <Text style={styles.fieldLabel}>Template</Text>
              <Dropdown
                label="Template"
                value={assignTemplateId}
                options={templateOptions}
                onChange={applyTemplate}
              />
              {Object.keys(assignComponents).length > 0 ? (
                <>
                  <Text style={[styles.fieldLabel, { marginTop: 8 }]}>
                    Component amounts (Monthly ₹)
                  </Text>
                  {Object.entries(assignComponents).map(([key, val]) => (
                    <View key={key} style={styles.compRow}>
                      <Text style={styles.compLabel}>
                        {key.replace(/_ded_/, "").replace(/_/g, " ")}
                      </Text>
                      <TextInput
                        style={[styles.input, { flex: 1 }]}
                        value={String(val)}
                        onChangeText={(v) =>
                          setAssignComponents((c) => ({
                            ...c,
                            [key]: v === "" ? "" : Number(v),
                          }))
                        }
                        keyboardType="numeric"
                        placeholderTextColor={theme.textMuted}
                      />
                    </View>
                  ))}
                </>
              ) : null}
            </ScrollView>
            <Pressable
              style={styles.saveBtn}
              onPress={saveAssign}
              disabled={busy}
            >
              <Text style={styles.saveBtnText}>
                {busy ? "Saving…" : "Save compensation"}
              </Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}
