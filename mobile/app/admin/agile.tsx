import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack } from "expo-router";
import {
  CircleDot,
  Pencil,
  Plus,
  Shapes,
  SlidersHorizontal,
  Trash2,
  Workflow,
  X,
} from "lucide-react-native";
import { theme } from "../../src/theme";
import { useKeyboardInset } from "../../src/hooks/useKeyboardInset";
import { Dropdown } from "../../src/components/Dropdown";
import {
  createWorkItemType,
  createWorkflowState,
  deleteWorkItemType,
  deleteWorkflowState,
  getAgilePermissions,
  getAgileSettings,
  getWorkItemTypes,
  getWorkflowStates,
  updateAgileSettings,
  updateWorkItemType,
  updateWorkflowState,
  type AgileSettings,
  type AgileWorkItemType,
  type AgileWorkflowState,
} from "../../src/admin";

const ESTIMATION_TYPES = [
  { value: "fibonacci", label: "Fibonacci (0.5, 1, 2, 3, 5, 8…)" },
  { value: "linear", label: "Linear (1–10)" },
  { value: "tshirt", label: "T-shirt (XS, S, M, L, XL)" },
  { value: "hours", label: "Hours" },
  { value: "none", label: "No estimation" },
  { value: "custom", label: "Custom" },
];

const ESTIMATION_PRESETS: Record<string, (number | string)[]> = {
  fibonacci: [0.5, 1, 2, 3, 5, 8, 13, 21, 34],
  linear: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  tshirt: ["XS", "S", "M", "L", "XL", "XXL"],
  hours: [1, 2, 4, 8, 16, 24, 40],
  none: [],
  custom: [],
};

const STATE_CATEGORIES = [
  { value: "open", label: "Open / To Do" },
  { value: "in_progress", label: "In Progress" },
  { value: "in_review", label: "In Review" },
  { value: "done", label: "Done" },
];

// Mirrors the web GeneralTab feature list (incl. retrospectives).
const FEATURE_FLAGS: Array<{ key: keyof AgileSettings; label: string }> = [
  { key: "enable_story_points", label: "Story points" },
  { key: "enable_epics", label: "Epics & parent links" },
  { key: "enable_dependencies", label: "Dependencies / blocked-by" },
  { key: "enable_acceptance_criteria", label: "Acceptance criteria" },
  { key: "enable_blockers", label: "Blocker badges" },
  { key: "enable_wip_limits", label: "WIP limits per column" },
  { key: "enable_retrospectives", label: "Sprint retrospectives" },
  { key: "require_estimate_for_sprint", label: "Require estimate for sprint" },
];

const COLOR_PRESETS = [
  "#6366f1",
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#6b7280",
];

function valuesToString(v: AgileSettings["estimation_values"]): string {
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.join(", ");
    } catch {
      return v;
    }
  }
  return "";
}

function stringToValues(s: string): (number | string)[] {
  return s
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => (isNaN(Number(v)) ? v : Number(v)));
}

export default function AgileConfigScreen() {
  const kbInset = useKeyboardInset();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [settings, setSettings] = useState<AgileSettings | null>(null);
  const [types, setTypes] = useState<AgileWorkItemType[]>([]);
  const [states, setStates] = useState<AgileWorkflowState[]>([]);
  const [busy, setBusy] = useState(false);

  // Local editable copies for the General section (saved with a button, like web).
  const [estType, setEstType] = useState("fibonacci");
  const [estValues, setEstValues] = useState("");
  const [estUnit, setEstUnit] = useState("");
  const [dod, setDod] = useState("");
  const [generalDirty, setGeneralDirty] = useState(false);

  // Work item type modal state
  const [typeModal, setTypeModal] = useState(false);
  const [editingType, setEditingType] = useState<AgileWorkItemType | null>(null);
  const [typeName, setTypeName] = useState("");
  const [typeIcon, setTypeIcon] = useState("");
  const [typeColor, setTypeColor] = useState(COLOR_PRESETS[0]);
  const [typeIsEpic, setTypeIsEpic] = useState(false);
  const [typeIsDefault, setTypeIsDefault] = useState(false);
  const [typeIsActive, setTypeIsActive] = useState(true);

  // Workflow state modal state
  const [stateModal, setStateModal] = useState(false);
  const [editingState, setEditingState] = useState<AgileWorkflowState | null>(
    null,
  );
  const [stateName, setStateName] = useState("");
  const [stateCategory, setStateCategory] = useState<string | number | null>(
    "open",
  );
  const [stateColor, setStateColor] = useState(COLOR_PRESETS[6]);
  const [stateWip, setStateWip] = useState("");
  const [stateInitial, setStateInitial] = useState(false);
  const [stateTerminal, setStateTerminal] = useState(false);
  const [stateActive, setStateActive] = useState(true);

  const syncGeneral = useCallback((s: AgileSettings | null) => {
    if (!s) return;
    setEstType(s.estimation_type ?? "fibonacci");
    setEstValues(valuesToString(s.estimation_values));
    setEstUnit(s.estimation_unit_label ?? "");
    setDod(s.default_dod ?? "");
    setGeneralDirty(false);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [setR, typR, staR, permR] = await Promise.allSettled([
      getAgileSettings(),
      getWorkItemTypes(),
      getWorkflowStates(),
      getAgilePermissions(),
    ]);
    if (setR.status === "fulfilled") {
      setSettings(setR.value.data);
      syncGeneral(setR.value.data);
    } else {
      const e = setR.reason as any;
      setError(e?.response?.data?.error || "Failed to load Agile settings");
    }
    if (typR.status === "fulfilled")
      setTypes(Array.isArray(typR.value.data) ? typR.value.data : []);
    if (staR.status === "fulfilled")
      setStates(Array.isArray(staR.value.data) ? staR.value.data : []);
    if (permR.status === "fulfilled") setCanEdit(!!permR.value.data?.canEdit);
    setLoading(false);
  }, [syncGeneral]);

  useEffect(() => {
    load();
  }, [load]);

  /* ── Feature toggles (instant save with verify-after-write) ── */

  async function patchSettings(patch: Partial<AgileSettings>) {
    if (!canEdit) return;
    const prev = settings;
    setBusy(true);
    // Optimistic update for snappy toggles.
    setSettings((s) => (s ? { ...s, ...patch } : s));
    try {
      const r = await updateAgileSettings(patch);
      if (r.data) {
        setSettings(r.data);
        syncGeneral(r.data);
      }
    } catch (e: any) {
      // Verify-after-write: re-fetch and confirm whether the patch actually
      // applied before showing a (potentially false) failure popup.
      try {
        const r = await getAgileSettings();
        const fresh = r.data;
        const applied =
          fresh &&
          Object.entries(patch).every(
            ([k, v]) => (fresh as any)[k] === v,
          );
        if (applied) {
          setSettings(fresh);
          syncGeneral(fresh);
          setBusy(false);
          return;
        }
      } catch {
        /* fall through */
      }
      // Roll back the optimistic change and report.
      setSettings(prev);
      Alert.alert("Error", e?.response?.data?.error || "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  async function saveGeneral() {
    if (!canEdit) return;
    setBusy(true);
    const patch: Partial<AgileSettings> = {
      estimation_type: estType,
      estimation_values:
        estType === "none"
          ? []
          : estType !== "custom"
            ? ESTIMATION_PRESETS[estType] ?? stringToValues(estValues)
            : stringToValues(estValues),
      estimation_unit_label: estUnit,
      default_dod: dod,
    };
    try {
      const r = await updateAgileSettings(patch);
      if (r.data) {
        setSettings(r.data);
        syncGeneral(r.data);
      }
      setGeneralDirty(false);
      Alert.alert("Saved", "Agile settings updated");
    } catch (e: any) {
      try {
        const r = await getAgileSettings();
        const fresh = r.data;
        if (fresh && fresh.estimation_type === patch.estimation_type) {
          setSettings(fresh);
          syncGeneral(fresh);
          setGeneralDirty(false);
          setBusy(false);
          return;
        }
      } catch {
        /* fall through */
      }
      Alert.alert("Error", e?.response?.data?.error || "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  function changeEstType(v: string) {
    setEstType(v);
    setGeneralDirty(true);
    if (v !== "custom" && ESTIMATION_PRESETS[v] !== undefined) {
      setEstValues(ESTIMATION_PRESETS[v].join(", "));
    }
  }

  /* ── Work item types ── */

  function openCreateType() {
    setEditingType(null);
    setTypeName("");
    setTypeIcon("");
    setTypeColor(COLOR_PRESETS[0]);
    setTypeIsEpic(false);
    setTypeIsDefault(false);
    setTypeIsActive(true);
    setTypeModal(true);
  }

  function openEditType(t: AgileWorkItemType) {
    setEditingType(t);
    setTypeName(t.name);
    setTypeIcon(t.icon || "");
    setTypeColor(t.color || COLOR_PRESETS[0]);
    setTypeIsEpic(!!t.is_epic);
    setTypeIsDefault(!!t.is_default);
    setTypeIsActive(t.is_active !== false);
    setTypeModal(true);
  }

  async function saveType() {
    if (!typeName.trim()) {
      Alert.alert("Required", "Name is required");
      return;
    }
    setBusy(true);
    try {
      if (editingType) {
        await updateWorkItemType(editingType.id, {
          name: typeName.trim(),
          icon: typeIcon.trim() || null,
          color: typeColor,
          is_epic: typeIsEpic,
          is_default: typeIsDefault,
          is_active: typeIsActive,
        });
      } else {
        await createWorkItemType({
          name: typeName.trim(),
          icon: typeIcon.trim() || undefined,
          color: typeColor,
          is_epic: typeIsEpic,
          is_default: typeIsDefault,
        });
      }
      setTypeModal(false);
      load();
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  function confirmDeleteType(t: AgileWorkItemType) {
    Alert.alert(
      "Delete type",
      `Delete "${t.name}"? This will fail if any tasks still use it.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () =>
            deleteWorkItemType(t.id)
              .then(() => load())
              .catch((e: any) =>
                Alert.alert(
                  "Error",
                  e?.response?.data?.error || "Failed to delete",
                ),
              ),
        },
      ],
    );
  }

  /* ── Workflow states ── */

  function openCreateState() {
    setEditingState(null);
    setStateName("");
    setStateCategory("open");
    setStateColor(COLOR_PRESETS[6]);
    setStateWip("");
    setStateInitial(false);
    setStateTerminal(false);
    setStateActive(true);
    setStateModal(true);
  }

  function openEditState(s: AgileWorkflowState) {
    setEditingState(s);
    setStateName(s.name);
    setStateCategory(s.category);
    setStateColor(s.color || COLOR_PRESETS[6]);
    setStateWip(s.wip_limit != null ? String(s.wip_limit) : "");
    setStateInitial(!!s.is_initial);
    setStateTerminal(!!s.is_terminal);
    setStateActive(s.is_active !== false);
    setStateModal(true);
  }

  async function saveState() {
    if (!stateName.trim()) {
      Alert.alert("Required", "Name is required");
      return;
    }
    const wip = stateWip.trim() === "" ? null : parseInt(stateWip, 10);
    setBusy(true);
    try {
      if (editingState) {
        await updateWorkflowState(editingState.id, {
          name: stateName.trim(),
          category: String(stateCategory || "open"),
          color: stateColor,
          wip_limit: wip,
          is_initial: stateInitial,
          is_terminal: stateTerminal,
          is_active: stateActive,
        });
      } else {
        await createWorkflowState({
          name: stateName.trim(),
          category: String(stateCategory || "open"),
          color: stateColor,
          wip_limit: wip,
          is_initial: stateInitial,
          is_terminal: stateTerminal,
        });
      }
      setStateModal(false);
      load();
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  function confirmDeleteState(s: AgileWorkflowState) {
    Alert.alert(
      "Delete state",
      `Delete "${s.name}"? This will fail if any tasks are still in it.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () =>
            deleteWorkflowState(s.id)
              .then(() => load())
              .catch((e: any) =>
                Alert.alert(
                  "Error",
                  e?.response?.data?.error || "Failed to delete",
                ),
              ),
        },
      ],
    );
  }

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Stack.Screen options={{ title: "Agile Config" }} />
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  if (error && !settings) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Stack.Screen options={{ title: "Agile Config" }} />
        <Text style={styles.empty}>{error}</Text>
      </View>
    );
  }

  // Group states by category for coverage warnings (mirrors web).
  const grouped: Record<string, AgileWorkflowState[]> = {
    open: [],
    in_progress: [],
    in_review: [],
    done: [],
  };
  for (const s of states) {
    if (grouped[s.category]) grouped[s.category].push(s);
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.container, { paddingBottom: 48 + kbInset }]}
    >
      <Stack.Screen options={{ title: "Agile Config" }} />

      {!canEdit ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>
            Read-only — only Agile editors (super admins or granted roles) can
            change this configuration.
          </Text>
        </View>
      ) : null}

      {/* Estimation */}
      <View style={styles.section}>
        <View style={styles.sectionTitleRow}>
          <SlidersHorizontal size={15} color={theme.textSecondary} />
          <Text style={styles.sectionTitle}>Estimation</Text>
        </View>
        <Text style={styles.fieldLabel}>Scale type</Text>
        <Dropdown
          label="Estimation type"
          value={estType}
          options={ESTIMATION_TYPES}
          onChange={(v) => {
            if (v) changeEstType(String(v));
          }}
        />
        <Text style={styles.fieldLabel}>Scale values (comma-separated)</Text>
        <TextInput
          style={[styles.input, estType === "none" && styles.inputDisabled]}
          value={estValues}
          onChangeText={(v) => {
            setEstValues(v);
            setGeneralDirty(true);
          }}
          editable={canEdit && estType !== "none"}
          placeholder="0.5, 1, 2, 3, 5, 8"
          placeholderTextColor={theme.textMuted}
          autoCapitalize="none"
        />
        <Text style={styles.fieldLabel}>Unit label</Text>
        <TextInput
          style={styles.input}
          value={estUnit}
          onChangeText={(v) => {
            setEstUnit(v);
            setGeneralDirty(true);
          }}
          editable={canEdit}
          placeholder="SP"
          placeholderTextColor={theme.textMuted}
        />
        <Text style={[styles.fieldLabel, { marginTop: 10 }]}>
          Definition of Done (default)
        </Text>
        <TextInput
          style={[styles.input, styles.textArea]}
          value={dod}
          onChangeText={(v) => {
            setDod(v);
            setGeneralDirty(true);
          }}
          editable={canEdit}
          multiline
          numberOfLines={5}
          placeholder={"- Code reviewed\n- Tests pass\n- Docs updated"}
          placeholderTextColor={theme.textMuted}
        />
        {canEdit ? (
          <Pressable
            style={[styles.saveBtn, !generalDirty && styles.disabled]}
            onPress={saveGeneral}
            disabled={busy || !generalDirty}
          >
            <Text style={styles.saveBtnText}>
              {busy ? "Saving…" : "Save settings"}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {/* Feature toggles */}
      <View style={styles.section}>
        <View style={styles.sectionTitleRow}>
          <Workflow size={15} color={theme.textSecondary} />
          <Text style={styles.sectionTitle}>Features</Text>
        </View>
        {FEATURE_FLAGS.map((f) => (
          <View key={String(f.key)} style={styles.toggleRow}>
            <Text style={styles.toggleLabel}>{f.label}</Text>
            <Switch
              value={!!settings?.[f.key]}
              disabled={!canEdit || busy}
              onValueChange={(v) => patchSettings({ [f.key]: v } as any)}
              trackColor={{ true: theme.primary, false: theme.surface }}
              thumbColor="#fff"
            />
          </View>
        ))}
      </View>

      {/* Work item types */}
      <View style={styles.section}>
        <View style={styles.sectionHeaderRow}>
          <View style={styles.sectionTitleRow}>
            <Shapes size={15} color={theme.textSecondary} />
            <Text style={styles.sectionTitle}>Work item types</Text>
          </View>
          {canEdit ? (
            <Pressable style={styles.addBtn} onPress={openCreateType}>
              <Plus size={14} color={theme.primary} />
              <Text style={styles.addBtnText}>Add</Text>
            </Pressable>
          ) : null}
        </View>
        {types.length === 0 ? (
          <Text style={styles.empty}>No work item types.</Text>
        ) : (
          types.map((t) => (
            <View key={t.id} style={styles.itemRow}>
              <View
                style={[styles.colorDot, { backgroundColor: t.color || "#888" }]}
              />
              <View style={{ flex: 1 }}>
                <Text style={styles.itemName}>
                  {t.name}
                  {t.is_default ? "  ·  default" : ""}
                  {t.is_epic ? "  ·  epic" : ""}
                </Text>
                <Text style={styles.itemMeta}>
                  {t.icon ? `icon: ${t.icon}` : "no icon"}
                  {t.is_active === false ? " · inactive" : ""}
                </Text>
              </View>
              {canEdit ? (
                <>
                  <Pressable
                    style={styles.iconBtn}
                    onPress={() => openEditType(t)}
                    hitSlop={6}
                  >
                    <Pencil size={15} color={theme.textSecondary} />
                  </Pressable>
                  <Pressable
                    style={styles.iconBtn}
                    onPress={() => confirmDeleteType(t)}
                    hitSlop={6}
                  >
                    <Trash2 size={15} color={theme.danger} />
                  </Pressable>
                </>
              ) : null}
            </View>
          ))
        )}
      </View>

      {/* Workflow states */}
      <View style={styles.section}>
        <View style={styles.sectionHeaderRow}>
          <View style={styles.sectionTitleRow}>
            <CircleDot size={15} color={theme.textSecondary} />
            <Text style={styles.sectionTitle}>Workflow states</Text>
          </View>
          {canEdit ? (
            <Pressable style={styles.addBtn} onPress={openCreateState}>
              <Plus size={14} color={theme.primary} />
              <Text style={styles.addBtnText}>Add</Text>
            </Pressable>
          ) : null}
        </View>
        <Text style={styles.hint}>
          Keep at least one active state in each category: Open, In Progress, In
          Review, Done.
        </Text>
        {STATE_CATEGORIES.map((cat) => {
          const list = grouped[String(cat.value)] || [];
          return (
            <View key={String(cat.value)} style={styles.categoryGroup}>
              <Text style={styles.categoryTitle}>{cat.label}</Text>
              {list.length === 0 ? (
                <Text style={styles.warn}>
                  ⚠ No state in this category — add one to keep reporting
                  accurate.
                </Text>
              ) : (
                list.map((s) => (
                  <View key={s.id} style={styles.itemRow}>
                    <View
                      style={[
                        styles.colorDot,
                        { backgroundColor: s.color || "#888" },
                      ]}
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.itemName}>{s.name}</Text>
                      <Text style={styles.itemMeta}>
                        {s.is_initial ? "initial · " : ""}
                        {s.is_terminal ? "terminal · " : ""}
                        {s.wip_limit ? `WIP ${s.wip_limit} · ` : ""}
                        {s.is_active === false ? "inactive" : "active"}
                      </Text>
                    </View>
                    {canEdit ? (
                      <>
                        <Pressable
                          style={styles.iconBtn}
                          onPress={() => openEditState(s)}
                          hitSlop={6}
                        >
                          <Pencil size={15} color={theme.textSecondary} />
                        </Pressable>
                        <Pressable
                          style={styles.iconBtn}
                          onPress={() => confirmDeleteState(s)}
                          hitSlop={6}
                        >
                          <Trash2 size={15} color={theme.danger} />
                        </Pressable>
                      </>
                    ) : null}
                  </View>
                ))
              )}
            </View>
          );
        })}
      </View>

      {/* ── Work item type modal ── */}
      <Modal
        visible={typeModal}
        transparent
        animationType="slide"
        onRequestClose={() => setTypeModal(false)}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <Pressable
            style={styles.modalScrim}
            onPress={() => setTypeModal(false)}
          />
          <View style={[styles.sheet, { marginBottom: kbInset }]}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>
                {editingType ? "Edit type" : "New work item type"}
              </Text>
              <Pressable onPress={() => setTypeModal(false)} hitSlop={8}>
                <X size={22} color={theme.textSecondary} />
              </Pressable>
            </View>
            <ScrollView style={{ maxHeight: 460 }}>
              <Text style={styles.fieldLabel}>Name</Text>
              <TextInput
                style={styles.input}
                value={typeName}
                onChangeText={setTypeName}
                placeholder="e.g. Story"
                placeholderTextColor={theme.textMuted}
              />
              <Text style={styles.fieldLabel}>Icon name (optional)</Text>
              <TextInput
                style={styles.input}
                value={typeIcon}
                onChangeText={setTypeIcon}
                placeholder="e.g. bookmark"
                placeholderTextColor={theme.textMuted}
                autoCapitalize="none"
              />
              <Text style={styles.fieldLabel}>Color</Text>
              <View style={styles.swatchRow}>
                {COLOR_PRESETS.map((c) => (
                  <Pressable
                    key={c}
                    style={[
                      styles.swatch,
                      { backgroundColor: c },
                      typeColor === c && styles.swatchActive,
                    ]}
                    onPress={() => setTypeColor(c)}
                  />
                ))}
              </View>
              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>Epic type</Text>
                <Switch
                  value={typeIsEpic}
                  onValueChange={setTypeIsEpic}
                  trackColor={{ true: theme.primary, false: theme.surface }}
                  thumbColor="#fff"
                />
              </View>
              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>Default type</Text>
                <Switch
                  value={typeIsDefault}
                  onValueChange={setTypeIsDefault}
                  trackColor={{ true: theme.primary, false: theme.surface }}
                  thumbColor="#fff"
                />
              </View>
              {editingType ? (
                <View style={styles.toggleRow}>
                  <Text style={styles.toggleLabel}>Active</Text>
                  <Switch
                    value={typeIsActive}
                    onValueChange={setTypeIsActive}
                    trackColor={{ true: theme.primary, false: theme.surface }}
                    thumbColor="#fff"
                  />
                </View>
              ) : null}
            </ScrollView>
            <Pressable style={styles.saveBtn} onPress={saveType} disabled={busy}>
              <Text style={styles.saveBtnText}>
                {busy ? "Saving…" : editingType ? "Save changes" : "Create"}
              </Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Workflow state modal ── */}
      <Modal
        visible={stateModal}
        transparent
        animationType="slide"
        onRequestClose={() => setStateModal(false)}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <Pressable
            style={styles.modalScrim}
            onPress={() => setStateModal(false)}
          />
          <View style={[styles.sheet, { marginBottom: kbInset }]}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>
                {editingState ? "Edit state" : "New workflow state"}
              </Text>
              <Pressable onPress={() => setStateModal(false)} hitSlop={8}>
                <X size={22} color={theme.textSecondary} />
              </Pressable>
            </View>
            <ScrollView style={{ maxHeight: 460 }}>
              <Text style={styles.fieldLabel}>Name</Text>
              <TextInput
                style={styles.input}
                value={stateName}
                onChangeText={setStateName}
                placeholder="e.g. QA Review"
                placeholderTextColor={theme.textMuted}
              />
              <Text style={styles.fieldLabel}>Category</Text>
              <Dropdown
                label="Category"
                value={stateCategory}
                options={STATE_CATEGORIES}
                onChange={setStateCategory}
              />
              <Text style={styles.fieldLabel}>WIP limit (optional)</Text>
              <TextInput
                style={styles.input}
                value={stateWip}
                onChangeText={setStateWip}
                placeholder="No limit"
                placeholderTextColor={theme.textMuted}
                keyboardType="numeric"
              />
              <Text style={styles.fieldLabel}>Color</Text>
              <View style={styles.swatchRow}>
                {COLOR_PRESETS.map((c) => (
                  <Pressable
                    key={c}
                    style={[
                      styles.swatch,
                      { backgroundColor: c },
                      stateColor === c && styles.swatchActive,
                    ]}
                    onPress={() => setStateColor(c)}
                  />
                ))}
              </View>
              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>Initial (new tickets)</Text>
                <Switch
                  value={stateInitial}
                  onValueChange={setStateInitial}
                  trackColor={{ true: theme.primary, false: theme.surface }}
                  thumbColor="#fff"
                />
              </View>
              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>Terminal (counts as done)</Text>
                <Switch
                  value={stateTerminal}
                  onValueChange={setStateTerminal}
                  trackColor={{ true: theme.primary, false: theme.surface }}
                  thumbColor="#fff"
                />
              </View>
              {editingState ? (
                <View style={styles.toggleRow}>
                  <Text style={styles.toggleLabel}>Active (shown on board)</Text>
                  <Switch
                    value={stateActive}
                    onValueChange={setStateActive}
                    trackColor={{ true: theme.primary, false: theme.surface }}
                    thumbColor="#fff"
                  />
                </View>
              ) : null}
            </ScrollView>
            <Pressable
              style={styles.saveBtn}
              onPress={saveState}
              disabled={busy}
            >
              <Text style={styles.saveBtnText}>
                {busy ? "Saving…" : editingState ? "Save changes" : "Create"}
              </Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { alignItems: "center", justifyContent: "center" },
  container: { padding: 16, gap: 16 },
  banner: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radius,
    padding: 12,
  },
  bannerText: { fontSize: 12, color: theme.textSecondary, lineHeight: 17 },
  section: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusLg,
    padding: 16,
    gap: 10,
  },
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  sectionTitle: { fontSize: 15, fontWeight: "700", color: theme.text },
  fieldLabel: {
    fontSize: 12,
    color: theme.textSecondary,
    fontWeight: "500",
    marginTop: 4,
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
  inputDisabled: { opacity: 0.5 },
  textArea: { minHeight: 100, textAlignVertical: "top" },
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: theme.radiusSm,
    backgroundColor: theme.primaryGlow,
  },
  addBtnText: { fontSize: 12, fontWeight: "600", color: theme.primary },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  toggleLabel: { fontSize: 14, color: theme.text, flex: 1 },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  colorDot: { width: 12, height: 12, borderRadius: 6 },
  itemName: { fontSize: 14, fontWeight: "600", color: theme.text },
  itemMeta: { fontSize: 11, color: theme.textMuted, marginTop: 1 },
  iconBtn: { padding: 6 },
  empty: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: "center",
    paddingVertical: 12,
  },
  hint: { fontSize: 12, color: theme.textSecondary, lineHeight: 17 },
  categoryGroup: { gap: 2, marginTop: 6 },
  categoryTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: theme.textSecondary,
    marginTop: 4,
  },
  warn: { fontSize: 12, color: theme.warning, paddingVertical: 6 },
  swatchRow: { flexDirection: "row", gap: 10, flexWrap: "wrap" },
  swatch: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 3,
    borderColor: "transparent",
  },
  swatchActive: { borderColor: theme.text },
  disabled: { opacity: 0.5 },
  modalOverlay: { flex: 1, justifyContent: "flex-end" },
  modalScrim: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  sheet: {
    backgroundColor: theme.bgElevated,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    gap: 10,
  },
  sheetHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  sheetTitle: { fontSize: 18, fontWeight: "700", color: theme.text },
  saveBtn: {
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 13,
    alignItems: "center",
    marginTop: 6,
  },
  saveBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
});