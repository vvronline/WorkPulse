import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
  ChevronDown,
  ChevronUp,
  CreditCard,
  Plus,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react-native";
import { theme } from "../../src/theme";
import {
  getPlanCatalog,
  resetPlanCatalog,
  updatePlanCatalog,
  type PlanDef,
} from "../../src/admin";

/**
 * Full plan-catalog editor — mirrors web PlanManagement.tsx.
 * Edit labels/descriptions/limits/features per plan, add/delete plans,
 * save all, and reset to defaults.
 */
export default function PlansScreen() {
  const [plans, setPlans] = useState<Record<string, PlanDef>>({});
  const [featureLabels, setFeatureLabels] = useState<Record<string, string>>({});
  const [featureKeys, setFeatureKeys] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [newPlanKey, setNewPlanKey] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    getPlanCatalog()
      .then((r) => {
        setPlans(r.data.plans || {});
        setFeatureLabels(r.data.feature_labels || {});
        setFeatureKeys(
          r.data.feature_keys || Object.keys(r.data.feature_labels || {}),
        );
      })
      .catch(() => setPlans({}))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function saveAll() {
    setSaving(true);
    setMsg(null);
    try {
      const r = await updatePlanCatalog(plans);
      setPlans(r.data.plans || plans);
      setMsg("Plan catalog saved");
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to save plans");
    } finally {
      setSaving(false);
    }
  }

  function confirmReset() {
    Alert.alert(
      "Reset Plan Catalog",
      "This will replace all custom plans with the original defaults (Standard, Pro, Enterprise). Existing tenants will keep their current plan assignment.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset",
          style: "destructive",
          onPress: async () => {
            setSaving(true);
            setMsg(null);
            try {
              const r = await resetPlanCatalog();
              setPlans(r.data.plans || {});
              setMsg("Plan catalog reset to defaults");
            } catch (e: any) {
              Alert.alert(
                "Error",
                e?.response?.data?.error || "Failed to reset",
              );
            } finally {
              setSaving(false);
            }
          },
        },
      ],
    );
  }

  function addPlan() {
    const key = newPlanKey.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
    if (!key) {
      Alert.alert("Required", "Plan key is required");
      return;
    }
    if (plans[key]) {
      Alert.alert("Exists", `Plan "${key}" already exists`);
      return;
    }
    const features: Record<string, boolean> = {};
    featureKeys.forEach((k) => {
      features[k] = false;
    });
    setPlans((p) => ({
      ...p,
      [key]: {
        label: key.charAt(0).toUpperCase() + key.slice(1),
        description: "",
        features,
        limits: { max_users: 25, max_storage_mb: 5120 },
      },
    }));
    setNewPlanKey("");
    setExpanded(key);
  }

  function deletePlan(key: string) {
    Alert.alert("Delete plan", `Delete plan "${plans[key]?.label || key}"? Save to apply.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          setPlans((p) => {
            const next = { ...p };
            delete next[key];
            return next;
          });
          if (expanded === key) setExpanded(null);
        },
      },
    ]);
  }

  function updatePlanField(key: string, field: keyof PlanDef, value: unknown) {
    setPlans((p) => ({ ...p, [key]: { ...p[key], [field]: value } as PlanDef }));
  }

  function updateLimit(key: string, limitKey: string, value: string) {
    const num = value === "" ? null : parseInt(value, 10);
    setPlans((p) => ({
      ...p,
      [key]: {
        ...p[key],
        limits: { ...p[key].limits, [limitKey]: Number.isNaN(num) ? null : num },
      },
    }));
  }

  function toggleFeature(planKey: string, fk: string, value: boolean) {
    setPlans((p) => ({
      ...p,
      [planKey]: {
        ...p[planKey],
        features: { ...p[planKey].features, [fk]: value },
      },
    }));
  }

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Stack.Screen options={{ title: "Plans" }} />
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  const planKeys = Object.keys(plans);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.list}>
      <Stack.Screen options={{ title: "Plans" }} />

      {msg ? <Text style={styles.successMsg}>{msg}</Text> : null}

      {/* Toolbar */}
      <View style={styles.toolbar}>
        <Pressable
          style={[styles.toolbarBtn, styles.primaryBtn, saving && styles.disabled]}
          onPress={saveAll}
          disabled={saving}
        >
          <Save size={15} color="#fff" />
          <Text style={styles.primaryBtnText}>
            {saving ? "Saving…" : "Save All Plans"}
          </Text>
        </Pressable>
        <Pressable
          style={[styles.toolbarBtn, styles.secondaryBtn, saving && styles.disabled]}
          onPress={confirmReset}
          disabled={saving}
        >
          <RotateCcw size={15} color={theme.textSecondary} />
          <Text style={styles.secondaryBtnText}>Reset to Defaults</Text>
        </Pressable>
      </View>

      {/* Add plan */}
      <View style={styles.addRow}>
        <TextInput
          style={styles.addInput}
          value={newPlanKey}
          onChangeText={setNewPlanKey}
          placeholder="new_plan_key"
          placeholderTextColor={theme.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Pressable style={[styles.toolbarBtn, styles.secondaryBtn]} onPress={addPlan}>
          <Plus size={15} color={theme.textSecondary} />
          <Text style={styles.secondaryBtnText}>Add Plan</Text>
        </Pressable>
      </View>

      {planKeys.length === 0 ? (
        <Text style={styles.empty}>
          No plans defined. Add a plan or reset to defaults.
        </Text>
      ) : (
        planKeys.map((key) => {
          const plan = plans[key];
          const isOpen = expanded === key;
          return (
            <View key={key} style={styles.card}>
              <Pressable
                style={styles.cardHeader}
                onPress={() => setExpanded(isOpen ? null : key)}
              >
                <View style={styles.iconWrap}>
                  <CreditCard size={18} color={theme.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{plan.label || key}</Text>
                  <Text style={styles.meta}>({key})</Text>
                </View>
                {isOpen ? (
                  <ChevronUp size={18} color={theme.textMuted} />
                ) : (
                  <ChevronDown size={18} color={theme.textMuted} />
                )}
              </Pressable>

              {isOpen ? (
                <View style={styles.cardBody}>
                  <Text style={styles.fieldLabel}>Label</Text>
                  <TextInput
                    style={styles.input}
                    value={plan.label}
                    onChangeText={(v) => updatePlanField(key, "label", v)}
                    placeholderTextColor={theme.textMuted}
                  />
                  <Text style={styles.fieldLabel}>Description</Text>
                  <TextInput
                    style={styles.input}
                    value={plan.description || ""}
                    onChangeText={(v) => updatePlanField(key, "description", v)}
                    placeholderTextColor={theme.textMuted}
                  />
                  <View style={styles.limitsRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.fieldLabel}>Max users</Text>
                      <TextInput
                        style={styles.input}
                        value={
                          plan.limits?.max_users != null
                            ? String(plan.limits.max_users)
                            : ""
                        }
                        onChangeText={(v) => updateLimit(key, "max_users", v)}
                        placeholder="∞"
                        placeholderTextColor={theme.textMuted}
                        keyboardType="number-pad"
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.fieldLabel}>Max storage (MB)</Text>
                      <TextInput
                        style={styles.input}
                        value={
                          plan.limits?.max_storage_mb != null
                            ? String(plan.limits.max_storage_mb)
                            : ""
                        }
                        onChangeText={(v) =>
                          updateLimit(key, "max_storage_mb", v)
                        }
                        placeholder="∞"
                        placeholderTextColor={theme.textMuted}
                        keyboardType="number-pad"
                      />
                    </View>
                  </View>

                  <Text style={[styles.fieldLabel, { marginTop: 6 }]}>
                    Features
                  </Text>
                  <View style={styles.featureList}>
                    {featureKeys.map((fk) => (
                      <View key={fk} style={styles.featureRow}>
                        <Text style={styles.featureText}>
                          {featureLabels[fk] || fk.replace(/_/g, " ")}
                        </Text>
                        <Switch
                          value={!!plan.features?.[fk]}
                          onValueChange={(v) => toggleFeature(key, fk, v)}
                          trackColor={{
                            false: theme.surface,
                            true: theme.primary,
                          }}
                          thumbColor="#fff"
                        />
                      </View>
                    ))}
                  </View>

                  <Pressable
                    style={styles.deleteBtn}
                    onPress={() => deletePlan(key)}
                  >
                    <Trash2 size={14} color={theme.danger} />
                    <Text style={styles.deleteText}>Delete Plan</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  list: { padding: 16, gap: 12, paddingBottom: 60 },
  successMsg: { fontSize: 13, color: theme.success },
  toolbar: { flexDirection: "row", gap: 10 },
  toolbarBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  primaryBtn: { backgroundColor: theme.primary, flex: 1, justifyContent: "center" },
  primaryBtnText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  secondaryBtn: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    justifyContent: "center",
  },
  secondaryBtnText: {
    color: theme.textSecondary,
    fontSize: 13,
    fontWeight: "600",
  },
  disabled: { opacity: 0.6 },
  addRow: { flexDirection: "row", gap: 10 },
  addInput: {
    flex: 1,
    backgroundColor: theme.inputBg,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 14,
    paddingVertical: 11,
    color: theme.text,
    fontSize: 14,
  },
  card: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusLg,
    overflow: "hidden",
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
  },
  iconWrap: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: theme.primaryGlow,
    alignItems: "center",
    justifyContent: "center",
  },
  name: { fontSize: 16, fontWeight: "700", color: theme.text },
  meta: { fontSize: 12, color: theme.textMuted },
  cardBody: {
    borderTopWidth: 1,
    borderTopColor: theme.border,
    padding: 14,
    gap: 8,
  },
  fieldLabel: { fontSize: 12, color: theme.textSecondary, fontWeight: "500" },
  input: {
    backgroundColor: theme.inputBg,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: theme.text,
    fontSize: 14,
  },
  limitsRow: { flexDirection: "row", gap: 10 },
  featureList: { gap: 2 },
  featureRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  featureText: { fontSize: 13, color: theme.text, flex: 1 },
  deleteBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginTop: 10,
    paddingVertical: 10,
    borderRadius: theme.radiusSm,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    backgroundColor: theme.surface,
  },
  deleteText: { color: theme.danger, fontSize: 13, fontWeight: "600" },
  empty: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: "center",
    paddingTop: 32,
  },
});