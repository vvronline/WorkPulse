import { useEffect, useState } from "react";
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
import { Building2 } from "lucide-react-native";
import { theme } from "../../src/theme";
import {
  useKeyboardInset,
  scrollFocusedIntoView,
} from "../../src/hooks/useKeyboardInset";
import { Dropdown, type DropdownOption } from "../../src/components/Dropdown";
import { createTenant, getPlanCatalog } from "../../src/admin";

// Mirrors server-side slug validation in routes/tenants.ts.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

export default function CreateTenantScreen() {
  const router = useRouter();
  const kbInset = useKeyboardInset();
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [plan, setPlan] = useState("standard");
  const [planOptions, setPlanOptions] = useState<DropdownOption[]>([]);

  useEffect(() => {
    getPlanCatalog()
      .then((r) =>
        setPlanOptions(
          Object.entries(r.data.plans || {}).map(([key, p]) => ({
            value: key,
            label: p.label || key,
          })),
        ),
      )
      .catch(() => setPlanOptions([]));
  }, []);

  // Auto-derive the slug from the name until the user edits it manually.
  function onNameChange(v: string) {
    setName(v);
    if (!slugTouched) setSlug(slugify(v));
  }

  const slugError =
    slug && !SLUG_RE.test(slug)
      ? "3-50 chars, lowercase letters/numbers/dashes, no leading/trailing dash"
      : null;

  async function submit() {
    if (!name.trim()) {
      Alert.alert("Required", "Organization name is required");
      return;
    }
    if (!slug.trim() || slugError) {
      Alert.alert("Invalid slug", slugError || "Slug is required");
      return;
    }
    setBusy(true);
    try {
      const { data } = await createTenant({
        org_name: name.trim(),
        slug: slug.trim(),
        plan: plan || undefined,
      });
      const created = data.tenant;
      Alert.alert("Tenant created", `"${created.org_name}" provisioned.`, [
        {
          text: "Open",
          onPress: () => router.replace(`/tenants/${created.id}` as never),
        },
        { text: "Done", onPress: () => router.back() },
      ]);
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to create tenant");
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Stack.Screen options={{ title: "New Tenant" }} />
      <ScrollView
        contentContainerStyle={[styles.container, { paddingBottom: 48 + kbInset }]}
      >
        <View style={styles.headerRow}>
          <Building2 size={18} color={theme.primary} />
          <Text style={styles.heading}>Provision a new tenant</Text>
        </View>
        <Text style={styles.note}>
          A dedicated database is created and the schema initialised. Your
          platform admin account is auto-seeded into the new tenant.
        </Text>

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

        {planOptions.length > 0 ? (
          <>
            <Text style={styles.fieldLabel}>Plan</Text>
            <Dropdown
              label="Plan"
              value={plan}
              options={planOptions}
              onChange={(v) => setPlan(String(v))}
            />
          </>
        ) : null}

        <Pressable
          style={[styles.submitBtn, busy && styles.submitBtnDisabled]}
          onPress={submit}
          disabled={busy}
        >
          <Text style={styles.submitBtnText}>
            {busy ? "Provisioning…" : "Create tenant"}
          </Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  container: { padding: 16, gap: 8, paddingBottom: 48 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  heading: { fontSize: 18, fontWeight: "700", color: theme.text },
  note: { fontSize: 13, color: theme.textSecondary, marginBottom: 6 },
  fieldLabel: {
    fontSize: 12,
    color: theme.textSecondary,
    fontWeight: "500",
    marginTop: 6,
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
  submitBtn: {
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 18,
  },
  submitBtnDisabled: { opacity: 0.6 },
  submitBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
});