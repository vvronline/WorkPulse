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
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import {
  Building2,
  Database,
  Globe,
  HardDrive,
  MessageSquare,
  Pause,
  Play,
  Trash2,
  Users,
} from "lucide-react-native";
import { theme } from "../../src/theme";
import { roleLabel } from "../../src/constants/roles";
import { PromptModal } from "../../src/components/PromptModal";
import { Dropdown, type DropdownOption } from "../../src/components/Dropdown";
import {
  deleteTenant,
  getPlanCatalog,
  getTenant,
  getTenantStats,
  getTenantUsers,
  reactivateTenant,
  suspendTenant,
  updateTenantLimits,
  updateTenantPlan,
  type PlanCatalog,
  type Tenant,
  type TenantStats,
  type TenantUser,
} from "../../src/admin";

function statusColor(status?: string): string {
  if (status === "suspended") return theme.warning;
  if (status === "deleted") return theme.danger;
  return theme.success;
}

type ConfirmAction = { action: "suspend" | "delete" };

export default function TenantDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [stats, setStats] = useState<TenantStats | null>(null);
  const [users, setUsers] = useState<TenantUser[]>([]);
  const [catalog, setCatalog] = useState<PlanCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Settings edit state
  const [maxUsers, setMaxUsers] = useState("");
  const [maxStorage, setMaxStorage] = useState("");
  const [settingsMsg, setSettingsMsg] = useState<string | null>(null);

  // Password-confirm modal for suspend/delete (server requires re-auth).
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [tRes, sRes, cRes] = await Promise.allSettled([
      getTenant(id),
      getTenantStats(id),
      getPlanCatalog(),
    ]);
    let t: Tenant | null = null;
    if (tRes.status === "fulfilled") {
      t = tRes.value.data;
      setTenant(t);
      setMaxUsers(t.max_users != null ? String(t.max_users) : "");
      setMaxStorage(t.max_storage_mb != null ? String(t.max_storage_mb) : "");
    }
    if (sRes.status === "fulfilled") setStats(sRes.value.data);
    if (cRes.status === "fulfilled") setCatalog(cRes.value.data);
    // User PII is only exposed for the default tenant (server enforces this
    // with a 403 for everyone else) — skip the call entirely otherwise.
    if (t?.is_default) {
      try {
        const uRes = await getTenantUsers(id, { limit: 50 });
        setUsers(uRes.data.users ?? []);
      } catch {
        setUsers([]);
      }
    } else {
      setUsers([]);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading || !tenant) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Stack.Screen options={{ title: "Tenant" }} />
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  async function submitConfirm(values: Record<string, string>) {
    if (!confirm || !tenant) return;
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      if (confirm.action === "suspend") {
        await suspendTenant(
          tenant.id,
          values.reason?.trim() || "Suspended by platform admin",
          values.password,
        );
        setConfirm(null);
        await load();
      } else {
        await deleteTenant(tenant.id, false, values.password);
        setConfirm(null);
        router.back();
      }
    } catch (e: any) {
      setConfirmError(e?.response?.data?.error || "Action failed");
    } finally {
      setConfirmBusy(false);
    }
  }

  function reactivate() {
    if (!tenant) return;
    setBusy(true);
    reactivateTenant(tenant.id)
      .then(() => load())
      .catch((e: any) =>
        Alert.alert("Error", e?.response?.data?.error || "Failed"),
      )
      .finally(() => setBusy(false));
  }

  async function changePlan(plan: string) {
    if (!tenant || plan === tenant.plan) return;
    setBusy(true);
    setSettingsMsg(null);
    try {
      await updateTenantPlan(tenant.id, plan, true);
      setSettingsMsg("Plan updated");
      await load();
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to change plan");
    } finally {
      setBusy(false);
    }
  }

  async function saveLimits() {
    if (!tenant) return;
    setBusy(true);
    setSettingsMsg(null);
    try {
      await updateTenantLimits(tenant.id, {
        max_users: maxUsers ? Number(maxUsers) : null,
        max_storage_mb: maxStorage ? Number(maxStorage) : null,
      });
      setSettingsMsg("Limits updated");
      await load();
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to save limits");
    } finally {
      setBusy(false);
    }
  }

  const planOptions: DropdownOption[] = catalog
    ? Object.entries(catalog.plans).map(([key, p]) => ({
        value: key,
        label: p.label || key,
      }))
    : [];

  const dbSizeMb =
    stats?.db_size_bytes != null
      ? (stats.db_size_bytes / 1024 / 1024).toFixed(1)
      : null;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <Stack.Screen options={{ title: tenant.org_name }} />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.icon}>
          <Building2 size={26} color={theme.primary} />
        </View>
        <Text style={styles.name}>{tenant.org_name}</Text>
        {tenant.slug ? <Text style={styles.domain}>{tenant.slug}</Text> : null}
        <View
          style={[
            styles.statusPill,
            { backgroundColor: statusColor(tenant.status) + "22" },
          ]}
        >
          <Text style={[styles.statusText, { color: statusColor(tenant.status) }]}>
            {tenant.status || "active"}
          </Text>
        </View>
        {tenant.plan ? (
          <Text style={styles.plan}>
            Plan: {catalog?.plans?.[tenant.plan]?.label || tenant.plan}
          </Text>
        ) : null}
      </View>

      {/* Stats */}
      <View style={styles.statsRow}>
        <Stat value={tenant.user_count ?? stats?.user_count ?? 0} label="Users" />
        <View style={styles.statDivider} />
        <Stat value={stats?.task_count ?? 0} label="Tasks" />
        <View style={styles.statDivider} />
        <Stat value={stats?.message_count ?? 0} label="Messages" />
        <View style={styles.statDivider} />
        <Stat value={dbSizeMb != null ? `${dbSizeMb}` : "—"} label="DB (MB)" />
      </View>

      {/* Info cards */}
      <View style={styles.infoGrid}>
        <InfoCard
          icon={<Globe size={15} color={theme.primary} />}
          label="Custom domain"
          value={tenant.custom_domain || "None"}
        />
        <InfoCard
          icon={<Database size={15} color={theme.primary} />}
          label="Database"
          value={tenant.db_name || "—"}
        />
        <InfoCard
          icon={<Users size={15} color={theme.primary} />}
          label="Max users"
          value={tenant.max_users ? String(tenant.max_users) : "∞"}
        />
        <InfoCard
          icon={<HardDrive size={15} color={theme.primary} />}
          label="Max storage"
          value={tenant.max_storage_mb ? `${tenant.max_storage_mb} MB` : "∞"}
        />
      </View>

      {/* Lifecycle actions */}
      {tenant.status !== "deleted" ? (
        <View style={styles.actionsCol}>
          {tenant.status === "suspended" ? (
            <Pressable
              style={[styles.actionBtn, styles.reactivateBtn]}
              onPress={reactivate}
              disabled={busy}
            >
              <Play size={16} color="#fff" />
              <Text style={[styles.actionBtnText, { color: "#fff" }]}>
                Reactivate tenant
              </Text>
            </Pressable>
          ) : !tenant.is_default ? (
            <Pressable
              style={[styles.actionBtn, styles.suspendBtn]}
              onPress={() => setConfirm({ action: "suspend" })}
              disabled={busy}
            >
              <Pause size={16} color={theme.warning} />
              <Text style={[styles.actionBtnText, { color: theme.warning }]}>
                Suspend tenant
              </Text>
            </Pressable>
          ) : null}
          {!tenant.is_default ? (
            <Pressable
              style={[styles.actionBtn, styles.deleteBtn]}
              onPress={() => setConfirm({ action: "delete" })}
              disabled={busy}
            >
              <Trash2 size={16} color={theme.danger} />
              <Text style={[styles.actionBtnText, { color: theme.danger }]}>
                Delete tenant
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {/* Settings: plan + limits */}
      <View style={styles.settingsCard}>
        <Text style={styles.sectionTitle}>Settings</Text>
        {settingsMsg ? <Text style={styles.settingsMsg}>{settingsMsg}</Text> : null}

        {planOptions.length > 0 ? (
          <>
            <Text style={styles.fieldLabel}>Subscription plan</Text>
            <Dropdown
              label="Plan"
              value={tenant.plan || "standard"}
              options={planOptions}
              onChange={(v) => changePlan(String(v))}
            />
          </>
        ) : null}

        <Text style={styles.fieldLabel}>Max users</Text>
        <TextInput
          style={styles.input}
          value={maxUsers}
          onChangeText={setMaxUsers}
          placeholder="∞"
          placeholderTextColor={theme.textMuted}
          keyboardType="number-pad"
        />
        <Text style={styles.fieldLabel}>Max storage (MB)</Text>
        <TextInput
          style={styles.input}
          value={maxStorage}
          onChangeText={setMaxStorage}
          placeholder="∞"
          placeholderTextColor={theme.textMuted}
          keyboardType="number-pad"
        />
        <Pressable style={styles.saveBtn} onPress={saveLimits} disabled={busy}>
          <Text style={styles.saveBtnText}>
            {busy ? "Saving…" : "Save limits"}
          </Text>
        </Pressable>
      </View>

      {/* Users — default tenant only (PII privacy guard, mirrors web) */}
      {tenant.is_default ? (
        <>
          <View style={styles.sectionHeader}>
            <Users size={15} color={theme.textSecondary} />
            <Text style={styles.sectionTitle}>Users ({users.length})</Text>
          </View>
          {users.length === 0 ? (
            <Text style={styles.empty}>No users.</Text>
          ) : (
            users.map((u) => (
              <View key={u.id} style={styles.userCard}>
                <View style={styles.userBody}>
                  <Text style={styles.userName} numberOfLines={1}>
                    {u.full_name}
                  </Text>
                  <Text style={styles.userMeta} numberOfLines={1}>
                    {u.email || `@${u.username}`}
                  </Text>
                </View>
                <View style={styles.roleBadge}>
                  <Text style={styles.roleText}>{roleLabel(u.role)}</Text>
                </View>
              </View>
            ))
          )}
        </>
      ) : (
        <View style={styles.privacyNote}>
          <MessageSquare size={14} color={theme.textMuted} />
          <Text style={styles.privacyText}>
            Individual user data for non-default tenants is only accessible via
            an approved impersonation session.
          </Text>
        </View>
      )}

      <PromptModal
        visible={!!confirm}
        title={
          confirm?.action === "suspend" ? "Suspend tenant" : "Delete tenant"
        }
        message={
          confirm?.action === "suspend"
            ? `This will suspend "${tenant.org_name}" and block all its users from signing in. Re-enter your password to confirm.`
            : `This will mark "${tenant.org_name}" as deleted. This action is recorded in the audit log. Re-enter your password to confirm.`
        }
        fields={
          confirm?.action === "suspend"
            ? [
                {
                  key: "reason",
                  label: "Reason (optional)",
                  placeholder: "Reason for suspension",
                },
                {
                  key: "password",
                  label: "Your password",
                  placeholder: "Enter your password",
                  secure: true,
                  required: true,
                },
              ]
            : [
                {
                  key: "password",
                  label: "Your password",
                  placeholder: "Enter your password",
                  secure: true,
                  required: true,
                },
              ]
        }
        confirmLabel={confirm?.action === "suspend" ? "Suspend" : "Delete"}
        destructive
        busy={confirmBusy}
        error={confirmError}
        onCancel={() => {
          setConfirm(null);
          setConfirmError(null);
        }}
        onSubmit={submitConfirm}
      />
    </ScrollView>
  );
}

function Stat({ value, label }: { value: React.ReactNode; label: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function InfoCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <View style={styles.infoCard}>
      {icon}
      <View style={{ flex: 1 }}>
        <Text style={styles.infoLabel}>{label}</Text>
        <Text style={styles.infoValue} numberOfLines={1}>
          {value}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
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
  icon: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: theme.primaryGlow,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  name: { fontSize: 20, fontWeight: "800", color: theme.text },
  domain: { fontSize: 13, color: theme.textMuted },
  statusPill: {
    borderRadius: theme.radiusFull,
    paddingHorizontal: 12,
    paddingVertical: 4,
    marginTop: 4,
  },
  statusText: { fontSize: 12, fontWeight: "600", textTransform: "capitalize" },
  plan: { fontSize: 13, color: theme.textSecondary, marginTop: 4 },
  statsRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusLg,
    padding: 16,
  },
  stat: { flex: 1, alignItems: "center", gap: 2 },
  statValue: { fontSize: 18, fontWeight: "800", color: theme.primary },
  statLabel: {
    fontSize: 10,
    color: theme.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  statDivider: { width: 1, height: 28, backgroundColor: theme.border },
  infoGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  infoCard: {
    width: "47%",
    flexGrow: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radius,
    padding: 12,
  },
  infoLabel: {
    fontSize: 10,
    color: theme.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  infoValue: { fontSize: 13, fontWeight: "600", color: theme.text },
  actionsCol: { gap: 10 },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: theme.radiusSm,
    paddingVertical: 13,
  },
  suspendBtn: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
  },
  deleteBtn: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
  },
  reactivateBtn: { backgroundColor: theme.success },
  actionBtnText: { fontSize: 15, fontWeight: "600" },
  settingsCard: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusLg,
    padding: 16,
    gap: 10,
  },
  settingsMsg: { fontSize: 13, color: theme.success },
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
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 4,
  },
  sectionTitle: { fontSize: 15, fontWeight: "700", color: theme.text },
  userCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radius,
    padding: 12,
  },
  userBody: { flex: 1, gap: 2 },
  userName: { fontSize: 14, fontWeight: "600", color: theme.text },
  userMeta: { fontSize: 12, color: theme.textSecondary },
  roleBadge: {
    backgroundColor: theme.primaryGlow,
    borderRadius: theme.radiusFull,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  roleText: { color: theme.primaryLight, fontSize: 11, fontWeight: "600" },
  privacyNote: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radius,
    padding: 12,
  },
  privacyText: { flex: 1, fontSize: 12, color: theme.textMuted, lineHeight: 17 },
  empty: { color: theme.textMuted, fontSize: 13, paddingVertical: 8 },
});