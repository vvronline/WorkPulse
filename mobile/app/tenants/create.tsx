import { useState } from "react";
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
import { createTenant } from "../../src/admin";

export default function CreateTenantScreen() {
  const router = useRouter();
  const kbInset = useKeyboardInset();
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState("");
  const [adminUsername, setAdminUsername] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [plan, setPlan] = useState("");

  async function submit() {
    if (!name.trim()) {
      Alert.alert("Required", "Tenant name is required");
      return;
    }
    setBusy(true);
    try {
      const { data } = await createTenant({
        name: name.trim(),
        admin_username: adminUsername.trim() || undefined,
        admin_email: adminEmail.trim() || undefined,
        admin_password: adminPassword.trim() || undefined,
        plan: plan.trim() || undefined,
      });
      Alert.alert("Tenant created", data.message || "Tenant provisioned", [
        {
          text: "Open",
          onPress: () =>
            router.replace(`/tenants/${data.id}` as never),
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
          A dedicated database is created and the schema initialised.
        </Text>

        <Text style={styles.fieldLabel}>Tenant name *</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          onFocus={scrollFocusedIntoView}
          placeholder="Acme Inc"
          placeholderTextColor={theme.textMuted}
        />

        <Text style={styles.fieldLabel}>Admin username</Text>
        <TextInput
          style={styles.input}
          value={adminUsername}
          onChangeText={setAdminUsername}
          placeholder="admin"
          placeholderTextColor={theme.textMuted}
          onFocus={scrollFocusedIntoView}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Text style={styles.fieldLabel}>Admin email</Text>
        <TextInput
          style={styles.input}
          value={adminEmail}
          onChangeText={setAdminEmail}
          placeholder="admin@acme.com"
          placeholderTextColor={theme.textMuted}
          onFocus={scrollFocusedIntoView}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
        />

        <Text style={styles.fieldLabel}>Admin password</Text>
        <TextInput
          style={styles.input}
          value={adminPassword}
          onChangeText={setAdminPassword}
          placeholder="Initial password"
          placeholderTextColor={theme.textMuted}
          onFocus={scrollFocusedIntoView}
          secureTextEntry
          autoCapitalize="none"
        />

        <Text style={styles.fieldLabel}>Plan (optional)</Text>
        <TextInput
          style={styles.input}
          value={plan}
          onChangeText={setPlan}
          placeholder="standard"
          placeholderTextColor={theme.textMuted}
          onFocus={scrollFocusedIntoView}
          autoCapitalize="none"
        />

        <Pressable style={styles.submitBtn} onPress={submit} disabled={busy}>
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
  submitBtn: {
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 18,
  },
  submitBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
});