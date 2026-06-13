import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import {
  Building2,
  Check,
  ChevronRight,
  CreditCard,
  Sprout,
  UserPlus,
  Users,
} from "lucide-react-native";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import {
  useKeyboardInset,
  scrollFocusedIntoView,
} from "../../src/hooks/useKeyboardInset";
import {
  createTenant,
  createTenantUser,
  getPlanCatalog,
  seedTenant,
  type PlanCatalog,
} from "../../src/admin";

// Mirrors server-side slug validation in routes/tenants.ts.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

const STEPS = [
  { key: "basics", label: "Basics" },
  { key: "plan", label: "Plan" },
  { key: "limits", label: "Limits" },
  { key: "admin", label: "Admin" },
  { key: "seed", label: "Seed" },
];

/**
 * Multi-step tenant creation wizard — mirrors web CreateTenant.tsx:
 * Basics → Plan → Limits → Super Admin → Seed Data.
 */
export default function CreateTenantScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const kbInset = useKeyboardInset();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState<number | null>(null);

  // Step 1: basics
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);

  // Step 2: plan
  const [catalog, setCatalog] = useState<PlanCatalog | null>(null);
  const [plan, setPlan] = useState("standard");

  // Step 3: limits
  const [maxUsers, setMaxUsers] = useState("");
  const [maxStorage, setMaxStorage] = useState("");

  // Step 4: super admin
  const [adminName, setAdminName] = useState("");
  const [adminUsername, setAdminUsername] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");

  // Step 5: seed
  const [seedDone, setSeedDone] = useState(false);
  const [seedResult, setSeedResult] = useState<{
    departments: number;
    leave_policies: number;
  } | null>(null);

  useEffect(() => {
    getPlanCatalog()
      .then((r) => setCatalog(r.data))
      .catch(() => setCatalog(null));
  }, []);

  function onNameChange(v: string) {
    setName(v);
    if (!slugTouched) setSlug(slugify(v));
  }

  const slugError =
    slug && !SLUG_RE.test(slug)
      ? "3-50 chars, lowercase letters/numbers/dashes, no leading/trailing dash"
      : null;

  function selectPlan(key: string) {
    setPlan(key);
    const limits = catalog?.plans?.[key]?.limits;
    if (limits) {
      setMaxUsers(limits.max_users != null ? String(limits.max_users) : "");
      setMaxStorage(
        limits.max_storage_mb != null ? String(limits.max_storage_mb) : "",
      );
    }
  }

  async function createTenantNow() {
    if (!name.trim() || !slug.trim() || slugError) {
      Alert.alert("Invalid", slugError || "Organization name and slug are required");
      return;
    }
    setBusy(true);
    try {
      const { data } = await createTenant({
        org_name: name.trim(),
        slug: slug.trim(),
        plan,
        max_users: maxUsers ? Number(maxUsers) : null,
        max_storage_mb: maxStorage ? Number(maxStorage) : null,
      });
      setCreatedId(data.tenant.id);
      setStep(3);
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to create tenant");
    } finally {
      setBusy(false);
    }
  }

  async function createAdmin() {
    if (!adminName || !adminUsername || !adminEmail || !adminPassword) {
      Alert.alert("Required", "All fields are required");
      return;
    }
    if (!createdId) return;
    setBusy(true);
    try {
      await createTenantUser(createdId, {
        full_name: adminName.trim(),
        username: adminUsername.trim(),
        email: adminEmail.trim(),
        password: adminPassword,
        role: "super_admin",
      });
      setStep(4);
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to create admin");
    } finally {
      setBusy(false);
    }
  }

  async function seed() {
    if (!createdId) return;
    setBusy(true);
    try {
      const r = await seedTenant(createdId);
      setSeedResult(r.data.seeded);
      setSeedDone(true);
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to seed data");
    } finally {
      setBusy(false);
    }
  }

  function finish() {
    if (createdId) router.replace(`/tenants/${createdId}` as never);
    else router.back();
  }

  const plans = catalog ? Object.entries(catalog.plans) : [];
  const featureLabels = catalog?.feature_labels || {};

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Stack.Screen options={{ title: "New Tenant" }} />
      <ScrollView
        contentContainerStyle={[styles.container, { paddingBottom: 48 + kbInset }]}
      >
        {/* Step indicators */}
        <View style={styles.stepsRow}>
          {STEPS.map((s, i) => {
            const isDone = i < step || (i === 4 && seedDone);
            const isActive = i === step;
            return (
              <View
                key={s.key}
                style={[
                  styles.stepPill,
                  isActive && styles.stepPillActive,
                  isDone && styles.stepPillDone,
                ]}
              >
                {isDone ? (
                  <Check size={11} color={theme.success} />
                ) : null}
                <Text
                  style={[
                    styles.stepText,
                    (isActive || isDone) && styles.stepTextActive,
                  ]}
                >
                  {s.label}
                </Text>
              </View>
            );
          })}
        </View>

        {/* ─── Step 1: Basics ─── */}
        {step === 0 ? (
          <View style={styles.card}>
            <View style={styles.headerRow}>
              <Building2 size={16} color={theme.primary} />
              <Text style={styles.heading}>Basics</Text>
            </View>
            <Text style={styles.fieldLabel}>Organization name *</Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={onNameChange}
              onFocus={scrollFocusedIntoView}
              placeholder="Acme Inc"
              placeholderTextColor={theme.textMuted}
            />
            <Text style={styles.fieldLabel}>Slug *</Text>
            <TextInput
              style={[styles.input, slugError ? styles.inputError : null]}
              value={slug}
              onChangeText={(v) => {
                setSlugTouched(true);
                setSlug(v.toLowerCase());
              }}
              placeholder="acme-inc"
              placeholderTextColor={theme.textMuted}
              onFocus={scrollFocusedIntoView}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {slugError ? <Text style={styles.fieldError}>{slugError}</Text> : null}
            <Pressable
              style={[
                styles.primaryBtn,
                (!name.trim() || !slug.trim() || !!slugError) && styles.disabled,
              ]}
              onPress={() => {
                if (name.trim() && slug.trim() && !slugError) setStep(1);
              }}
              disabled={!name.trim() || !slug.trim() || !!slugError}
            >
              <Text style={styles.primaryBtnText}>Next: Plan</Text>
              <ChevronRight size={16} color="#fff" />
            </Pressable>
          </View>
        ) : null}

        {/* ─── Step 2: Plan ─── */}
        {step === 1 ? (
          <View style={styles.card}>
            <View style={styles.headerRow}>
              <CreditCard size={16} color={theme.primary} />
              <Text style={styles.heading}>Choose a plan</Text>
            </View>
            {plans.map(([key, p]) => {
              const selected = plan === key;
              const enabled = Object.entries(p.features || {})
                .filter(([, v]) => v)
                .map(([k]) => featureLabels[k] || k);
              return (
                <Pressable
                  key={key}
                  style={[styles.planCard, selected && styles.planCardSelected]}
                  onPress={() => selectPlan(key)}
                >
                  <View style={styles.planHeader}>
                    <Text style={styles.planName}>{p.label || key}</Text>
                    {selected ? <Check size={16} color={theme.primary} /> : null}
                  </View>
                  {p.description ? (
                    <Text style={styles.planDesc}>{p.description}</Text>
                  ) : null}
                  <Text style={styles.planLimits}>
                    {p.limits?.max_users ?? "∞"} users ·{" "}
                    {p.limits?.max_storage_mb
                      ? `${p.limits.max_storage_mb} MB`
                      : "∞ storage"}
                  </Text>
                  {enabled.length > 0 ? (
                    <Text style={styles.planFeatures} numberOfLines={3}>
                      {enabled.join(" · ")}
                    </Text>
                  ) : null}
                </Pressable>
              );
            })}
            <View style={styles.btnRow}>
              <Pressable style={styles.secondaryBtn} onPress={() => setStep(0)}>
                <Text style={styles.secondaryBtnText}>Back</Text>
              </Pressable>
              <Pressable style={styles.primaryBtn} onPress={() => setStep(2)}>
                <Text style={styles.primaryBtnText}>Next: Limits</Text>
                <ChevronRight size={16} color="#fff" />
              </Pressable>
            </View>
          </View>
        ) : null}

        {/* ─── Step 3: Limits + create ─── */}
        {step === 2 ? (
          <View style={styles.card}>
            <View style={styles.headerRow}>
              <Users size={16} color={theme.primary} />
              <Text style={styles.heading}>Limits</Text>
            </View>
            <Text style={styles.note}>
              Pre-filled from the{" "}
              {catalog?.plans?.[plan]?.label || plan} plan. Override if needed.
            </Text>
            <Text style={styles.fieldLabel}>Max users (empty = unlimited)</Text>
            <TextInput
              style={styles.input}
              value={maxUsers}
              onChangeText={setMaxUsers}
              placeholder="∞"
              placeholderTextColor={theme.textMuted}
              keyboardType="number-pad"
            />
            <Text style={styles.fieldLabel}>
              Max storage in MB (empty = unlimited)
            </Text>
            <TextInput
              style={styles.input}
              value={maxStorage}
              onChangeText={setMaxStorage}
              placeholder="∞"
              placeholderTextColor={theme.textMuted}
              keyboardType="number-pad"
            />
            <View style={styles.btnRow}>
              <Pressable style={styles.secondaryBtn} onPress={() => setStep(1)}>
                <Text style={styles.secondaryBtnText}>Back</Text>
              </Pressable>
              <Pressable
                style={[styles.primaryBtn, busy && styles.disabled]}
                onPress={createTenantNow}
                disabled={busy}
              >
                <Text style={styles.primaryBtnText}>
                  {busy ? "Creating…" : "Create & Continue"}
                </Text>
                <ChevronRight size={16} color="#fff" />
              </Pressable>
            </View>
          </View>
        ) : null}

        {/* ─── Step 4: Super Admin ─── */}
        {step === 3 ? (
          <View style={styles.card}>
            <View style={styles.headerRow}>
              <UserPlus size={16} color={theme.primary} />
              <Text style={styles.heading}>Super Admin</Text>
            </View>
            <Text style={styles.note}>
              Create the initial super admin for {name}. This user will be the
              primary administrator.
            </Text>
            <Text style={styles.fieldLabel}>Full name *</Text>
            <TextInput
              style={styles.input}
              value={adminName}
              onChangeText={setAdminName}
              onFocus={scrollFocusedIntoView}
              placeholder="Jane Admin"
              placeholderTextColor={theme.textMuted}
            />
            <Text style={styles.fieldLabel}>Username *</Text>
            <TextInput
              style={styles.input}
              value={adminUsername}
              onChangeText={setAdminUsername}
              onFocus={scrollFocusedIntoView}
              placeholder="jadmin"
              placeholderTextColor={theme.textMuted}
              autoCapitalize="none"
            />
            <Text style={styles.fieldLabel}>Email *</Text>
            <TextInput
              style={styles.input}
              value={adminEmail}
              onChangeText={setAdminEmail}
              onFocus={scrollFocusedIntoView}
              placeholder="jane@acme.com"
              placeholderTextColor={theme.textMuted}
              autoCapitalize="none"
              keyboardType="email-address"
            />
            <Text style={styles.fieldLabel}>Temporary password *</Text>
            <TextInput
              style={styles.input}
              value={adminPassword}
              onChangeText={setAdminPassword}
              onFocus={scrollFocusedIntoView}
              placeholder="Initial password"
              placeholderTextColor={theme.textMuted}
              secureTextEntry
              autoCapitalize="none"
            />
            <View style={styles.btnRow}>
              <Pressable style={styles.secondaryBtn} onPress={() => setStep(4)}>
                <Text style={styles.secondaryBtnText}>Skip</Text>
              </Pressable>
              <Pressable
                style={[styles.primaryBtn, busy && styles.disabled]}
                onPress={createAdmin}
                disabled={busy}
              >
                <Text style={styles.primaryBtnText}>
                  {busy ? "Creating…" : "Create Admin"}
                </Text>
                <ChevronRight size={16} color="#fff" />
              </Pressable>
            </View>
          </View>
        ) : null}

        {/* ─── Step 5: Seed Data ─── */}
        {step === 4 ? (
          <View style={styles.card}>
            <View style={styles.headerRow}>
              <Sprout size={16} color={theme.primary} />
              <Text style={styles.heading}>Seed Data</Text>
            </View>
            {!seedDone ? (
              <>
                <Text style={styles.note}>
                  Optionally seed {name} with default departments (Engineering,
                  Product, Design, Marketing, Sales, HR, Finance) and leave
                  policies (Annual, Sick, Personal).
                </Text>
                <View style={styles.btnRow}>
                  <Pressable style={styles.secondaryBtn} onPress={finish}>
                    <Text style={styles.secondaryBtnText}>Skip & Finish</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.primaryBtn, busy && styles.disabled]}
                    onPress={seed}
                    disabled={busy}
                  >
                    <Sprout size={15} color="#fff" />
                    <Text style={styles.primaryBtnText}>
                      {busy ? "Seeding…" : "Seed Default Data"}
                    </Text>
                  </Pressable>
                </View>
              </>
            ) : (
              <>
                <View style={styles.successBanner}>
                  <Check size={15} color={theme.success} />
                  <Text style={styles.successText}>
                    Seed data applied — {seedResult?.departments || 0}{" "}
                    departments, {seedResult?.leave_policies || 0} leave
                    policies created.
                  </Text>
                </View>
                <Pressable style={styles.primaryBtn} onPress={finish}>
                  <Check size={15} color="#fff" />
                  <Text style={styles.primaryBtnText}>View Tenant</Text>
                </Pressable>
              </>
            )}
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  container: { padding: 16, gap: 14, paddingBottom: 48 },
  stepsRow: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  stepPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: theme.radiusFull,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
  },
  stepPillActive: { borderColor: theme.primary, backgroundColor: theme.primaryGlow },
  stepPillDone: { borderColor: theme.success },
  stepText: { fontSize: 11, color: theme.textMuted, fontWeight: "600" },
  stepTextActive: { color: theme.text },
  card: {
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusLg,
    padding: 16,
    gap: 10,
  },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  heading: { fontSize: 16, fontWeight: "700", color: theme.text },
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
  inputError: { borderColor: theme.danger },
  fieldError: { fontSize: 12, color: theme.danger },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 13,
    paddingHorizontal: 16,
    flex: 1,
  },
  primaryBtnText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  secondaryBtn: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radiusSm,
    paddingVertical: 13,
    paddingHorizontal: 16,
  },
  secondaryBtnText: { color: theme.textSecondary, fontSize: 14, fontWeight: "600" },
  btnRow: { flexDirection: "row", gap: 10, marginTop: 6 },
  disabled: { opacity: 0.5 },
  planCard: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radius,
    padding: 14,
    gap: 4,
  },
  planCardSelected: { borderColor: theme.primary, backgroundColor: theme.primaryGlow },
  planHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  planName: { fontSize: 15, fontWeight: "700", color: theme.text },
  planDesc: { fontSize: 12, color: theme.textSecondary },
  planLimits: { fontSize: 12, color: theme.primaryLight, fontWeight: "600" },
  planFeatures: { fontSize: 11, color: theme.textMuted, lineHeight: 15 },
  successBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: theme.success + "18",
    borderRadius: theme.radiusSm,
    padding: 12,
  },
  successText: { flex: 1, fontSize: 13, color: theme.success },
});