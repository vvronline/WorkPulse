import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack } from "expo-router";
import {
  CircleDot,
  ListChecks,
  Pencil,
  Plus,
  Shapes,
  SlidersHorizontal,
  Tag,
  Trash2,
  Workflow,
  X,
} from "../../src/icons";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import { useKeyboardInset } from "../../src/hooks/useKeyboardInset";
import { Dropdown } from "../../src/components/Dropdown";
import { ColorPicker } from "../../src/components/ColorPicker";
import {
  createCustomField,
  createTaskLabel,
  createWorkItemType,
  createWorkflowState,
  deleteCustomField,
  deleteTaskLabel,
  deleteWorkItemType,
  deleteWorkflowState,
  getAgilePermissions,
  getAgileSettings,
  getCustomFieldsAll,
  getTaskLabelsManage,
  getWorkItemTypes,
  getWorkflowStates,
  updateAgileSettings,
  updateCustomField,
  updateTaskLabel,
  updateWorkItemType,
  updateWorkflowState,
  type AgileSettings,
  type AgileWorkItemType,
  type AgileWorkflowState,
  type CustomFieldDef,
  type CustomFieldOption,
  type TaskLabelManage,
} from "../../src/admin";
import { makeStyles } from "./agile.styles";

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

// Label colour presets (mirrors web TaskLabelsTab PRESET_COLORS).
const LABEL_PRESETS = [
  "#0ea5e9",
  "#ef4444",
  "#f59e0b",
  "#10b981",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
  "#64748b",
];

// Custom field types (mirrors web CustomFieldsTab FIELD_TYPES).
const FIELD_TYPES = [
  { value: "text", label: "Single-line text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "select", label: "Select (single)" },
  { value: "multiselect", label: "Select (multiple)" },
  { value: "checkbox", label: "Checkbox" },
  { value: "url", label: "URL" },
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

// Stable module-level empties so memoized derivations don't churn between renders.
const EMPTY_TYPES: AgileWorkItemType[] = [];
const EMPTY_STATES: AgileWorkflowState[] = [];
const EMPTY_LABELS: TaskLabelManage[] = [];
const EMPTY_FIELDS: CustomFieldDef[] = [];

type AgileConfigData = {
  settings: AgileSettings | null;
  types: AgileWorkItemType[];
  states: AgileWorkflowState[];
  canEdit: boolean;
  labels: TaskLabelManage[];
  customFields: CustomFieldDef[];
};

export default function AgileConfigScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const kbInset = useKeyboardInset();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  // Local editable copies for the General section (saved with a button, like web).
  const [estType, setEstType] = useState("fibonacci");
  const [estValues, setEstValues] = useState("");
  const [estUnit, setEstUnit] = useState("");
  const [dod, setDod] = useState("");
  const [generalDirty, setGeneralDirty] = useState(false);

  // Work item type modal state
  const [typeModal, setTypeModal] = useState(false);
  const [editingType, setEditingType] = useState<AgileWorkItemType | null>(
    null,
  );
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

  // Labels
  const [labelModal, setLabelModal] = useState(false);
  const [editingLabel, setEditingLabel] = useState<TaskLabelManage | null>(
    null,
  );
  const [labelName, setLabelName] = useState("");
  const [labelColor, setLabelColor] = useState(LABEL_PRESETS[0]);

  // Custom fields
  const [fieldModal, setFieldModal] = useState(false);
  const [editingField, setEditingField] = useState<CustomFieldDef | null>(null);
  const [fieldLabel, setFieldLabel] = useState("");
  const [fieldType, setFieldType] = useState<string>("text");
  const [fieldDesc, setFieldDesc] = useState("");
  const [fieldRequired, setFieldRequired] = useState(false);
  const [fieldShowOnCard, setFieldShowOnCard] = useState(false);
  const [fieldActive, setFieldActive] = useState(true);
  const [fieldOptions, setFieldOptions] = useState<CustomFieldOption[]>([
    { value: "", label: "" },
  ]);
  const [fieldAppliesTo, setFieldAppliesTo] = useState<(number | string)[]>([]);

  const syncGeneral = useCallback((s: AgileSettings | null) => {
    if (!s) return;
    setEstType(s.estimation_type ?? "fibonacci");
    setEstValues(valuesToString(s.estimation_values));
    setEstUnit(s.estimation_unit_label ?? "");
    setDod(s.default_dod ?? "");
    setGeneralDirty(false);
  }, []);

  const {
    data: agileData,
    isLoading: loading,
    isError,
    error: queryError,
  } = useQuery({
    queryKey: ["admin", "agileConfig"],
    queryFn: async () => {
      const [setR, typR, staR, permR, labR, fldR] = await Promise.allSettled([
        getAgileSettings(),
        getWorkItemTypes(),
        getWorkflowStates(),
        getAgilePermissions(),
        getTaskLabelsManage(),
        getCustomFieldsAll(),
      ]);
      if (setR.status !== "fulfilled") {
        throw setR.reason;
      }
      return {
        settings: setR.value.data as AgileSettings | null,
        types:
          typR.status === "fulfilled" && Array.isArray(typR.value.data)
            ? typR.value.data
            : EMPTY_TYPES,
        states:
          staR.status === "fulfilled" && Array.isArray(staR.value.data)
            ? staR.value.data
            : EMPTY_STATES,
        canEdit:
          permR.status === "fulfilled" ? !!permR.value.data?.canEdit : false,
        labels:
          labR.status === "fulfilled" && Array.isArray(labR.value.data)
            ? labR.value.data
            : EMPTY_LABELS,
        customFields:
          fldR.status === "fulfilled" && Array.isArray(fldR.value.data)
            ? fldR.value.data
            : EMPTY_FIELDS,
      };
    },
  });

  const settings = agileData?.settings ?? null;
  const types = agileData?.types ?? EMPTY_TYPES;
  const states = agileData?.states ?? EMPTY_STATES;
  const canEdit = agileData?.canEdit ?? false;
  const labels = agileData?.labels ?? EMPTY_LABELS;
  const fields = agileData?.customFields ?? EMPTY_FIELDS;
  const error = isError
    ? (queryError as any)?.response?.data?.error ||
      "Failed to load Agile settings"
    : null;

  // Optimistic / refetched settings writes flow through the query cache so the
  // General section stays in sync with the cached server data.
  const setSettings = useCallback(
    (
      updater:
        | AgileSettings
        | null
        | ((s: AgileSettings | null) => AgileSettings | null),
    ) => {
      queryClient.setQueryData<AgileConfigData>(
        ["admin", "agileConfig"],
        (old) => {
          if (!old) return old;
          const next =
            typeof updater === "function"
              ? (updater as (s: AgileSettings | null) => AgileSettings | null)(
                  old.settings,
                )
              : updater;
          return { ...old, settings: next };
        },
      );
    },
    [queryClient],
  );

  // Keep the editable General-section copies aligned with cached settings,
  // mirroring the syncGeneral call the old load() performed after each fetch.
  useEffect(() => {
    syncGeneral(settings);
  }, [settings, syncGeneral]);

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
          Object.entries(patch).every(([k, v]) => (fresh as any)[k] === v);
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
            ? (ESTIMATION_PRESETS[estType] ?? stringToValues(estValues))
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
      await queryClient.invalidateQueries({
        queryKey: ["admin", "agileConfig"],
      });
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
              .then(() =>
                queryClient.invalidateQueries({
                  queryKey: ["admin", "agileConfig"],
                }),
              )
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
      await queryClient.invalidateQueries({
        queryKey: ["admin", "agileConfig"],
      });
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
              .then(() =>
                queryClient.invalidateQueries({
                  queryKey: ["admin", "agileConfig"],
                }),
              )
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

  /* ── Labels ── */

  function openCreateLabel() {
    setEditingLabel(null);
    setLabelName("");
    setLabelColor(LABEL_PRESETS[0]);
    setLabelModal(true);
  }

  function openEditLabel(l: TaskLabelManage) {
    setEditingLabel(l);
    setLabelName(l.name);
    setLabelColor(l.color || LABEL_PRESETS[0]);
    setLabelModal(true);
  }

  async function saveLabel() {
    if (!labelName.trim()) {
      Alert.alert("Required", "Label name is required");
      return;
    }
    setBusy(true);
    try {
      if (editingLabel) {
        await updateTaskLabel(editingLabel.id, {
          name: labelName.trim(),
          color: labelColor,
        });
      } else {
        await createTaskLabel({ name: labelName.trim(), color: labelColor });
      }
      setLabelModal(false);
      await queryClient.invalidateQueries({
        queryKey: ["admin", "agileConfig"],
      });
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to save label");
    } finally {
      setBusy(false);
    }
  }

  function confirmDeleteLabel(l: TaskLabelManage) {
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
              .then(() =>
                queryClient.invalidateQueries({
                  queryKey: ["admin", "agileConfig"],
                }),
              )
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

  /* ── Custom fields ── */

  const isSelectType = fieldType === "select" || fieldType === "multiselect";

  function openCreateField() {
    setEditingField(null);
    setFieldLabel("");
    setFieldType("text");
    setFieldDesc("");
    setFieldRequired(false);
    setFieldShowOnCard(false);
    setFieldActive(true);
    setFieldOptions([{ value: "", label: "" }]);
    setFieldAppliesTo([]);
    setFieldModal(true);
  }

  function openEditField(f: CustomFieldDef) {
    setEditingField(f);
    setFieldLabel(f.label || "");
    setFieldType(f.field_type || "text");
    setFieldDesc(f.description || "");
    setFieldRequired(!!f.is_required);
    setFieldShowOnCard(!!f.show_on_card);
    setFieldActive(f.is_active !== false);
    setFieldOptions(
      Array.isArray(f.options) && f.options.length > 0
        ? f.options.map((o) => ({
            value: o.value || "",
            label: o.label || "",
          }))
        : [{ value: "", label: "" }],
    );
    setFieldAppliesTo(
      Array.isArray(f.applies_to_types) ? f.applies_to_types : [],
    );
    setFieldModal(true);
  }

  function setOption(idx: number, key: keyof CustomFieldOption, val: string) {
    setFieldOptions((prev) =>
      prev.map((o, i) => (i === idx ? { ...o, [key]: val } : o)),
    );
  }

  function addOption() {
    setFieldOptions((prev) => [...prev, { value: "", label: "" }]);
  }

  function removeOption(idx: number) {
    setFieldOptions((prev) => prev.filter((_, i) => i !== idx));
  }

  function toggleAppliesTo(id: number | string) {
    setFieldAppliesTo((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  async function saveField() {
    if (!fieldLabel.trim()) {
      Alert.alert("Required", "Label is required");
      return;
    }
    const payload: any = {
      label: fieldLabel.trim(),
      field_type: fieldType,
      description: fieldDesc.trim() || null,
      is_required: fieldRequired,
      show_on_card: fieldShowOnCard,
      is_active: fieldActive,
      applies_to_types: fieldAppliesTo,
    };
    if (isSelectType) {
      const cleaned = fieldOptions
        .map((o) => ({
          value: String(o.value || o.label || "").trim(),
          label: String(o.label || o.value || "").trim(),
        }))
        .filter((o) => o.value);
      if (cleaned.length === 0) {
        Alert.alert("Required", "Select fields need at least one option");
        return;
      }
      payload.options = cleaned;
    }
    setBusy(true);
    try {
      if (editingField) {
        await updateCustomField(editingField.id, payload);
      } else {
        await createCustomField(payload);
      }
      setFieldModal(false);
      await queryClient.invalidateQueries({
        queryKey: ["admin", "agileConfig"],
      });
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to save field");
    } finally {
      setBusy(false);
    }
  }

  function confirmDeleteField(f: CustomFieldDef) {
    Alert.alert(
      "Delete custom field",
      `Delete "${f.label}"? Existing values on tasks will be lost.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () =>
            deleteCustomField(f.id)
              .then(() =>
                queryClient.invalidateQueries({
                  queryKey: ["admin", "agileConfig"],
                }),
              )
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
      contentContainerStyle={[
        styles.container,
        { paddingBottom: 48 + kbInset },
      ]}
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
                style={[
                  styles.colorDot,
                  { backgroundColor: t.color || "#888" },
                ]}
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

      {/* Labels */}
      <View style={styles.section}>
        <View style={styles.sectionHeaderRow}>
          <View style={styles.sectionTitleRow}>
            <Tag size={15} color={theme.textSecondary} />
            <Text style={styles.sectionTitle}>Labels</Text>
          </View>
          {canEdit ? (
            <Pressable style={styles.addBtn} onPress={openCreateLabel}>
              <Plus size={14} color={theme.primary} />
              <Text style={styles.addBtnText}>Add</Text>
            </Pressable>
          ) : null}
        </View>
        <Text style={styles.hint}>
          Free-form tags for cross-cutting filtering (e.g. frontend, tech-debt).
          A ticket can carry many labels.
        </Text>
        {labels.length === 0 ? (
          <Text style={styles.empty}>No labels yet.</Text>
        ) : (
          labels.map((l) => (
            <View key={l.id} style={styles.itemRow}>
              <View
                style={[
                  styles.colorDot,
                  { backgroundColor: l.color || "#888" },
                ]}
              />
              <View style={{ flex: 1 }}>
                <View
                  style={[
                    styles.labelBadge,
                    { backgroundColor: l.color || "#888" },
                  ]}
                >
                  <Text style={styles.labelBadgeText}>{l.name}</Text>
                </View>
                <Text style={styles.itemMeta}>
                  {l.created_by_username ? `by ${l.created_by_username}` : "—"}
                </Text>
              </View>
              {canEdit ? (
                <>
                  <Pressable
                    style={styles.iconBtn}
                    onPress={() => openEditLabel(l)}
                    hitSlop={6}
                  >
                    <Pencil size={15} color={theme.textSecondary} />
                  </Pressable>
                  <Pressable
                    style={styles.iconBtn}
                    onPress={() => confirmDeleteLabel(l)}
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

      {/* Custom fields */}
      <View style={styles.section}>
        <View style={styles.sectionHeaderRow}>
          <View style={styles.sectionTitleRow}>
            <ListChecks size={15} color={theme.textSecondary} />
            <Text style={styles.sectionTitle}>Custom fields</Text>
          </View>
          {canEdit ? (
            <Pressable style={styles.addBtn} onPress={openCreateField}>
              <Plus size={14} color={theme.primary} />
              <Text style={styles.addBtnText}>Add</Text>
            </Pressable>
          ) : null}
        </View>
        <Text style={styles.hint}>
          Tenant-specific fields shown on every task — text, number, date,
          select, checkbox, or URL.
        </Text>
        {fields.length === 0 ? (
          <Text style={styles.empty}>No custom fields yet.</Text>
        ) : (
          fields.map((f) => (
            <View key={f.id} style={styles.itemRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.itemName}>
                  {f.label}
                  {f.is_required ? "  ·  required" : ""}
                </Text>
                <Text style={styles.itemMeta}>
                  {f.field_type}
                  {f.show_on_card ? " · on card" : ""}
                  {f.is_active === false ? " · inactive" : ""}
                </Text>
              </View>
              {canEdit ? (
                <>
                  <Pressable
                    style={styles.iconBtn}
                    onPress={() => openEditField(f)}
                    hitSlop={6}
                  >
                    <Pencil size={15} color={theme.textSecondary} />
                  </Pressable>
                  <Pressable
                    style={styles.iconBtn}
                    onPress={() => confirmDeleteField(f)}
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
              <ColorPicker
                value={typeColor}
                onChange={setTypeColor}
                presets={COLOR_PRESETS}
              />
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
            <Pressable
              style={styles.saveBtn}
              onPress={saveType}
              disabled={busy}
            >
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
              <ColorPicker
                value={stateColor}
                onChange={setStateColor}
                presets={COLOR_PRESETS}
              />
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
                <Text style={styles.toggleLabel}>
                  Terminal (counts as done)
                </Text>
                <Switch
                  value={stateTerminal}
                  onValueChange={setStateTerminal}
                  trackColor={{ true: theme.primary, false: theme.surface }}
                  thumbColor="#fff"
                />
              </View>
              {editingState ? (
                <View style={styles.toggleRow}>
                  <Text style={styles.toggleLabel}>
                    Active (shown on board)
                  </Text>
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

      {/* ── Label modal ── */}
      <Modal
        visible={labelModal}
        transparent
        animationType="slide"
        onRequestClose={() => setLabelModal(false)}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <Pressable
            style={styles.modalScrim}
            onPress={() => setLabelModal(false)}
          />
          <View style={[styles.sheet, { marginBottom: kbInset }]}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>
                {editingLabel ? "Edit label" : "New label"}
              </Text>
              <Pressable onPress={() => setLabelModal(false)} hitSlop={8}>
                <X size={22} color={theme.textSecondary} />
              </Pressable>
            </View>
            <ScrollView style={{ maxHeight: 460 }}>
              <Text style={styles.fieldLabel}>Label name</Text>
              <TextInput
                style={styles.input}
                value={labelName}
                onChangeText={setLabelName}
                placeholder="e.g. Bug, Feature, Urgent"
                placeholderTextColor={theme.textMuted}
                maxLength={30}
              />
              <Text style={styles.fieldLabel}>Color</Text>
              <ColorPicker
                value={labelColor}
                onChange={setLabelColor}
                presets={LABEL_PRESETS}
              />
              <View style={styles.previewRow}>
                <View
                  style={[styles.labelBadge, { backgroundColor: labelColor }]}
                >
                  <Text style={styles.labelBadgeText}>
                    {labelName.trim() || "Preview"}
                  </Text>
                </View>
              </View>
            </ScrollView>
            <Pressable
              style={styles.saveBtn}
              onPress={saveLabel}
              disabled={busy}
            >
              <Text style={styles.saveBtnText}>
                {busy ? "Saving…" : editingLabel ? "Save changes" : "Create"}
              </Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Custom field modal ── */}
      <Modal
        visible={fieldModal}
        transparent
        animationType="slide"
        onRequestClose={() => setFieldModal(false)}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <Pressable
            style={styles.modalScrim}
            onPress={() => setFieldModal(false)}
          />
          <View style={[styles.sheet, { marginBottom: kbInset }]}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>
                {editingField ? "Edit custom field" : "New custom field"}
              </Text>
              <Pressable onPress={() => setFieldModal(false)} hitSlop={8}>
                <X size={22} color={theme.textSecondary} />
              </Pressable>
            </View>
            <ScrollView style={{ maxHeight: 480 }}>
              <Text style={styles.fieldLabel}>Label</Text>
              <TextInput
                style={styles.input}
                value={fieldLabel}
                onChangeText={setFieldLabel}
                placeholder="e.g. Component"
                placeholderTextColor={theme.textMuted}
              />
              <Text style={styles.fieldLabel}>Type</Text>
              <Dropdown
                label="Field type"
                value={fieldType}
                options={FIELD_TYPES}
                onChange={(v) => {
                  if (v) setFieldType(String(v));
                }}
              />
              <Text style={styles.fieldLabel}>Description (optional)</Text>
              <TextInput
                style={styles.input}
                value={fieldDesc}
                onChangeText={setFieldDesc}
                placeholder="Helper text shown beneath the field"
                placeholderTextColor={theme.textMuted}
              />

              {isSelectType ? (
                <>
                  <Text style={styles.fieldLabel}>Options</Text>
                  {fieldOptions.map((o, i) => (
                    <View key={i} style={styles.optionRow}>
                      <TextInput
                        style={[styles.input, { flex: 1 }]}
                        value={o.label}
                        onChangeText={(v) => setOption(i, "label", v)}
                        placeholder="Display label"
                        placeholderTextColor={theme.textMuted}
                      />
                      <Pressable
                        style={styles.optionRemove}
                        onPress={() => removeOption(i)}
                        disabled={fieldOptions.length === 1}
                        hitSlop={6}
                      >
                        <X
                          size={16}
                          color={
                            fieldOptions.length === 1
                              ? theme.textMuted
                              : theme.danger
                          }
                        />
                      </Pressable>
                    </View>
                  ))}
                  <Pressable style={styles.addOptionBtn} onPress={addOption}>
                    <Plus size={14} color={theme.primary} />
                    <Text style={styles.addBtnText}>Add option</Text>
                  </Pressable>
                </>
              ) : null}

              {types.length > 0 ? (
                <>
                  <Text style={styles.fieldLabel}>
                    Applies to work item types
                  </Text>
                  <Text style={styles.hint}>
                    Leave all unchecked to apply to every type.
                  </Text>
                  {types.map((t) => {
                    const on = fieldAppliesTo.includes(t.id);
                    return (
                      <Pressable
                        key={t.id}
                        style={styles.checkRow}
                        onPress={() => toggleAppliesTo(t.id)}
                      >
                        <View
                          style={[styles.checkbox, on && styles.checkboxOn]}
                        >
                          {on ? <Text style={styles.checkMark}>✓</Text> : null}
                        </View>
                        <Text style={styles.checkLabel}>{t.name}</Text>
                      </Pressable>
                    );
                  })}
                </>
              ) : null}

              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>Required</Text>
                <Switch
                  value={fieldRequired}
                  onValueChange={setFieldRequired}
                  trackColor={{ true: theme.primary, false: theme.surface }}
                  thumbColor="#fff"
                />
              </View>
              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>Show on task card</Text>
                <Switch
                  value={fieldShowOnCard}
                  onValueChange={setFieldShowOnCard}
                  trackColor={{ true: theme.primary, false: theme.surface }}
                  thumbColor="#fff"
                />
              </View>
              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>Active</Text>
                <Switch
                  value={fieldActive}
                  onValueChange={setFieldActive}
                  trackColor={{ true: theme.primary, false: theme.surface }}
                  thumbColor="#fff"
                />
              </View>
            </ScrollView>
            <Pressable
              style={styles.saveBtn}
              onPress={saveField}
              disabled={busy}
            >
              <Text style={styles.saveBtnText}>
                {busy
                  ? "Saving…"
                  : editingField
                    ? "Save changes"
                    : "Create field"}
              </Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </ScrollView>
  );
}
