import { useCallback, useEffect, useMemo, useState } from "react";
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
  Database,
  Lock,
  Megaphone,
  Shield,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Wrench,
} from "lucide-react-native";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import { Dropdown } from "../../src/components/Dropdown";
import {
  createAnnouncement,
  deleteAnnouncement,
  getAdminAnnouncements,
  getImpersonationPolicy,
  getPlatformConfig,
  updateAnnouncement,
  updateImpersonationPolicy,
  updatePlatformConfig,
  type ImpersonationPolicy,
  type PlatformAnnouncement,
} from "../../src/admin";

const ANNOUNCEMENT_TYPES = [
  { value: "info", label: "Info" },
  { value: "success", label: "Success" },
  { value: "warning", label: "Warning" },
  { value: "urgent", label: "Urgent" },
];

const ANNOUNCEMENT_DURATIONS = [
  { value: "", label: "No expiry" },
  { value: "1", label: "1 hour" },
  { value: "6", label: "6 hours" },
  { value: "24", label: "1 day" },
  { value: "168", label: "1 week" },
];

type Config = Record<string, unknown>;

/**
 * Editable platform settings — mirrors web PlatformSettings.tsx:
 * maintenance mode, impersonation policy, security, data retention, and
 * global announcements.
 */
export default function PlatformSettingsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const [config, setConfig] = useState<Config | null>(null);
  const [policy, setPolicy] = useState<ImpersonationPolicy | null>(null);
  const [announcements, setAnnouncements] = useState<PlatformAnnouncement[]>([]);

  // New announcement form
  const [newMsg, setNewMsg] = useState("");
  const [newType, setNewType] = useState("info");
  const [newDuration, setNewDuration] = useState("");

  const load = useCallback(async () => {
    const [cRes, pRes, aRes] = await Promise.allSettled([
      getPlatformConfig(),
      getImpersonationPolicy(),
      getAdminAnnouncements(),
    ]);
    if (cRes.status === "fulfilled") setConfig(cRes.value.data);
    if (pRes.status === "fulfilled") setPolicy(pRes.value.data);
    if (aRes.status === "fulfilled")
      setAnnouncements(Array.isArray(aRes.value.data) ? aRes.value.data : []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function setConfigKey(key: string, value: unknown) {
    setConfig((c) => ({ ...(c || {}), [key]: value }));
  }

  function cfgStr(key: string): string {
    const v = config?.[key];
    return v == null ? "" : String(v);
  }

  function cfgBool(key: string): boolean {
    return cfgStr(key) === "true";
  }

  async function saveConfig(keys: string[], label: string) {
    if (!config) return;
    setSaving(true);
    setMsg(null);
    try {
      const patch: Config = {};
      for (const k of keys) patch[k] = config[k];
      const r = await updatePlatformConfig(patch);
      setConfig(r.data as Config);
      setMsg(`${label} saved`);
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  async function savePolicy() {
    if (!policy) return;
    setSaving(true);
    setMsg(null);
    try {
      const r = await updateImpersonationPolicy({
        requires_consent: !!policy.requiresConsent,
        break_glass_allowed: !!policy.breakGlassAllowed,
        max_session_minutes: Number(policy.maxSessionMinutes),
        code_ttl_minutes: Number(policy.codeTtlMinutes),
      });
      setPolicy(r.data);
      setMsg("Impersonation policy updated");
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to update policy");
    } finally {
      setSaving(false);
    }
  }

  async function postAnnouncement() {
    if (!newMsg.trim()) return;
    setSaving(true);
    try {
      await createAnnouncement({
        message: newMsg.trim(),
        type: newType,
        duration: newDuration || null,
      });
      setNewMsg("");
      setNewType("info");
      setNewDuration("");
      const r = await getAdminAnnouncements();
      setAnnouncements(Array.isArray(r.data) ? r.data : []);
      setMsg("Announcement created");
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to post");
    } finally {
      setSaving(false);
    }
  }

  async function toggleAnnouncement(a: PlatformAnnouncement) {
    try {
      await updateAnnouncement(a.id, { is_active: !a.is_active });
      const r = await getAdminAnnouncements();
      setAnnouncements(Array.isArray(r.data) ? r.data : []);
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed");
    }
  }

  function confirmDeleteAnnouncement(a: PlatformAnnouncement) {
    Alert.alert("Delete Announcement", "Are you sure you want to delete this announcement?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await deleteAnnouncement(a.id);
            const r = await getAdminAnnouncements();
            setAnnouncements(Array.isArray(r.data) ? r.data : []);
          } catch (e: any) {
            Alert.alert("Error", e?.response?.data?.error || "Failed");
          }
        },
      },
    ]);
  }

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Stack.Screen options={{ title: "Platform Settings" }} />
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: "Platform Settings" }} />

      {msg ? <Text style={styles.successMsg}>{msg}</Text> : null}

      {/* ─── Maintenance Mode ─── */}
      {config ? (
        <View style={styles.section}>
          <View style={styles.sectionTitleRow}>
            <Wrench size={15} color={theme.textSecondary} />
            <Text style={styles.sectionTitle}>Maintenance Mode</Text>
          </View>
          <Text style={styles.note}>
            When enabled, all non-platform-admin users receive a 503
            maintenance page.
          </Text>
          <View style={styles.toggleRow}>
            <Text style={styles.toggleLabel}>Enable maintenance mode</Text>
            <Switch
              value={cfgBool("maintenance_mode")}
              onValueChange={(v) =>
                setConfigKey("maintenance_mode", v ? "true" : "false")
              }
              trackColor={{ false: theme.surface, true: theme.warning }}
              thumbColor="#fff"
            />
          </View>
          <Text style={styles.fieldLabel}>Maintenance message</Text>
          <TextInput
            style={[styles.input, styles.inputMultiline]}
            value={cfgStr("maintenance_message")}
            onChangeText={(v) => setConfigKey("maintenance_message", v)}
            placeholder="The system is currently under maintenance."
            placeholderTextColor={theme.textMuted}
            multiline
          />
          <Pressable
            style={[styles.saveBtn, saving && styles.disabled]}
            onPress={() =>
              saveConfig(["maintenance_mode", "maintenance_message"], "Maintenance settings")
            }
            disabled={saving}
          >
            <Text style={styles.saveBtnText}>Save</Text>
          </Pressable>
        </View>
      ) : null}

      {/* ─── Impersonation Policy ─── */}
      {policy ? (
        <View style={styles.section}>
          <View style={styles.sectionTitleRow}>
            <Shield size={15} color={theme.textSecondary} />
            <Text style={styles.sectionTitle}>Impersonation Policy</Text>
          </View>
          <Text style={styles.note}>
            Controls how platform admins access tenant workspaces.
          </Text>
          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.toggleLabel}>Require tenant consent</Text>
              <Text style={styles.toggleHint}>
                Tenant super-admin must approve access requests.
              </Text>
            </View>
            <Switch
              value={!!policy.requiresConsent}
              onValueChange={(v) =>
                setPolicy((p) => ({ ...(p || {}), requiresConsent: v }))
              }
              trackColor={{ false: theme.surface, true: theme.primary }}
              thumbColor="#fff"
            />
          </View>
          <View style={styles.toggleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.toggleLabel}>Allow break-glass access</Text>
              <Text style={styles.toggleHint}>
                Lets admins bypass consent for genuine emergencies. Heavily
                audited.
              </Text>
            </View>
            <Switch
              value={!!policy.breakGlassAllowed}
              disabled={!policy.requiresConsent}
              onValueChange={(v) =>
                setPolicy((p) => ({ ...(p || {}), breakGlassAllowed: v }))
              }
              trackColor={{ false: theme.surface, true: theme.warning }}
              thumbColor="#fff"
            />
          </View>
          <View style={styles.fieldsRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.fieldLabel}>Max session (min, 5–240)</Text>
              <TextInput
                style={styles.input}
                value={String(policy.maxSessionMinutes ?? "")}
                onChangeText={(v) =>
                  setPolicy((p) => ({ ...(p || {}), maxSessionMinutes: v as never }))
                }
                keyboardType="number-pad"
                placeholderTextColor={theme.textMuted}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.fieldLabel}>Code TTL (min, 1–60)</Text>
              <TextInput
                style={styles.input}
                value={String(policy.codeTtlMinutes ?? "")}
                onChangeText={(v) =>
                  setPolicy((p) => ({ ...(p || {}), codeTtlMinutes: v as never }))
                }
                keyboardType="number-pad"
                placeholderTextColor={theme.textMuted}
              />
            </View>
          </View>
          <Pressable
            style={[styles.saveBtn, saving && styles.disabled]}
            onPress={savePolicy}
            disabled={saving}
          >
            <Text style={styles.saveBtnText}>Save policy</Text>
          </Pressable>
        </View>
      ) : null}

      {/* ─── Security ─── */}
      {config ? (
        <View style={styles.section}>
          <View style={styles.sectionTitleRow}>
            <Lock size={15} color={theme.textSecondary} />
            <Text style={styles.sectionTitle}>Security</Text>
          </View>
          <Text style={styles.note}>
            Platform-wide password and session policies. Applies to all
            tenants.
          </Text>
          <View style={styles.fieldsRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.fieldLabel}>Session timeout (min)</Text>
              <TextInput
                style={styles.input}
                value={cfgStr("session_timeout_minutes")}
                onChangeText={(v) => setConfigKey("session_timeout_minutes", v)}
                keyboardType="number-pad"
                placeholderTextColor={theme.textMuted}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.fieldLabel}>Password min length</Text>
              <TextInput
                style={styles.input}
                value={cfgStr("password_min_length")}
                onChangeText={(v) => setConfigKey("password_min_length", v)}
                keyboardType="number-pad"
                placeholderTextColor={theme.textMuted}
              />
            </View>
          </View>
          {[
            { key: "password_require_uppercase", label: "Require uppercase" },
            { key: "password_require_number", label: "Require number" },
            { key: "password_require_special", label: "Require special character" },
          ].map((row) => (
            <View key={row.key} style={styles.toggleRow}>
              <Text style={styles.toggleLabel}>{row.label}</Text>
              <Switch
                value={cfgBool(row.key)}
                onValueChange={(v) => setConfigKey(row.key, v ? "true" : "false")}
                trackColor={{ false: theme.surface, true: theme.primary }}
                thumbColor="#fff"
              />
            </View>
          ))}
          <Text style={styles.fieldLabel}>
            Allowed email domains (comma-separated, empty = any)
          </Text>
          <TextInput
            style={styles.input}
            value={cfgStr("allowed_email_domains")}
            onChangeText={(v) => setConfigKey("allowed_email_domains", v)}
            placeholder="e.g. company.com, subsidiary.com"
            placeholderTextColor={theme.textMuted}
            autoCapitalize="none"
          />
          <Pressable
            style={[styles.saveBtn, saving && styles.disabled]}
            onPress={() =>
              saveConfig(
                [
                  "session_timeout_minutes",
                  "password_min_length",
                  "password_require_uppercase",
                  "password_require_number",
                  "password_require_special",
                  "allowed_email_domains",
                ],
                "Security settings",
              )
            }
            disabled={saving}
          >
            <Text style={styles.saveBtnText}>Save security settings</Text>
          </Pressable>
        </View>
      ) : null}

      {/* ─── Data Retention ─── */}
      {config ? (
        <View style={styles.section}>
          <View style={styles.sectionTitleRow}>
            <Database size={15} color={theme.textSecondary} />
            <Text style={styles.sectionTitle}>Data Retention</Text>
          </View>
          <Text style={styles.note}>
            Control how long logs and deleted data are retained.
          </Text>
          <Text style={styles.fieldLabel}>Audit log retention (days)</Text>
          <TextInput
            style={styles.input}
            value={cfgStr("audit_log_retention_days")}
            onChangeText={(v) => setConfigKey("audit_log_retention_days", v)}
            keyboardType="number-pad"
            placeholderTextColor={theme.textMuted}
          />
          <Text style={styles.fieldLabel}>Deleted tenant cleanup (days)</Text>
          <TextInput
            style={styles.input}
            value={cfgStr("deleted_tenant_cleanup_days")}
            onChangeText={(v) => setConfigKey("deleted_tenant_cleanup_days", v)}
            keyboardType="number-pad"
            placeholderTextColor={theme.textMuted}
          />
          <Text style={styles.fieldLabel}>Session log retention (days)</Text>
          <TextInput
            style={styles.input}
            value={cfgStr("session_log_retention_days")}
            onChangeText={(v) => setConfigKey("session_log_retention_days", v)}
            keyboardType="number-pad"
            placeholderTextColor={theme.textMuted}
          />
          <Pressable
            style={[styles.saveBtn, saving && styles.disabled]}
            onPress={() =>
              saveConfig(
                [
                  "audit_log_retention_days",
                  "deleted_tenant_cleanup_days",
                  "session_log_retention_days",
                ],
                "Retention policy",
              )
            }
            disabled={saving}
          >
            <Text style={styles.saveBtnText}>Save retention policy</Text>
          </Pressable>
        </View>
      ) : null}

      {/* ─── Global Announcements ─── */}
      <View style={styles.section}>
        <View style={styles.sectionTitleRow}>
          <Megaphone size={15} color={theme.textSecondary} />
          <Text style={styles.sectionTitle}>Global Announcements</Text>
        </View>
        <Text style={styles.note}>
          Announcements visible to all tenants across the platform.
        </Text>
        <TextInput
          style={styles.input}
          value={newMsg}
          onChangeText={setNewMsg}
          placeholder="Announcement message…"
          placeholderTextColor={theme.textMuted}
        />
        <Dropdown
          label="Type"
          value={newType}
          options={ANNOUNCEMENT_TYPES}
          onChange={(v) => setNewType(String(v))}
        />
        <Dropdown
          label="Expiry"
          value={newDuration}
          options={ANNOUNCEMENT_DURATIONS}
          onChange={(v) => setNewDuration(String(v ?? ""))}
        />
        <Pressable
          style={[styles.saveBtn, (saving || !newMsg.trim()) && styles.disabled]}
          onPress={postAnnouncement}
          disabled={saving || !newMsg.trim()}
        >
          <Text style={styles.saveBtnText}>Post announcement</Text>
        </Pressable>

        {announcements.length === 0 ? (
          <Text style={styles.empty}>No announcements</Text>
        ) : (
          announcements.map((a) => (
            <View key={a.id} style={styles.annRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.annMsg} numberOfLines={2}>
                  {a.message}
                </Text>
                <Text style={styles.annMeta}>
                  {a.type} · {a.is_active ? "active" : "inactive"} ·{" "}
                  {new Date(a.created_at).toLocaleDateString()}
                </Text>
              </View>
              <Pressable
                style={styles.iconBtn}
                onPress={() => toggleAnnouncement(a)}
                hitSlop={6}
              >
                {a.is_active ? (
                  <ToggleRight size={20} color={theme.success} />
                ) : (
                  <ToggleLeft size={20} color={theme.textMuted} />
                )}
              </Pressable>
              <Pressable
                style={styles.iconBtn}
                onPress={() => confirmDeleteAnnouncement(a)}
                hitSlop={6}
              >
                <Trash2 size={17} color={theme.danger} />
              </Pressable>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { alignItems: "center", justifyContent: "center" },
  container: { padding: 16, gap: 16, paddingBottom: 60 },
  successMsg: { fontSize: 13, color: theme.success },
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
  note: { fontSize: 12, color: theme.textSecondary, lineHeight: 17 },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 2,
  },
  toggleLabel: { fontSize: 14, color: theme.text, fontWeight: "500" },
  toggleHint: { fontSize: 11, color: theme.textMuted, marginTop: 2 },
  fieldsRow: { flexDirection: "row", gap: 10 },
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
  inputMultiline: { minHeight: 64, textAlignVertical: "top" },
  saveBtn: {
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 4,
  },
  saveBtnText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  disabled: { opacity: 0.5 },
  empty: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: "center",
    paddingVertical: 12,
  },
  annRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: theme.surface,
    borderRadius: theme.radius,
    padding: 12,
  },
  annMsg: { fontSize: 13, color: theme.text, fontWeight: "500" },
  annMeta: { fontSize: 11, color: theme.textMuted, marginTop: 2 },
  iconBtn: { padding: 4 },
});