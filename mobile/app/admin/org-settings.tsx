import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
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
import * as ImagePicker from "expo-image-picker";
import {
  Building2,
  Mail,
  Palette,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  UserCog,
  UserPlus,
  X,
} from "lucide-react-native";
import { theme } from "../../src/theme";
import {
  useKeyboardInset,
  scrollFocusedIntoView,
} from "../../src/hooks/useKeyboardInset";
import { Dropdown } from "../../src/components/Dropdown";
import { useAuth } from "../../src/auth/AuthContext";
import { uploadUrl } from "../../src/config";
import {
  createInviteCode,
  createOrgRole,
  deactivateInviteCode,
  deleteBrandingLogo,
  deleteOrgRole,
  getBranding,
  getEmailTemplates,
  getInviteCodes,
  getOrgRoles,
  getRegistrationSettings,
  revertEmailTemplate,
  updateBrandingAccent,
  updateEmailTemplate,
  updateOrgRole,
  updateOrgSettings,
  updateRegistrationSettings,
  uploadBrandingLogo,
  type EmailTemplate,
  type InviteCode,
  type OrgRole,
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

const PERMISSION_LEVELS = [
  { value: 1, label: "Standard member (level 1)" },
  { value: 2, label: "Team lead (level 2)" },
  { value: 3, label: "Manager (level 3)" },
  { value: 4, label: "HR admin (level 4)" },
];

const TEMPLATE_LABELS: Record<string, string> = {
  leaveApproved: "Leave approved",
  leaveRejected: "Leave rejected",
  leaveRevoked: "Leave revoked",
  taskAssigned: "Task assigned",
  mention: "You were mentioned",
  manualEntryApproved: "Manual entry approved",
  manualEntryRejected: "Manual entry rejected",
  meetingScheduled: "Meeting scheduled",
  meetingUpdated: "Meeting updated",
  meetingCancelled: "Meeting cancelled",
};

const ROLE_COLORS = [
  "#6b7280",
  "#0ea5e9",
  "#8b5cf6",
  "#f59e0b",
  "#10b981",
  "#ef4444",
];

export default function OrgSettingsScreen() {
  const kbInset = useKeyboardInset();
  const { user } = useAuth();
  const isSuper =
    user?.role === "super_admin" || user?.role === "platform_admin";

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // General
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState("");
  const [workHours, setWorkHours] = useState("");
  const [officeStart, setOfficeStart] = useState("");

  // Branding
  const [accent, setAccent] = useState("#2383e2");
  const [logoUrl, setLogoUrl] = useState<string | null>(null);

  // Registration
  const [regMode, setRegMode] = useState("open");
  const [inviteCodes, setInviteCodes] = useState<InviteCode[]>([]);

  // Roles
  const [roles, setRoles] = useState<OrgRole[]>([]);
  const [roleModal, setRoleModal] = useState(false);
  const [editingRole, setEditingRole] = useState<OrgRole | null>(null);
  const [roleKey, setRoleKey] = useState("");
  const [roleLabel, setRoleLabel] = useState("");
  const [roleColor, setRoleColor] = useState(ROLE_COLORS[0]);
  const [roleLevel, setRoleLevel] = useState<string | number | null>(1);

  // Email templates
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [tmplModal, setTmplModal] = useState(false);
  const [editingTmpl, setEditingTmpl] = useState<EmailTemplate | null>(null);
  const [tmplSubject, setTmplSubject] = useState("");
  const [tmplBody, setTmplBody] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const [orgR, brandR, regR, codesR, rolesR, tmplR] =
      await Promise.allSettled([
        getCurrentOrg(),
        getBranding(),
        getRegistrationSettings(),
        getInviteCodes(),
        getOrgRoles(),
        getEmailTemplates(),
      ]);
    if (orgR.status === "fulfilled" && orgR.value.data) {
      const o = orgR.value.data;
      setName(o.name ?? "");
      setTimezone(o.timezone ?? "");
      setWorkHours(o.work_hours_per_day ? String(o.work_hours_per_day) : "");
      setOfficeStart((o as any).office_start_time ?? "");
    }
    if (brandR.status === "fulfilled" && brandR.value.data) {
      if (brandR.value.data.accent_color)
        setAccent(brandR.value.data.accent_color);
      setLogoUrl(brandR.value.data.logo_url ?? null);
    }
    if (regR.status === "fulfilled" && regR.value.data?.mode)
      setRegMode(regR.value.data.mode);
    if (codesR.status === "fulfilled")
      setInviteCodes(
        Array.isArray(codesR.value.data) ? codesR.value.data : [],
      );
    if (rolesR.status === "fulfilled")
      setRoles(rolesR.value.data?.roles ?? []);
    if (tmplR.status === "fulfilled")
      setTemplates(tmplR.value.data?.templates ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /* ── General ── */

  async function saveGeneral() {
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

  /* ── Branding ── */

  async function saveAccent(color: string) {
    setAccent(color);
    try {
      await updateBrandingAccent(color);
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to save accent");
    }
  }

  async function pickLogo() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      quality: 0.9,
    });
    if (result.canceled || !result.assets?.[0]?.uri) return;
    setBusy(true);
    try {
      const r = await uploadBrandingLogo(result.assets[0].uri);
      setLogoUrl(r.data?.logo_url ?? null);
      Alert.alert("Saved", "Logo updated");
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to upload logo");
    } finally {
      setBusy(false);
    }
  }

  function removeLogo() {
    Alert.alert("Remove logo", "Remove the organization logo?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () =>
          deleteBrandingLogo()
            .then(() => setLogoUrl(null))
            .catch((e: any) =>
              Alert.alert("Error", e?.response?.data?.error || "Failed"),
            ),
      },
    ]);
  }

  /* ── Registration ── */

  async function saveRegMode(mode: string | number | null) {
    if (!mode) return;
    setRegMode(String(mode));
    try {
      await updateRegistrationSettings(String(mode));
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to update");
    }
  }

  async function newInviteCode() {
    setBusy(true);
    try {
      await createInviteCode({ expires_in_days: 7 });
      const r = await getInviteCodes();
      setInviteCodes(Array.isArray(r.data) ? r.data : []);
    } catch (e: any) {
      Alert.alert(
        "Error",
        e?.response?.data?.error || "Failed to create invite code",
      );
    } finally {
      setBusy(false);
    }
  }

  function removeInviteCode(c: InviteCode) {
    Alert.alert("Deactivate code", `Deactivate "${c.code}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Deactivate",
        style: "destructive",
        onPress: () =>
          deactivateInviteCode(c.id)
            .then(() => getInviteCodes())
            .then((r) => setInviteCodes(Array.isArray(r.data) ? r.data : []))
            .catch((e: any) =>
              Alert.alert("Error", e?.response?.data?.error || "Failed"),
            ),
      },
    ]);
  }

  /* ── Roles ── */

  function openCreateRole() {
    setEditingRole(null);
    setRoleKey("");
    setRoleLabel("");
    setRoleColor(ROLE_COLORS[0]);
    setRoleLevel(1);
    setRoleModal(true);
  }

  function openEditRole(r: OrgRole) {
    setEditingRole(r);
    setRoleKey(r.role_key);
    setRoleLabel(r.label);
    setRoleColor(r.color || ROLE_COLORS[0]);
    setRoleLevel(r.permission_level);
    setRoleModal(true);
  }

  async function saveRole() {
    if (!roleLabel.trim()) {
      Alert.alert("Required", "Label is required");
      return;
    }
    setBusy(true);
    try {
      if (editingRole) {
        const r = await updateOrgRole(editingRole.role_key, {
          label: roleLabel.trim(),
          color: roleColor,
          permission_level: Number(roleLevel) || 1,
        });
        setRoles(r.data?.roles ?? []);
      } else {
        const key = roleKey.trim().toLowerCase();
        if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) {
          Alert.alert(
            "Invalid key",
            "Role key must be lowercase letters, numbers or underscores, starting with a letter.",
          );
          setBusy(false);
          return;
        }
        const r = await createOrgRole({
          role_key: key,
          label: roleLabel.trim(),
          color: roleColor,
          permission_level: Number(roleLevel) || 1,
        });
        setRoles(r.data?.roles ?? []);
      }
      setRoleModal(false);
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to save role");
    } finally {
      setBusy(false);
    }
  }

  function confirmDeleteRole(r: OrgRole) {
    if ((r.user_count ?? 0) > 0) {
      Alert.alert(
        "Role in use",
        `${r.user_count} user(s) still hold "${r.label}". Reassign them first.`,
      );
      return;
    }
    Alert.alert("Delete role", `Delete "${r.label}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          deleteOrgRole(r.role_key)
            .then((res) => setRoles(res.data?.roles ?? []))
            .catch((e: any) =>
              Alert.alert(
                "Error",
                e?.response?.data?.error || "Failed to delete",
              ),
            ),
      },
    ]);
  }

  /* ── Email templates ── */

  function openEditTemplate(t: EmailTemplate) {
    setEditingTmpl(t);
    setTmplSubject(t.subject);
    setTmplBody(t.body_html);
    setTmplModal(true);
  }

  async function saveTemplate() {
    if (!editingTmpl) return;
    setBusy(true);
    try {
      await updateEmailTemplate(editingTmpl.template_key, {
        subject: tmplSubject,
        body_html: tmplBody,
      });
      setTmplModal(false);
      const r = await getEmailTemplates();
      setTemplates(r.data?.templates ?? []);
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  async function toggleTemplate(t: EmailTemplate, enabled: boolean) {
    // Optimistic toggle.
    setTemplates((list) =>
      list.map((x) =>
        x.template_key === t.template_key ? { ...x, enabled } : x,
      ),
    );
    try {
      await updateEmailTemplate(t.template_key, { enabled });
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to update");
      const r = await getEmailTemplates().catch(() => null);
      if (r) setTemplates(r.data?.templates ?? []);
    }
  }

  function revertTemplate(t: EmailTemplate) {
    Alert.alert(
      "Revert template",
      `Revert "${TEMPLATE_LABELS[t.template_key] || t.template_key}" to the built-in version?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Revert",
          style: "destructive",
          onPress: () =>
            revertEmailTemplate(t.template_key)
              .then(() => getEmailTemplates())
              .then((r) => setTemplates(r.data?.templates ?? []))
              .catch((e: any) =>
                Alert.alert("Error", e?.response?.data?.error || "Failed"),
              ),
        },
      ],
    );
  }

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Stack.Screen options={{ title: "Org Settings" }} />
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  const logoAbs = uploadUrl(logoUrl);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.container, { paddingBottom: 48 + kbInset }]}
    >
      <Stack.Screen options={{ title: "Org Settings" }} />

      {/* ── General ── */}
      <View style={styles.section}>
        <View style={styles.sectionTitleRow}>
          <Building2 size={15} color={theme.textSecondary} />
          <Text style={styles.sectionTitle}>General</Text>
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
        {officeStart ? (
          <Text style={styles.hint}>Office start time: {officeStart}</Text>
        ) : null}
        <Pressable style={styles.saveBtn} onPress={saveGeneral} disabled={busy}>
          <Text style={styles.saveBtnText}>
            {busy ? "Saving…" : "Save organization"}
          </Text>
        </Pressable>
      </View>

      {/* ── Registration ── */}
      {isSuper ? (
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
          <View style={styles.subHeaderRow}>
            <Text style={styles.subHeader}>Invite codes</Text>
            <Pressable style={styles.addBtn} onPress={newInviteCode}>
              <Plus size={14} color={theme.primary} />
              <Text style={styles.addBtnText}>Generate</Text>
            </Pressable>
          </View>
          {inviteCodes.length === 0 ? (
            <Text style={styles.hint}>No invite codes.</Text>
          ) : (
            inviteCodes.map((c) => (
              <View key={c.id} style={styles.itemRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.codeText}>{c.code}</Text>
                  <Text style={styles.itemMeta}>
                    {c.is_active === false ? "inactive · " : ""}
                    {c.uses ?? 0}
                    {c.max_uses ? `/${c.max_uses}` : ""} uses
                    {c.expires_at
                      ? ` · expires ${new Date(c.expires_at).toLocaleDateString()}`
                      : ""}
                  </Text>
                </View>
                {c.is_active !== false ? (
                  <Pressable
                    style={styles.iconBtn}
                    onPress={() => removeInviteCode(c)}
                    hitSlop={6}
                  >
                    <Trash2 size={15} color={theme.danger} />
                  </Pressable>
                ) : null}
              </View>
            ))
          )}
        </View>
      ) : null}

      {/* ── Roles ── */}
      <View style={styles.section}>
        <View style={styles.subHeaderRow}>
          <View style={styles.sectionTitleRow}>
            <UserCog size={15} color={theme.textSecondary} />
            <Text style={styles.sectionTitle}>Roles</Text>
          </View>
          {isSuper ? (
            <Pressable style={styles.addBtn} onPress={openCreateRole}>
              <Plus size={14} color={theme.primary} />
              <Text style={styles.addBtnText}>Add</Text>
            </Pressable>
          ) : null}
        </View>
        {roles.length === 0 ? (
          <Text style={styles.hint}>No roles defined.</Text>
        ) : (
          roles.map((r) => (
            <View key={r.role_key} style={styles.itemRow}>
              <View
                style={[
                  styles.colorDot,
                  { backgroundColor: r.color || "#888" },
                ]}
              />
              <View style={{ flex: 1 }}>
                <Text style={styles.itemName}>{r.label}</Text>
                <Text style={styles.itemMeta}>
                  {r.role_key} · level {r.permission_level}
                  {r.user_count != null ? ` · ${r.user_count} users` : ""}
                </Text>
              </View>
              {isSuper ? (
                <>
                  <Pressable
                    style={styles.iconBtn}
                    onPress={() => openEditRole(r)}
                    hitSlop={6}
                  >
                    <Pencil size={15} color={theme.textSecondary} />
                  </Pressable>
                  {!r.is_system ? (
                    <Pressable
                      style={styles.iconBtn}
                      onPress={() => confirmDeleteRole(r)}
                      hitSlop={6}
                    >
                      <Trash2 size={15} color={theme.danger} />
                    </Pressable>
                  ) : null}
                </>
              ) : null}
            </View>
          ))
        )}
      </View>

      {/* ── Branding ── */}
      <View style={styles.section}>
        <View style={styles.sectionTitleRow}>
          <Palette size={15} color={theme.textSecondary} />
          <Text style={styles.sectionTitle}>Branding</Text>
        </View>
        <Text style={styles.fieldLabel}>Logo</Text>
        <View style={styles.logoRow}>
          {logoAbs ? (
            <Image source={{ uri: logoAbs }} style={styles.logoPreview} />
          ) : (
            <View style={[styles.logoPreview, styles.logoPlaceholder]}>
              <Text style={styles.hint}>No logo</Text>
            </View>
          )}
          <View style={{ gap: 8 }}>
            <Pressable style={styles.smallBtn} onPress={pickLogo}>
              <Text style={styles.smallBtnText}>
                {logoAbs ? "Change logo" : "Upload logo"}
              </Text>
            </Pressable>
            {logoAbs ? (
              <Pressable style={styles.smallBtnDanger} onPress={removeLogo}>
                <Text style={styles.smallBtnDangerText}>Remove</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
        <Text style={styles.fieldLabel}>Accent color</Text>
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

      {/* ── Email templates ── */}
      <View style={styles.section}>
        <View style={styles.sectionTitleRow}>
          <Mail size={15} color={theme.textSecondary} />
          <Text style={styles.sectionTitle}>Email templates</Text>
        </View>
        {templates.length === 0 ? (
          <Text style={styles.hint}>No email templates available.</Text>
        ) : (
          templates.map((t) => (
            <View key={t.template_key} style={styles.itemRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.itemName}>
                  {TEMPLATE_LABELS[t.template_key] || t.template_key}
                  {t.is_overridden ? "  ·  customised" : ""}
                </Text>
                <Text style={styles.itemMeta} numberOfLines={1}>
                  {t.subject}
                </Text>
              </View>
              <Switch
                value={t.enabled}
                onValueChange={(v) => toggleTemplate(t, v)}
                trackColor={{ true: theme.primary, false: theme.surface }}
                thumbColor="#fff"
              />
              <Pressable
                style={styles.iconBtn}
                onPress={() => openEditTemplate(t)}
                hitSlop={6}
              >
                <Pencil size={15} color={theme.textSecondary} />
              </Pressable>
              {t.is_overridden ? (
                <Pressable
                  style={styles.iconBtn}
                  onPress={() => revertTemplate(t)}
                  hitSlop={6}
                >
                  <RotateCcw size={15} color={theme.warning} />
                </Pressable>
              ) : null}
            </View>
          ))
        )}
      </View>

      {/* ── Role modal ── */}
      <Modal
        visible={roleModal}
        transparent
        animationType="slide"
        onRequestClose={() => setRoleModal(false)}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <Pressable
            style={styles.modalScrim}
            onPress={() => setRoleModal(false)}
          />
          <View style={[styles.sheet, { marginBottom: kbInset }]}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>
                {editingRole ? "Edit role" : "New role"}
              </Text>
              <Pressable onPress={() => setRoleModal(false)} hitSlop={8}>
                <X size={22} color={theme.textSecondary} />
              </Pressable>
            </View>
            {!editingRole ? (
              <>
                <Text style={styles.fieldLabel}>Role key</Text>
                <TextInput
                  style={styles.input}
                  value={roleKey}
                  onChangeText={(t) => setRoleKey(t.toLowerCase())}
                  placeholder="e.g. principal_engineer"
                  placeholderTextColor={theme.textMuted}
                  autoCapitalize="none"
                />
              </>
            ) : null}
            <Text style={styles.fieldLabel}>Label</Text>
            <TextInput
              style={styles.input}
              value={roleLabel}
              onChangeText={setRoleLabel}
              placeholder="e.g. Principal Engineer"
              placeholderTextColor={theme.textMuted}
            />
            <Text style={styles.fieldLabel}>Permission level</Text>
            <Dropdown
              label="Permission level"
              value={roleLevel}
              options={PERMISSION_LEVELS}
              onChange={setRoleLevel}
            />
            <Text style={styles.fieldLabel}>Color</Text>
            <View style={styles.swatchRow}>
              {ROLE_COLORS.map((c) => (
                <Pressable
                  key={c}
                  style={[
                    styles.swatch,
                    { backgroundColor: c },
                    roleColor === c && styles.swatchActive,
                  ]}
                  onPress={() => setRoleColor(c)}
                />
              ))}
            </View>
            <Pressable style={styles.saveBtn} onPress={saveRole} disabled={busy}>
              <Text style={styles.saveBtnText}>
                {busy ? "Saving…" : editingRole ? "Save changes" : "Create role"}
              </Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Email template modal ── */}
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
              <Text style={styles.sheetTitle} numberOfLines={1}>
                {editingTmpl
                  ? TEMPLATE_LABELS[editingTmpl.template_key] ||
                    editingTmpl.template_key
                  : "Template"}
              </Text>
              <Pressable onPress={() => setTmplModal(false)} hitSlop={8}>
                <X size={22} color={theme.textSecondary} />
              </Pressable>
            </View>
            <Text style={styles.fieldLabel}>Subject</Text>
            <TextInput
              style={styles.input}
              value={tmplSubject}
              onChangeText={setTmplSubject}
              placeholder="Email subject"
              placeholderTextColor={theme.textMuted}
            />
            <Text style={styles.fieldLabel}>Body (HTML)</Text>
            <TextInput
              style={[styles.input, styles.inputTall]}
              value={tmplBody}
              onChangeText={setTmplBody}
              placeholder="<p>Hello…</p>"
              placeholderTextColor={theme.textMuted}
              multiline
            />
            <Pressable
              style={styles.saveBtn}
              onPress={saveTemplate}
              disabled={busy}
            >
              <Text style={styles.saveBtnText}>
                {busy ? "Saving…" : "Save template"}
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
  subHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 4,
  },
  subHeader: { fontSize: 13, fontWeight: "600", color: theme.textSecondary },
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
  inputTall: { minHeight: 120, textAlignVertical: "top" },
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
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 3,
    borderColor: "transparent",
  },
  swatchActive: { borderColor: theme.text },
  hint: { fontSize: 12, color: theme.textMuted },
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
  codeText: {
    fontSize: 14,
    fontWeight: "700",
    color: theme.text,
    letterSpacing: 1,
  },
  iconBtn: { padding: 6 },
  logoRow: { flexDirection: "row", alignItems: "center", gap: 16 },
  logoPreview: {
    width: 72,
    height: 72,
    borderRadius: theme.radiusSm,
    backgroundColor: theme.surface,
  },
  logoPlaceholder: {
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: theme.glassBorder,
  },
  smallBtn: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  smallBtnText: { color: theme.text, fontSize: 13, fontWeight: "600" },
  smallBtnDanger: {
    borderWidth: 1,
    borderColor: theme.danger,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  smallBtnDangerText: { color: theme.danger, fontSize: 13, fontWeight: "600" },
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
    gap: 12,
  },
  sheetTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: "700",
    color: theme.text,
  },
});