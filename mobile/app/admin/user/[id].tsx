import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import {
  Ban,
  CheckCircle2,
  KeyRound,
  Mail,
  Shield,
  Trash2,
  UserCog,
} from "../../../src/icons";
import { useAuth } from "../../../src/auth/AuthContext";
import type { Theme } from "../../../src/theme";
import { useTheme } from "../../../src/theme/ThemeProvider";
import { uploadUrl } from "../../../src/config";
import {
  Dropdown,
  type DropdownOption,
} from "../../../src/components/Dropdown";
import { ROLES, roleLabel, canManageRole } from "../../../src/constants/roles";
import {
  adminResetPassword,
  cancelRoleChange,
  deleteAdminUser,
  getAdminUser,
  getRoleChangeRequests,
  toggleUserActive,
  updateUserAssignment,
  updateUserRole,
} from "../../../src/admin";
import {
  getOrgDepartments,
  getOrgTeams,
  getAssignableUsers,
  type AssignableUser,
} from "../../../src/features";

function initials(name?: string) {
  if (!name) return "?";
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "?";
}

const EMPTY_OPTIONS: DropdownOption[] = [];

export default function AdminUserDetail() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user: me } = useAuth();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  // Editable assignment + role state
  const [role, setRole] = useState<string>("");
  const [roleReason, setRoleReason] = useState("");
  const [deptId, setDeptId] = useState<string | number | null>(null);
  const [teamId, setTeamId] = useState<string | number | null>(null);
  const [managerId, setManagerId] = useState<string | number | null>(null);

  const [pwOpen, setPwOpen] = useState(false);
  const [newPw, setNewPw] = useState("");

  // super_admin / platform_admin apply role changes immediately; everyone
  // else (e.g. hr_admin) submits a role-change request that needs approval.
  const isDirectRoleEditor =
    me?.role === "super_admin" || me?.role === "platform_admin";

  const { data: record, isLoading: loading } = useQuery({
    queryKey: ["admin", "user", id],
    queryFn: async () => (await getAdminUser(id)).data,
    enabled: !!id,
  });
  const u = record ?? null;

  // Pending role-change request for this user (if any). Keyed under the user so
  // invalidating ["admin","user", id] also refetches this after mutations.
  const { data: pendingRequest = null } = useQuery({
    queryKey: ["admin", "user", id, "pendingRoleRequest"],
    queryFn: async () => {
      const { data: reqs } = await getRoleChangeRequests({ status: "pending" });
      return (
        (reqs || []).find((r) => String(r.target_user_id) === String(id)) ||
        null
      );
    },
    enabled: !!id,
  });

  // Reference data for the assignment dropdowns.
  const { data: departments = EMPTY_OPTIONS } = useQuery({
    queryKey: ["admin", "orgDepartments"],
    queryFn: async () => {
      const { data } = await getOrgDepartments();
      return [
        { value: null, label: "— None —" },
        ...(data || []).map((d) => ({ value: d.id, label: d.name })),
      ] as DropdownOption[];
    },
  });
  const { data: teams = EMPTY_OPTIONS } = useQuery({
    queryKey: ["admin", "orgTeams"],
    queryFn: async () => {
      const { data } = await getOrgTeams();
      return [
        { value: null, label: "— None —" },
        ...(data || []).map((t) => ({ value: t.id, label: t.name })),
      ] as DropdownOption[];
    },
  });
  const { data: managers = EMPTY_OPTIONS } = useQuery({
    queryKey: ["admin", "assignableUsers"],
    queryFn: async () => {
      const { data } = await getAssignableUsers();
      return [
        { value: null, label: "— None —" },
        ...(data as AssignableUser[]).map((m) => ({
          value: m.id,
          label: m.full_name,
        })),
      ] as DropdownOption[];
    },
  });

  // Populate the editable form fields whenever the user record arrives
  // (cold load or after a mutation invalidation), mirroring the old load().
  useEffect(() => {
    if (!record) return;
    setRole(record.role);
    setRoleReason("");
    setDeptId(record.department_id ?? null);
    setTeamId(record.team_id ?? null);
    setManagerId(record.manager_id ?? null);
  }, [record]);

  if (loading || !u) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Stack.Screen options={{ title: "User" }} />
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  const isSelf = me?.id === u.id;
  const canManage =
    me?.role === "platform_admin" || canManageRole(me?.role ?? "", u.role);
  const avatar = uploadUrl(u.avatar);

  const roleOptions: DropdownOption[] = ROLES.filter((r) =>
    me?.role === "platform_admin" ? true : canManageRole(me?.role ?? "", r),
  ).map((r) => ({ value: r, label: roleLabel(r) }));

  async function saveRole() {
    if (!u || role === u.role) return;
    setBusy(true);
    try {
      const { data } = await updateUserRole(
        u.id,
        role,
        roleReason || undefined,
      );
      Alert.alert(
        "Role",
        data.message ||
          (isDirectRoleEditor
            ? "Role updated"
            : "Role change request submitted"),
      );
      setRoleReason("");
      queryClient.invalidateQueries({ queryKey: ["admin", "user", id] });
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to update role");
      setRole(u.role);
    } finally {
      setBusy(false);
    }
  }

  async function cancelPendingRole() {
    if (!pendingRequest) return;
    setBusy(true);
    try {
      await cancelRoleChange(pendingRequest.id);
      Alert.alert("Cancelled", "Role change request cancelled");
      queryClient.invalidateQueries({ queryKey: ["admin", "user", id] });
    } catch (e: any) {
      Alert.alert(
        "Error",
        e?.response?.data?.error || "Failed to cancel request",
      );
    } finally {
      setBusy(false);
    }
  }

  async function saveAssignment() {
    if (!u) return;
    setBusy(true);
    try {
      await updateUserAssignment(u.id, {
        department_id: deptId ? Number(deptId) : null,
        team_id: teamId ? Number(teamId) : null,
        manager_id: managerId ? Number(managerId) : null,
      });
      Alert.alert("Saved", "Assignment updated");
      queryClient.invalidateQueries({ queryKey: ["admin", "user", id] });
    } catch (e: any) {
      Alert.alert(
        "Error",
        e?.response?.data?.error || "Failed to update assignment",
      );
    } finally {
      setBusy(false);
    }
  }

  function confirmToggleActive() {
    if (!u) return;
    const action = u.is_active ? "Deactivate" : "Reactivate";
    Alert.alert(`${action} user`, `${action} ${u.full_name}?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: action,
        style: u.is_active ? "destructive" : "default",
        onPress: async () => {
          setBusy(true);
          try {
            await toggleUserActive(u.id);
            queryClient.invalidateQueries({ queryKey: ["admin", "user", id] });
          } catch (e: any) {
            Alert.alert("Error", e?.response?.data?.error || "Failed");
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  }

  async function submitResetPassword() {
    if (!u) return;
    if (newPw.length < 8) {
      Alert.alert("Invalid", "Password must be at least 8 characters");
      return;
    }
    setBusy(true);
    try {
      const { data } = await adminResetPassword(u.id, newPw);
      Alert.alert("Done", data.message || "Password reset");
      setPwOpen(false);
      setNewPw("");
    } catch (e: any) {
      Alert.alert(
        "Error",
        e?.response?.data?.error || "Failed to reset password",
      );
    } finally {
      setBusy(false);
    }
  }

  function confirmDelete() {
    if (!u) return;
    Alert.alert(
      "Delete user",
      `Permanently delete ${u.full_name}? This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setBusy(true);
            try {
              await deleteAdminUser(u.id);
              router.back();
            } catch (e: any) {
              Alert.alert(
                "Error",
                e?.response?.data?.error || "Failed to delete",
              );
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: u.full_name }} />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.avatar}>
          {avatar ? (
            <Image source={{ uri: avatar }} style={styles.avatarImg} />
          ) : (
            <Text style={styles.avatarText}>{initials(u.full_name)}</Text>
          )}
        </View>
        <Text style={styles.name}>{u.full_name}</Text>
        <Text style={styles.username}>@{u.username}</Text>
        <View style={styles.statusRow}>
          <View style={styles.roleBadge}>
            <Text style={styles.roleText}>{roleLabel(u.role)}</Text>
          </View>
          {u.is_active ? (
            <View
              style={[
                styles.statusPill,
                { backgroundColor: theme.success + "22" },
              ]}
            >
              <CheckCircle2 size={13} color={theme.success} />
              <Text style={[styles.statusText, { color: theme.success }]}>
                Active
              </Text>
            </View>
          ) : (
            <View
              style={[
                styles.statusPill,
                { backgroundColor: theme.danger + "22" },
              ]}
            >
              <Ban size={13} color={theme.danger} />
              <Text style={[styles.statusText, { color: theme.danger }]}>
                Inactive
              </Text>
            </View>
          )}
        </View>
        {u.email ? (
          <View style={styles.emailRow}>
            <Mail size={13} color={theme.textMuted} />
            <Text style={styles.emailText}>{u.email}</Text>
          </View>
        ) : null}
      </View>

      {!canManage ? (
        <Text style={styles.noManage}>
          You don't have permission to manage this user.
        </Text>
      ) : (
        <>
          {/* Pending role request banner */}
          {pendingRequest ? (
            <View style={styles.pendingBanner}>
              <Text style={styles.pendingText}>
                Pending role change:{" "}
                <Text style={styles.pendingStrong}>
                  {roleLabel(
                    pendingRequest.from_role ||
                      pendingRequest.current_role ||
                      "",
                  )}
                </Text>{" "}
                →{" "}
                <Text style={styles.pendingStrong}>
                  {roleLabel(
                    pendingRequest.to_role ||
                      pendingRequest.requested_role ||
                      "",
                  )}
                </Text>
              </Text>
              <Pressable
                style={styles.cancelReqBtn}
                onPress={cancelPendingRole}
                disabled={busy}
              >
                <Text style={styles.cancelReqText}>Cancel request</Text>
              </Pressable>
            </View>
          ) : null}

          {/* Role */}
          <View style={styles.section}>
            <View style={styles.sectionTitleRow}>
              <Shield size={15} color={theme.textSecondary} />
              <Text style={styles.sectionTitle}>Role</Text>
            </View>
            <Dropdown
              label="Role"
              value={role}
              options={roleOptions}
              onChange={(v) => setRole(String(v))}
            />
            {/* hr_admin (non-direct editors) must supply a reason shown to
                approvers when requesting a role change. */}
            {role !== u.role && !isDirectRoleEditor ? (
              <>
                <Text style={styles.fieldLabel}>
                  Reason (shown to approvers)
                </Text>
                <TextInput
                  style={styles.input}
                  value={roleReason}
                  onChangeText={setRoleReason}
                  placeholder="Why this change?"
                  placeholderTextColor={theme.textMuted}
                />
              </>
            ) : null}
            {role !== u.role ? (
              <Pressable
                style={styles.saveBtn}
                onPress={saveRole}
                disabled={busy || !!pendingRequest}
              >
                <Text style={styles.saveBtnText}>
                  {busy
                    ? "Saving…"
                    : isDirectRoleEditor
                      ? "Update role"
                      : "Submit role request"}
                </Text>
              </Pressable>
            ) : null}
          </View>

          {/* Assignment */}
          <View style={styles.section}>
            <View style={styles.sectionTitleRow}>
              <UserCog size={15} color={theme.textSecondary} />
              <Text style={styles.sectionTitle}>Assignment</Text>
            </View>
            <Text style={styles.fieldLabel}>Department</Text>
            <Dropdown
              label="Department"
              value={deptId}
              options={departments}
              onChange={setDeptId}
            />
            <Text style={styles.fieldLabel}>Team</Text>
            <Dropdown
              label="Team"
              value={teamId}
              options={teams}
              onChange={setTeamId}
            />
            <Text style={styles.fieldLabel}>Manager</Text>
            <Dropdown
              label="Manager"
              value={managerId}
              options={managers}
              onChange={setManagerId}
            />
            <Pressable
              style={styles.saveBtn}
              onPress={saveAssignment}
              disabled={busy}
            >
              <Text style={styles.saveBtnText}>
                {busy ? "Saving…" : "Save assignment"}
              </Text>
            </Pressable>
          </View>

          {/* Reset password */}
          <View style={styles.section}>
            <View style={styles.sectionTitleRow}>
              <KeyRound size={15} color={theme.textSecondary} />
              <Text style={styles.sectionTitle}>Reset password</Text>
            </View>
            {pwOpen ? (
              <>
                <TextInput
                  style={styles.input}
                  value={newPw}
                  onChangeText={setNewPw}
                  placeholder="New password (min 8 chars)"
                  placeholderTextColor={theme.textMuted}
                  secureTextEntry
                  autoCapitalize="none"
                />
                <View style={styles.btnRow}>
                  <Pressable
                    style={[styles.saveBtn, styles.flex1]}
                    onPress={submitResetPassword}
                    disabled={busy}
                  >
                    <Text style={styles.saveBtnText}>
                      {busy ? "Saving…" : "Set password"}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={[styles.cancelBtn, styles.flex1]}
                    onPress={() => {
                      setPwOpen(false);
                      setNewPw("");
                    }}
                  >
                    <Text style={styles.cancelBtnText}>Cancel</Text>
                  </Pressable>
                </View>
              </>
            ) : (
              <Pressable
                style={styles.outlineBtn}
                onPress={() => setPwOpen(true)}
              >
                <KeyRound size={15} color={theme.text} />
                <Text style={styles.outlineBtnText}>Reset password</Text>
              </Pressable>
            )}
          </View>

          {/* Danger zone */}
          {!isSelf ? (
            <View style={styles.section}>
              <Text style={styles.dangerTitle}>Danger zone</Text>
              <Pressable
                style={styles.dangerBtn}
                onPress={confirmToggleActive}
                disabled={busy}
              >
                {u.is_active ? (
                  <Ban size={15} color={theme.warning} />
                ) : (
                  <CheckCircle2 size={15} color={theme.success} />
                )}
                <Text
                  style={[
                    styles.dangerBtnText,
                    { color: u.is_active ? theme.warning : theme.success },
                  ]}
                >
                  {u.is_active ? "Deactivate user" : "Reactivate user"}
                </Text>
              </Pressable>
              {me?.role === "super_admin" || me?.role === "platform_admin" ? (
                <Pressable
                  style={styles.dangerBtn}
                  onPress={confirmDelete}
                  disabled={busy}
                >
                  <Trash2 size={15} color={theme.danger} />
                  <Text style={[styles.dangerBtnText, { color: theme.danger }]}>
                    Delete user
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.bg },
    center: { alignItems: "center", justifyContent: "center" },
    container: { padding: 16, gap: 16, paddingBottom: 48 },
    header: {
      alignItems: "center",
      gap: 6,
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radiusLg,
      padding: 20,
    },
    avatar: {
      width: 72,
      height: 72,
      borderRadius: 36,
      backgroundColor: theme.primary,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 4,
    },
    avatarImg: { width: 72, height: 72, borderRadius: 36 },
    avatarText: { color: "#fff", fontSize: 24, fontWeight: "700" },
    name: { fontSize: 20, fontWeight: "800", color: theme.text },
    username: { fontSize: 13, color: theme.textMuted },
    statusRow: {
      flexDirection: "row",
      gap: 8,
      marginTop: 6,
      alignItems: "center",
    },
    roleBadge: {
      backgroundColor: theme.primaryGlow,
      borderRadius: theme.radiusFull,
      paddingHorizontal: 12,
      paddingVertical: 4,
    },
    roleText: { color: theme.primaryLight, fontSize: 12, fontWeight: "600" },
    statusPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      borderRadius: theme.radiusFull,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    statusText: { fontSize: 12, fontWeight: "600" },
    emailRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      marginTop: 6,
    },
    emailText: { fontSize: 13, color: theme.textSecondary },
    noManage: {
      color: theme.textMuted,
      fontSize: 13,
      textAlign: "center",
      paddingVertical: 20,
    },
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
    fieldLabel: {
      fontSize: 12,
      color: theme.textSecondary,
      fontWeight: "500",
      marginTop: 2,
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
    saveBtn: {
      backgroundColor: theme.primary,
      borderRadius: theme.radiusSm,
      paddingVertical: 12,
      alignItems: "center",
      marginTop: 4,
    },
    saveBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
    cancelBtn: {
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radiusSm,
      paddingVertical: 12,
      alignItems: "center",
      marginTop: 4,
    },
    cancelBtnText: {
      color: theme.textSecondary,
      fontSize: 15,
      fontWeight: "600",
    },
    btnRow: { flexDirection: "row", gap: 10 },
    flex1: { flex: 1 },
    outlineBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radiusSm,
      paddingVertical: 12,
    },
    outlineBtnText: { color: theme.text, fontSize: 15, fontWeight: "600" },
    dangerTitle: {
      fontSize: 13,
      fontWeight: "700",
      color: theme.danger,
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    dangerBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radiusSm,
      paddingVertical: 12,
      paddingHorizontal: 14,
    },
    dangerBtnText: { fontSize: 14, fontWeight: "600" },
    pendingBanner: {
      backgroundColor: theme.warning + "1F",
      borderWidth: 1,
      borderColor: theme.warning + "44",
      borderRadius: theme.radiusLg,
      padding: 14,
      gap: 10,
    },
    pendingText: { color: theme.text, fontSize: 13 },
    pendingStrong: { fontWeight: "700", color: theme.text },
    cancelReqBtn: {
      alignSelf: "flex-start",
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radiusSm,
      paddingVertical: 8,
      paddingHorizontal: 14,
    },
    cancelReqText: {
      color: theme.textSecondary,
      fontSize: 13,
      fontWeight: "600",
    },
  });
