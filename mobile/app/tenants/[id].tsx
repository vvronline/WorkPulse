import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Database,
  Globe,
  HardDrive,
  KeyRound,
  Loader2,
  MessageSquare,
  Pause,
  Play,
  Shield,
  Trash2,
  Users,
  X,
} from "lucide-react-native";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import { roleLabel } from "../../src/constants/roles";
import { PromptModal } from "../../src/components/PromptModal";
import { Dropdown, type DropdownOption } from "../../src/components/Dropdown";
import { useAuth } from "../../src/auth/AuthContext";
import {
  getToken,
  setToken,
  setOrigToken,
} from "../../src/auth/tokenStore";
import {
  cancelTenantAccessRequest,
  createTenantAccessRequest,
  deleteTenant,
  getAdminOrganizations,
  getImpersonationPolicy,
  getPlanCatalog,
  getTenant,
  getTenantStats,
  getTenantUsers,
  impersonateTenant,
  listTenantAccessRequests,
  reactivateTenant,
  suspendTenant,
  updateAdminOrganization,
  updateTenantDomain,
  updateTenantFeatures,
  updateTenantLimits,
  updateTenantPlan,
  type AdminOrganization,
  type ImpersonationPolicy,
  type PlanCatalog,
  type Tenant,
  type TenantAccessRequest,
  type TenantStats,
  type TenantUser,
} from "../../src/admin";

function statusColor(theme: Theme, status?: string): string {
  if (status === "suspended") return theme.warning;
  if (status === "deleted") return theme.danger;
  return theme.success;
}

const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

type ConfirmAction = { action: "suspend" | "delete" };

export default function TenantDetailScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { refreshUser } = useAuth() as { refreshUser?: () => Promise<void> };
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [stats, setStats] = useState<TenantStats | null>(null);
  const [users, setUsers] = useState<TenantUser[]>([]);
  const [catalog, setCatalog] = useState<PlanCatalog | null>(null);
  const [org, setOrg] = useState<AdminOrganization | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Settings edit state
  const [maxUsers, setMaxUsers] = useState("");
  const [maxStorage, setMaxStorage] = useState("");
  const [domain, setDomain] = useState("");
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [settingsMsg, setSettingsMsg] = useState<string | null>(null);

  // Request-access modal
  const [accessOpen, setAccessOpen] = useState(false);

  // Org settings edit (linked AdminOrganization)
  const [orgEditOpen, setOrgEditOpen] = useState(false);
  const [orgEditBusy, setOrgEditBusy] = useState(false);
  const [orgEditError, setOrgEditError] = useState<string | null>(null);

  // Password-confirm modal for suspend/delete (server requires re-auth).
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [tRes, sRes, cRes, oRes] = await Promise.allSettled([
      getTenant(id),
      getTenantStats(id),
      getPlanCatalog(),
      getAdminOrganizations(),
    ]);
    let t: Tenant | null = null;
    if (tRes.status === "fulfilled") {
      t = tRes.value.data;
      setTenant(t);
      setMaxUsers(t.max_users != null ? String(t.max_users) : "");
      setMaxStorage(t.max_storage_mb != null ? String(t.max_storage_mb) : "");
      setDomain(t.custom_domain || "");
      setOverrides({ ...(t.features || {}) });
    }
    if (sRes.status === "fulfilled") setStats(sRes.value.data);
    if (cRes.status === "fulfilled") setCatalog(cRes.value.data);
    if (oRes.status === "fulfilled" && t) {
      const orgs = oRes.value.data?.data || [];
      setOrg(
        orgs.find((o) => o.slug === t!.slug || o.name === t!.org_name) || null,
      );
    }
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

  async function saveDomain() {
    if (!tenant) return;
    if (domain && !DOMAIN_RE.test(domain)) {
      Alert.alert("Invalid domain", "Enter a valid domain (e.g. app.company.com)");
      return;
    }
    setBusy(true);
    setSettingsMsg(null);
    try {
      await updateTenantDomain(tenant.id, domain);
      setSettingsMsg("Domain updated");
      await load();
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to save domain");
    } finally {
      setBusy(false);
    }
  }

  async function saveFeatures() {
    if (!tenant) return;
    setBusy(true);
    setSettingsMsg(null);
    try {
      await updateTenantFeatures(tenant.id, overrides);
      setSettingsMsg("Features updated");
      await load();
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to save features");
    } finally {
      setBusy(false);
    }
  }

  function setOverride(featureKey: string, value: "default" | "on" | "off") {
    setOverrides((prev) => {
      const next = { ...prev };
      if (value === "default") delete next[featureKey];
      else next[featureKey] = value === "on";
      return next;
    });
  }

  async function submitOrgEdit(values: Record<string, string>) {
    if (!org) return;
    setOrgEditBusy(true);
    setOrgEditError(null);
    try {
      await updateAdminOrganization(org.id, {
        timezone: values.timezone?.trim() || undefined,
        work_hours_per_day: values.work_hours
          ? Number(values.work_hours)
          : undefined,
        work_days: values.work_days?.trim() || undefined,
        fiscal_year_start: values.fiscal_year
          ? Number(values.fiscal_year)
          : undefined,
      });
      setOrgEditOpen(false);
      await load();
    } catch (e: any) {
      setOrgEditError(e?.response?.data?.error || "Failed to update");
    } finally {
      setOrgEditBusy(false);
    }
  }

  const planOptions: DropdownOption[] = catalog
    ? Object.entries(catalog.plans).map(([key, p]) => ({
        value: key,
        label: p.label || key,
      }))
    : [];

  const currentPlanKey = tenant.plan || "standard";
  const planFeatureKeys = catalog
    ? Object.keys(catalog.plans[currentPlanKey]?.features || {})
    : [];
  const featureLabels = catalog?.feature_labels || {};

  const dbSizeMb =
    stats?.db_size_bytes != null
      ? (stats.db_size_bytes / 1024 / 1024).toFixed(1)
      : null;

  function formatWorkDays(wd?: string | number | null) {
    if (!wd) return "Mon–Fri";
    const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return String(wd)
      .split(",")
      .map((d) => names[+d] || d)
      .join(", ");
  }

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
            { backgroundColor: statusColor(theme, tenant.status) + "22" },
          ]}
        >
          <Text style={[styles.statusText, { color: statusColor(theme, tenant.status) }]}>
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
          {tenant.status === "active" ? (
            <Pressable
              style={[styles.actionBtn, styles.accessBtn]}
              onPress={() => setAccessOpen(true)}
              disabled={busy}
            >
              <Shield size={16} color="#fff" />
              <Text style={[styles.actionBtnText, { color: "#fff" }]}>
                Request Access
              </Text>
            </Pressable>
          ) : null}
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

      {/* Settings: plan + limits + domain */}
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

        <Text style={styles.fieldLabel}>Custom domain</Text>
        <View style={styles.inlineRow}>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            value={domain}
            onChangeText={setDomain}
            placeholder="e.g. app.company.com"
            placeholderTextColor={theme.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable
            style={[styles.smallBtn, busy && styles.disabled]}
            onPress={saveDomain}
            disabled={busy}
          >
            <Text style={styles.smallBtnText}>Save</Text>
          </Pressable>
        </View>

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
        <Pressable
          style={[styles.saveBtn, busy && styles.disabled]}
          onPress={saveLimits}
          disabled={busy}
        >
          <Text style={styles.saveBtnText}>
            {busy ? "Saving…" : "Save limits"}
          </Text>
        </Pressable>
      </View>

      {/* Feature overrides */}
      {catalog && planFeatureKeys.length > 0 ? (
        <View style={styles.settingsCard}>
          <Text style={styles.sectionTitle}>Feature Overrides</Text>
          <Text style={styles.note}>
            Override individual features from the plan defaults. "Default"
            uses the plan setting.
          </Text>
          {planFeatureKeys.map((fk) => {
            const planDefault = !!catalog.plans[currentPlanKey]?.features?.[fk];
            const hasOverride = fk in overrides;
            const state = hasOverride
              ? overrides[fk]
                ? "on"
                : "off"
              : "default";
            return (
              <View key={fk} style={styles.featureRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.featureName}>
                    {featureLabels[fk] || fk.replace(/_/g, " ")}
                  </Text>
                  <Text
                    style={[
                      styles.featurePlanDefault,
                      { color: planDefault ? theme.success : theme.textMuted },
                    ]}
                  >
                    Plan: {planDefault ? "ON" : "OFF"}
                  </Text>
                </View>
                <View style={styles.segment}>
                  {(["default", "on", "off"] as const).map((opt) => (
                    <Pressable
                      key={opt}
                      style={[
                        styles.segmentBtn,
                        state === opt && styles.segmentBtnActive,
                      ]}
                      onPress={() => setOverride(fk, opt)}
                    >
                      <Text
                        style={[
                          styles.segmentText,
                          state === opt && styles.segmentTextActive,
                        ]}
                      >
                        {opt === "default" ? "Def" : opt === "on" ? "On" : "Off"}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            );
          })}
          <Pressable
            style={[styles.saveBtn, busy && styles.disabled]}
            onPress={saveFeatures}
            disabled={busy}
          >
            <Text style={styles.saveBtnText}>Save Features</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Linked org settings */}
      {org ? (
        <View style={styles.settingsCard}>
          <Text style={styles.sectionTitle}>Organization Settings</Text>
          <Text style={styles.note}>
            Timezone: {org.timezone || "UTC"} · Work hours:{" "}
            {org.work_hours_per_day || 8}h · Work days:{" "}
            {formatWorkDays(org.work_days)} · Fiscal year: Month{" "}
            {org.fiscal_year_start || 1}
          </Text>
          <Pressable
            style={[styles.smallBtn, { alignSelf: "flex-start" }]}
            onPress={() => {
              setOrgEditError(null);
              setOrgEditOpen(true);
            }}
          >
            <Text style={styles.smallBtnText}>Edit Org Settings</Text>
          </Pressable>
        </View>
      ) : null}

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

      {/* Edit linked org settings */}
      <PromptModal
        visible={orgEditOpen}
        title="Edit Org Settings"
        message={org ? `Update settings for ${org.name}` : undefined}
        fields={[
          {
            key: "timezone",
            label: "Timezone",
            placeholder: "e.g. Asia/Kolkata",
            initialValue: org?.timezone || "",
          },
          {
            key: "work_hours",
            label: "Work hours per day",
            placeholder: "8",
            initialValue: org?.work_hours_per_day
              ? String(org.work_hours_per_day)
              : "",
          },
          {
            key: "work_days",
            label: "Work days (e.g. 1,2,3,4,5)",
            placeholder: "1,2,3,4,5",
            initialValue: org?.work_days ? String(org.work_days) : "",
          },
          {
            key: "fiscal_year",
            label: "Fiscal year start month (1-12)",
            placeholder: "1",
            initialValue: org?.fiscal_year_start
              ? String(org.fiscal_year_start)
              : "",
          },
        ]}
        confirmLabel="Save"
        busy={orgEditBusy}
        error={orgEditError}
        onCancel={() => setOrgEditOpen(false)}
        onSubmit={submitOrgEdit}
      />

      {/* Consent-gated request-access flow */}
      <RequestAccessModal
        visible={accessOpen}
        tenant={tenant}
        onClose={() => setAccessOpen(false)}
        onEntered={async () => {
          setAccessOpen(false);
          // Refresh auth state so the app re-renders as the inspector user.
          try {
            await refreshUser?.();
          } catch {
            /* ignore */
          }
          router.replace("/" as never);
        }}
      />
    </ScrollView>
  );
}

/* ════════════════ Request Access modal (mirrors web RequestAccessModal) ════════════════ */

type AccessStep = "reason" | "waiting" | "code" | "break_glass" | "done";

function RequestAccessModal({
  visible,
  tenant,
  onClose,
  onEntered,
}: {
  visible: boolean;
  tenant: Tenant;
  onClose: () => void;
  onEntered: () => void;
}) {
  const theme = useTheme();
  const maStyles = useMemo(() => makeMaStyles(theme), [theme]);
  const [policy, setPolicy] = useState<ImpersonationPolicy | null>(null);
  const [step, setStep] = useState<AccessStep>("reason");
  const [request, setRequest] = useState<TenantAccessRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 1 inputs
  const [reason, setReason] = useState("");
  const [scope, setScope] = useState("write");
  const [duration, setDuration] = useState("30");

  // Step 3 inputs
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // On open: load policy + look for an existing live request so we can
  // re-enter the correct step.
  useEffect(() => {
    if (!visible) return;
    setStep("reason");
    setRequest(null);
    setError(null);
    setCode("");
    setPassword("");
    getImpersonationPolicy()
      .then((r) => setPolicy(r.data))
      .catch(() => {});
    listTenantAccessRequests(tenant.id)
      .then((r) => {
        const live = (r.data?.requests || []).find((req) =>
          ["pending", "approved"].includes(req.status),
        );
        if (live) {
          setRequest(live);
          setStep(live.status === "approved" ? "code" : "waiting");
        }
      })
      .catch(() => {});
  }, [visible, tenant.id]);

  // Poll while waiting for approval.
  useEffect(() => {
    if (!visible || step !== "waiting" || !request) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    pollRef.current = setInterval(async () => {
      try {
        const r = await listTenantAccessRequests(tenant.id);
        const fresh = (r.data?.requests || []).find((x) => x.id === request.id);
        if (!fresh) return;
        setRequest(fresh);
        if (fresh.status === "approved") setStep("code");
        if (fresh.status === "denied") {
          setError(`Request denied: ${fresh.denied_reason || "—"}`);
          setStep("reason");
          setRequest(null);
        }
        if (fresh.status === "expired") {
          setError("The approval code expired. Please request again.");
          setStep("reason");
          setRequest(null);
        }
        if (fresh.status === "cancelled") {
          setStep("reason");
          setRequest(null);
        }
      } catch {
        /* keep polling */
      }
    }, 4000);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [visible, step, request, tenant.id]);

  async function createRequest() {
    if (reason.trim().length < 10) {
      setError("Please describe why access is needed (at least 10 characters).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await createTenantAccessRequest(tenant.id, {
        reason: reason.trim(),
        scope,
        duration_minutes: Number(duration) || 30,
      });
      setRequest(r.data?.request || null);
      setStep("waiting");
    } catch (e: any) {
      setError(e?.response?.data?.error || "Failed to create request");
    } finally {
      setBusy(false);
    }
  }

  async function cancelRequest() {
    if (request) {
      try {
        await cancelTenantAccessRequest(request.id);
      } catch {
        /* ignore */
      }
    }
    onClose();
  }

  async function enterTenant(useBreakGlass = false) {
    if (!password) {
      setError("Enter your password to continue.");
      return;
    }
    if (!useBreakGlass && !/^\d{6}$/.test(code)) {
      setError("Enter the 6-digit approval code.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await impersonateTenant(tenant.id, {
        approval_code: useBreakGlass ? undefined : code,
        password,
        break_glass: useBreakGlass || undefined,
      });
      const impToken = r.data?.token;
      if (impToken) {
        // Park the original platform token and swap in the impersonation JWT.
        const orig = await getToken();
        if (orig) await setOrigToken(orig);
        await setToken(impToken);
      }
      setStep("done");
      setTimeout(() => onEntered(), 500);
    } catch (e: any) {
      setError(e?.response?.data?.error || "Failed to start session");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={maStyles.overlay}>
        <Pressable style={maStyles.scrim} onPress={busy ? undefined : onClose} />
        <View style={maStyles.sheet}>
          <View style={maStyles.headerRow}>
            <Shield size={16} color={theme.primary} />
            <Text style={maStyles.title} numberOfLines={1}>
              Request access — {tenant.org_name}
            </Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <X size={20} color={theme.textSecondary} />
            </Pressable>
          </View>

          {error ? <Text style={maStyles.error}>{error}</Text> : null}

          {step === "reason" ? (
            <ScrollView style={{ maxHeight: 440 }} contentContainerStyle={{ gap: 10 }}>
              <Text style={maStyles.note}>
                The tenant's super admin must approve your request before you
                can enter the workspace.
              </Text>
              <Text style={maStyles.fieldLabel}>Reason for access *</Text>
              <TextInput
                style={[maStyles.input, maStyles.inputMultiline]}
                value={reason}
                onChangeText={setReason}
                placeholder="e.g. Customer ticket #4231 — investigating missing salary slip records."
                placeholderTextColor={theme.textMuted}
                multiline
                maxLength={500}
              />
              <Text style={maStyles.fieldLabel}>Scope</Text>
              <Dropdown
                label="Scope"
                value={scope}
                options={[
                  { value: "read", label: "Read-only (recommended)" },
                  { value: "write", label: "Full write access" },
                ]}
                onChange={(v) => setScope(String(v))}
              />
              <Text style={maStyles.fieldLabel}>
                Duration (minutes, max {policy?.maxSessionMinutes || 60})
              </Text>
              <TextInput
                style={maStyles.input}
                value={duration}
                onChangeText={setDuration}
                keyboardType="number-pad"
                placeholderTextColor={theme.textMuted}
              />
              <Pressable
                style={[maStyles.primaryBtn, busy && maStyles.disabled]}
                onPress={createRequest}
                disabled={busy}
              >
                <Text style={maStyles.primaryBtnText}>
                  {busy ? "Sending…" : "Request access"}
                </Text>
              </Pressable>
              {policy?.breakGlassAllowed ? (
                <Pressable
                  style={maStyles.glassNotice}
                  onPress={() => setStep("break_glass")}
                >
                  <AlertTriangle size={14} color={theme.warning} />
                  <Text style={maStyles.glassNoticeText}>
                    Break-glass emergency access is enabled. Use it instead.
                  </Text>
                </Pressable>
              ) : null}
            </ScrollView>
          ) : null}

          {step === "waiting" && request ? (
            <View style={{ alignItems: "center", gap: 10, paddingVertical: 10 }}>
              <Loader2 size={28} color={theme.primary} />
              <Text style={maStyles.waitTitle}>Waiting for approval</Text>
              <Text style={maStyles.note}>
                Your request was sent to the tenant's super admin. They'll
                generate a one-time 6-digit code and share it with you over
                your support channel.
              </Text>
              <Text style={maStyles.meta}>
                {request.reason} · {request.scope} · {request.duration_minutes}{" "}
                min
              </Text>
              <Pressable
                style={maStyles.secondaryBtn}
                onPress={cancelRequest}
              >
                <Text style={maStyles.secondaryBtnText}>Cancel request</Text>
              </Pressable>
            </View>
          ) : null}

          {step === "code" && request ? (
            <View style={{ gap: 10 }}>
              <View style={maStyles.successRow}>
                <CheckCircle2 size={16} color={theme.success} />
                <Text style={maStyles.successText}>
                  Approved by {request.approved_by_name || "the tenant"}.
                </Text>
              </View>
              <Text style={maStyles.note}>
                Enter the 6-digit approval code the tenant shared with you,
                plus your platform password.
              </Text>
              <Text style={maStyles.fieldLabel}>
                <KeyRound size={11} color={theme.textSecondary} /> 6-digit
                approval code
              </Text>
              <TextInput
                style={[maStyles.input, maStyles.otpInput]}
                value={code}
                onChangeText={(v) => setCode(v.replace(/\D/g, "").slice(0, 6))}
                placeholder="123456"
                placeholderTextColor={theme.textMuted}
                keyboardType="number-pad"
                maxLength={6}
              />
              {request.code_expires_at ? (
                <Text style={maStyles.meta}>
                  Code expires{" "}
                  {new Date(request.code_expires_at).toLocaleTimeString()}
                </Text>
              ) : null}
              <Text style={maStyles.fieldLabel}>
                Your platform password (re-auth)
              </Text>
              <TextInput
                style={maStyles.input}
                value={password}
                onChangeText={setPassword}
                placeholder="Enter your password"
                placeholderTextColor={theme.textMuted}
                secureTextEntry
                autoCapitalize="none"
              />
              <Pressable
                style={[maStyles.primaryBtn, busy && maStyles.disabled]}
                onPress={() => enterTenant(false)}
                disabled={busy}
              >
                <Text style={maStyles.primaryBtnText}>
                  {busy ? "Starting…" : "Enter tenant"}
                </Text>
              </Pressable>
              <Pressable style={maStyles.secondaryBtn} onPress={cancelRequest}>
                <Text style={maStyles.secondaryBtnText}>Cancel</Text>
              </Pressable>
            </View>
          ) : null}

          {step === "break_glass" ? (
            <View style={{ gap: 10 }}>
              <View style={maStyles.dangerBanner}>
                <AlertTriangle size={16} color={theme.danger} />
                <Text style={maStyles.dangerText}>
                  Emergency break-glass access. Bypassing tenant consent is
                  heavily audited — all tenant super admins are notified
                  immediately. Only use this for genuine incidents.
                </Text>
              </View>
              <Text style={maStyles.fieldLabel}>
                Your platform password (re-auth required)
              </Text>
              <TextInput
                style={maStyles.input}
                value={password}
                onChangeText={setPassword}
                placeholder="Enter your password"
                placeholderTextColor={theme.textMuted}
                secureTextEntry
                autoCapitalize="none"
              />
              <Pressable
                style={[
                  maStyles.dangerBtn,
                  (busy || !password) && maStyles.disabled,
                ]}
                onPress={() => enterTenant(true)}
                disabled={busy || !password}
              >
                <Text style={maStyles.primaryBtnText}>
                  {busy ? "Starting…" : "Break the glass"}
                </Text>
              </Pressable>
              <Pressable
                style={maStyles.secondaryBtn}
                onPress={() => setStep("reason")}
              >
                <Text style={maStyles.secondaryBtnText}>Back</Text>
              </Pressable>
            </View>
          ) : null}

          {step === "done" ? (
            <View style={{ alignItems: "center", gap: 10, paddingVertical: 14 }}>
              <CheckCircle2 size={28} color={theme.success} />
              <Text style={maStyles.waitTitle}>Session started</Text>
              <Text style={maStyles.note}>Loading the tenant workspace…</Text>
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

function Stat({ value, label }: { value: React.ReactNode; label: string }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
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
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
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
  accessBtn: { backgroundColor: theme.primary },
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
  note: { fontSize: 12, color: theme.textSecondary, lineHeight: 17 },
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
  inlineRow: { flexDirection: "row", gap: 10, alignItems: "center" },
  smallBtn: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  smallBtnText: { color: theme.text, fontSize: 13, fontWeight: "600" },
  saveBtn: {
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 4,
  },
  saveBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  disabled: { opacity: 0.5 },
  featureRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 4,
  },
  featureName: { fontSize: 13, color: theme.text, fontWeight: "500" },
  featurePlanDefault: { fontSize: 10, marginTop: 2 },
  segment: {
    flexDirection: "row",
    backgroundColor: theme.surface,
    borderRadius: theme.radiusSm,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    overflow: "hidden",
  },
  segmentBtn: { paddingHorizontal: 10, paddingVertical: 7 },
  segmentBtnActive: { backgroundColor: theme.primary },
  segmentText: { fontSize: 11, color: theme.textSecondary, fontWeight: "600" },
  segmentTextActive: { color: "#fff" },
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

const makeMaStyles = (theme: Theme) =>
  StyleSheet.create({
  overlay: { flex: 1, justifyContent: "flex-end" },
  scrim: {
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
    paddingBottom: 30,
    gap: 12,
  },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { flex: 1, fontSize: 16, fontWeight: "700", color: theme.text },
  error: { fontSize: 13, color: theme.danger },
  note: { fontSize: 12, color: theme.textSecondary, lineHeight: 17 },
  meta: { fontSize: 12, color: theme.textMuted },
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
  inputMultiline: { minHeight: 72, textAlignVertical: "top" },
  otpInput: {
    fontSize: 22,
    letterSpacing: 8,
    textAlign: "center",
    fontWeight: "700",
  },
  primaryBtn: {
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 13,
    alignItems: "center",
  },
  primaryBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  secondaryBtn: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusSm,
    paddingVertical: 12,
    alignItems: "center",
  },
  secondaryBtnText: { color: theme.textSecondary, fontSize: 14, fontWeight: "600" },
  dangerBtn: {
    backgroundColor: theme.danger,
    borderRadius: theme.radiusSm,
    paddingVertical: 13,
    alignItems: "center",
  },
  disabled: { opacity: 0.5 },
  glassNotice: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 10,
    borderRadius: theme.radiusSm,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
  },
  glassNoticeText: { flex: 1, fontSize: 12, color: theme.warning },
  waitTitle: { fontSize: 16, fontWeight: "700", color: theme.text },
  successRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  successText: { fontSize: 13, color: theme.success, fontWeight: "600" },
  dangerBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    padding: 12,
    borderRadius: theme.radiusSm,
    backgroundColor: theme.danger + "18",
  },
  dangerText: { flex: 1, fontSize: 12, color: theme.danger, lineHeight: 17 },
});