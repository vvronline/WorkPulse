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
  { value: "fibonacci", label: "Fibonacci (1, 2, 3, 5, 8…)" },
  { value: "linear", label: "Linear (1–10)" },
  { value: "tshirt", label: "T-shirt (XS, S, M, L, XL)" },
  { value: "hours", label: "Hours" },
  { value: "none", label: "No estimation" },
];

const STATE_CATEGORIES = [
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "in_review", label: "In review" },
  { value: "done", label: "Done" },
];

const FEATURE_FLAGS: Array<{ key: keyof AgileSettings; label: string }> = [
  { key: "enable_story_points", label: "Story points" },
  { key: "enable_epics", label: "Epics" },
  { key: "enable_dependencies", label: "Dependencies" },
  { key: "enable_acceptance_criteria", label: "Acceptance criteria" },
  { key: "enable_wip_limits", label: "WIP limits" },
  { key: "enable_blockers", label: "Blockers" },
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

export default function AgileConfigScreen() {
  const kbInset = useKeyboardInset();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [settings, setSettings] = useState<AgileSettings | null>(null);
  const [types, setTypes] = useState<AgileWorkItemType[]>([]);
  const [states, setStates] = useState<AgileWorkflowState[]>([]);
  const [busy, setBusy] = useState(false);

  // Work item type modal state
  const [typeModal, setTypeModal] = useState(false);
  const [editingType, setEditingType] = useState<AgileWorkItemType | null>(null);
  const [typeName, setTypeName] = useState("");
  const [typeColor, setTypeColor] = useState(COLOR_PRESETS[0]);
  const [typeIsEpic, setTypeIsEpic] = useState(false);
  const [typeIsDefault, setTypeIsDefault] = useState(false);

  // Workflow state modal state
  const [stateModal, setStateModal] = useState(false);
  const [editingState, setEditingState] =
    useState<AgileWorkflowState | null>(null);
  const [stateName, setStateName] = useState("");
  const [stateCategory, setStateCategory] = useState<string | number | null>(
    "open",
  );
  const [stateColor, setStateColor] = useState(COLOR_PRESETS[6]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [setR, typR, staR, permR] = await Promise.allSettled([
      getAgileSettings(),
      getWorkItemTypes(),
      getWorkflowStates(),
      getAgilePermissions(),
    ]);
    if (setR.status === "fulfilled") setSettings(setR.value.data);
    else {
      const e = setR.reason as any;
      setError(e?.response?.data?.error || "Failed to load Agile settings");
    }
    if (typR.status === "fulfilled")
      setTypes(Array.isArray(typR.value.data) ? typR.value.data : []);
    if (staR.status === "fulfilled")
      setStates(Array.isArray(staR.value.data) ? staR.value.data : []);
    if (permR.status === "fulfilled") setCanEdit(!!permR.value.data?.canEdit);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function patchSettings(patch: Partial<AgileSettings>) {
    if (!canEdit) return;
    setBusy(true);
    // Optimistic update for snappy toggles.
    setSettings((s) => (s ? { ...s, ...patch } : s));
    try {
      const r = await updateAgileSettings(patch);
      setSettings(r.data);
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to save");
      load();
    } finally {
      setBusy(false);
    }
  }

  /* ── Work item types ── */

  function openCreateType() {
    setEditingType(null);
    setTypeName("");
    setTypeColor(COLOR_PRESETS[0]);
    setTypeIsEpic(false);
    setTypeIsDefault(false);
    setTypeModal(true);
  }

  function openEditType(t: AgileWorkItemType) {
    setEditingType(t);
    setTypeName(t.name);
    setTypeColor(t.color || COLOR_PRESETS[0]);
    setTypeIsEpic(!!t.is_epic);
    setTypeIsDefault(!!t.is_default);
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
          color: typeColor,
          is_epic: typeIsEpic,
          is_default: typeIsDefault,
        });
      } else {
        await createWorkItemType({
          name: typeName.trim(),
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
    Alert.alert("Delete type", `Delete "${t.name}"?`, [
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
    ]);
  }

  /* ── Workflow states ── */

  function openCreateState() {
    setEditingState(null);
    setStateName("");
    setStateCategory("open");
    setStateColor(COLOR_PRESETS[6]);
    setStateModal(true);
  }

  function openEditState(s: AgileWorkflowState) {
    setEditingState(s);
    setStateName(s.name);
    setStateCategory(s.category);
    setStateColor(s.color || COLOR_PRESETS[6]);
    setStateModal(true);
  }

  async function saveState() {
    if (!stateName.trim()) {
      Alert.alert("Required", "Name is required");
      return;
    }
    setBusy(true);
    try {
      if (editingState) {
        await updateWorkflowState(editingState.id, {
          name: stateName.trim(),
          category: String(stateCategory || "open"),
          color: stateColor,
        });
      } else {
        await createWorkflowState({
          name: stateName.trim(),
          category: String(stateCategory || "open"),
          color: stateColor,
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
    Alert.alert("Delete state", `Delete "${s.name}"?`, [
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
    ]);
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

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.container, { paddingBottom: 48 + kbInset }]}
    >
      <Stack.Screen options={{ title: "Agile Config" }} />

      {!canEdit ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>
            Read-only — only Agile editors (super admins or granted users) can
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
        <Dropdown
          label="Estimation type"
          value={settings?.estimation_type ?? "fibonacci"}
          options={ESTIMATION_TYPES}
          onChange={(v) => {
            if (v) patchSettings({ estimation_type: String(v) });
          }}
        />
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
                {!t.is_active ? (
                  <Text style={styles.itemMeta}>inactive</Text>
                ) : null}
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
        {states.length === 0 ? (
          <Text style={styles.empty}>No workflow states.</Text>
        ) : (
          states.map((s) => (
            <View key={s.id} style={styles.itemRow}>
              <View
                style={[styles.colorDot, { backgroundColor: s.color || "#888" }]}
              />
              <View style={{ flex: 1 }}>
                <Text style={styles.itemName}>{s.name}</Text>
                <Text style={styles.itemMeta}>
                  {s.category.replace(/_/g, " ")}
                  {s.is_initial ? " · initial" : ""}
                  {s.is_terminal ? " · terminal" : ""}
                  {s.wip_limit ? ` · WIP ${s.wip_limit}` : ""}
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
            <Text style={styles.fieldLabel}>Name</Text>
            <TextInput
              style={styles.input}
              value={typeName}
              onChangeText={setTypeName}
              placeholder="e.g. Story"
              placeholderTextColor={theme.textMuted}
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
  toggleLabel: { fontSize: 14, color: theme.text },
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
  swatchRow: { flexDirection: "row", gap: 10, flexWrap: "wrap" },
  swatch: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 3,
    borderColor: "transparent",
  },
  swatchActive: { borderColor: theme.text },
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
  fieldLabel: { fontSize: 12, color: theme.textSecondary, fontWeight: "500" },
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
  saveBtn: {
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 13,
    alignItems: "center",
    marginTop: 6,
  },
  saveBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
});