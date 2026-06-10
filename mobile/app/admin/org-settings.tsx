import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack } from "expo-router";
import { Building2, Palette, UserPlus } from "lucide-react-native";
import { theme } from "../../src/theme";
import {
  useKeyboardInset,
  scrollFocusedIntoView,
} from "../../src/hooks/useKeyboardInset";
import { Dropdown } from "../../src/components/Dropdown";
import {
  getBranding,
  getRegistrationSettings,
  updateBrandingAccent,
  updateOrgSettings,
  updateRegistrationSettings,
} from "../../src/admin";
import { getCurrentOrg } from "../../src/features";

const REGISTRATION_MODES = [
  { value: "open", label: "Open — anyone can register" },
  { value: "invite", label: "Invite only" },
  { value: "closed", label: "Closed — admins create users" },
];

const ACCENT_PRESETS = [
  "#2383e2",
  "#4daa57",
  "#cb912f",
  "#e03e3e",
  "#9b59b6",
  "#1abc9c",
];

export default function OrgSettingsScreen() {
  const kbInset = useKeyboardInset();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState("");
  const [workHours, setWorkHours] = useState("");
  const [accent, setAccent] = useState("#2383e2");
  const [regMode, setRegMode] = useState("open");

  const load = useCallback(async () => {
    setLoading(true);
    const [orgR, brandR, regR] = await Promise.allSettled([
      getCurrentOrg(),
      getBranding(),
      getRegistrationSettings(),
    ]);
    if (orgR.status === "fulfilled" && orgR.value.data) {
      const o = orgR.value.data;
      setName(o.name ?? "");
      setTimezone(o.timezone ?? "");
      setWorkHours(o.work_hours_per_day ? String(o.work_hours_per_day) : "");
    }
    if (brandR.status === "fulfilled" && brandR.value.data?.accent_color)
      setAccent(brandR.value.data.accent_color);
    if (regR.status === "fulfilled" && regR.value.data?.mode)
      setRegMode(regR.value.data.mode);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function saveWorkPolicy() {
    setBusy(true);
    try {
      await updateOrgSettings({
        name: name.trim() || undefined,
        timezone: timezone.trim() || undefined,
        work_hours_per_day: workHours ? Number(workHours) : undefined,
      });
      Alert.alert("Saved", "Organization settings updated");
      load();
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  async function saveAccent(color: string) {
    setAccent(color);
    setBusy(true);
    try {
      await updateBrandingAccent(color);
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to save accent");
    } finally {
      setBusy(false);
    }
  }

  async function saveRegMode(mode: string | number | null) {
    if (!mode) return;
    setRegMode(String(mode));
    setBusy(true);
    try {
      await updateRegistrationSettings(String(mode));
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to update");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Stack.Screen options={{ title: "Org Settings" }} />
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.container, { paddingBottom: 48 + kbInset }]}
    >
      <Stack.Screen options={{ title: "Org Settings" }} />

      {/* Work policy */}
      <View style={styles.section}>
        <View style={styles.sectionTitleRow}>
          <Building2 size={15} color={theme.textSecondary} />
          <Text style={styles.sectionTitle}>Organization</Text>
        </View>
        <Text style={styles.fieldLabel}>Name</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          onFocus={scrollFocusedIntoView}
          placeholder="Organization name"
          placeholderTextColor={theme.textMuted}
        />
        <Text style={styles.fieldLabel}>Timezone</Text>
        <TextInput
          style={styles.input}
          value={timezone}
          onChangeText={setTimezone}
          onFocus={scrollFocusedIntoView}
          placeholder="e.g. Asia/Kolkata"
          placeholderTextColor={theme.textMuted}
          autoCapitalize="none"
        />
        <Text style={styles.fieldLabel}>Work hours per day</Text>
        <TextInput
          style={styles.input}
          value={workHours}
          onChangeText={setWorkHours}
          onFocus={scrollFocusedIntoView}
          placeholder="8"
          placeholderTextColor={theme.textMuted}
          keyboardType="numeric"
        />
        <Pressable style={styles.saveBtn} onPress={saveWorkPolicy} disabled={busy}>
          <Text style={styles.saveBtnText}>
            {busy ? "Saving…" : "Save organization"}
          </Text>
        </Pressable>
      </View>

      {/* Branding accent */}
      <View style={styles.section}>
        <View style={styles.sectionTitleRow}>
          <Palette size={15} color={theme.textSecondary} />
          <Text style={styles.sectionTitle}>Brand accent</Text>
        </View>
        <View style={styles.swatchRow}>
          {ACCENT_PRESETS.map((c) => (
            <Pressable
              key={c}
              style={[
                styles.swatch,
                { backgroundColor: c },
                accent.toLowerCase() === c.toLowerCase() && styles.swatchActive,
              ]}
              onPress={() => saveAccent(c)}
            />
          ))}
        </View>
        <Text style={styles.hint}>Current: {accent}</Text>
      </View>

      {/* Registration mode */}
      <View style={styles.section}>
        <View style={styles.sectionTitleRow}>
          <UserPlus size={15} color={theme.textSecondary} />
          <Text style={styles.sectionTitle}>Registration</Text>
        </View>
        <Dropdown
          label="Registration mode"
          value={regMode}
          options={REGISTRATION_MODES}
          onChange={saveRegMode}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { alignItems: "center", justifyContent: "center" },
  container: { padding: 16, gap: 16, paddingBottom: 48 },
  section: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusLg,
    padding: 16,
    gap: 10,
  },
  sectionTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  sectionTitle: { fontSize: 15, fontWeight: "700", color: theme.text },
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
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 4,
  },
  saveBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  swatchRow: { flexDirection: "row", gap: 12, flexWrap: "wrap" },
  swatch: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 3,
    borderColor: "transparent",
  },
  swatchActive: { borderColor: theme.text },
  hint: { fontSize: 12, color: theme.textMuted },
});