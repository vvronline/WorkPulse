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
import { CreditCard, FlaskConical } from "lucide-react-native";
import { theme } from "../../src/theme";
import {
  useKeyboardInset,
  scrollFocusedIntoView,
} from "../../src/hooks/useKeyboardInset";
import { Dropdown } from "../../src/components/Dropdown";
import {
  getPaymentConfig,
  savePaymentConfig,
  testPaymentConfig,
} from "../../src/admin";

const TRANSFER_MODES = [
  { value: "IMPS", label: "IMPS" },
  { value: "NEFT", label: "NEFT" },
  { value: "RTGS", label: "RTGS" },
  { value: "UPI", label: "UPI" },
];

export default function PaymentSettingsScreen() {
  const kbInset = useKeyboardInset();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);

  const [apiKeyId, setApiKeyId] = useState("");
  const [apiKeySecret, setApiKeySecret] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [transferMode, setTransferMode] = useState<string | number | null>(
    "IMPS",
  );
  const [isActive, setIsActive] = useState(false);
  const [configured, setConfigured] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    getPaymentConfig()
      .then((r) => {
        const c = r.data || {};
        setApiKeyId((c.api_key_id as string) || "");
        // Secrets come back masked/empty — keep field blank, only send when set.
        setAccountNumber((c.account_number as string) || "");
        setTransferMode((c.default_transfer_mode as string) || "IMPS");
        setIsActive(!!c.is_active);
        setConfigured(!!c.id || !!c.api_key_id);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    if (!apiKeyId.trim() || !accountNumber.trim()) {
      Alert.alert("Required", "API key ID and account number are required");
      return;
    }
    setBusy(true);
    try {
      await savePaymentConfig({
        api_key_id: apiKeyId.trim(),
        ...(apiKeySecret.trim() ? { api_key_secret: apiKeySecret.trim() } : {}),
        account_number: accountNumber.trim(),
        ...(webhookSecret.trim() ? { webhook_secret: webhookSecret.trim() } : {}),
        default_transfer_mode: String(transferMode || "IMPS"),
        is_active: isActive,
      });
      Alert.alert("Saved", "Payment configuration saved");
      setApiKeySecret("");
      setWebhookSecret("");
      load();
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    try {
      const r = await testPaymentConfig();
      Alert.alert(
        "Connection OK",
        (r.data?.message as string) || "Payment gateway reachable.",
      );
    } catch (e: any) {
      Alert.alert(
        "Test failed",
        e?.response?.data?.error || "Could not reach the payment gateway",
      );
    } finally {
      setTesting(false);
    }
  }

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Stack.Screen options={{ title: "Payment Settings" }} />
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.container, { paddingBottom: 48 + kbInset }]}
    >
      <Stack.Screen options={{ title: "Payment Settings" }} />

      <View style={styles.section}>
        <View style={styles.sectionTitleRow}>
          <CreditCard size={15} color={theme.textSecondary} />
          <Text style={styles.sectionTitle}>Razorpay Payouts</Text>
        </View>
        <Text style={styles.hint}>
          Configure the payout gateway used for salary disbursement.
          {configured ? " A configuration already exists — secrets are hidden; leave secret fields blank to keep current values." : ""}
        </Text>

        <Text style={styles.fieldLabel}>API Key ID</Text>
        <TextInput
          style={styles.input}
          value={apiKeyId}
          onChangeText={setApiKeyId}
          onFocus={scrollFocusedIntoView}
          placeholder="rzp_live_…"
          placeholderTextColor={theme.textMuted}
          autoCapitalize="none"
        />

        <Text style={styles.fieldLabel}>API Key Secret</Text>
        <TextInput
          style={styles.input}
          value={apiKeySecret}
          onChangeText={setApiKeySecret}
          onFocus={scrollFocusedIntoView}
          placeholder={configured ? "•••••••• (unchanged)" : "Secret key"}
          placeholderTextColor={theme.textMuted}
          autoCapitalize="none"
          secureTextEntry
        />

        <Text style={styles.fieldLabel}>Account number</Text>
        <TextInput
          style={styles.input}
          value={accountNumber}
          onChangeText={setAccountNumber}
          onFocus={scrollFocusedIntoView}
          placeholder="Source account number"
          placeholderTextColor={theme.textMuted}
          keyboardType="number-pad"
        />

        <Text style={styles.fieldLabel}>Webhook secret (optional)</Text>
        <TextInput
          style={styles.input}
          value={webhookSecret}
          onChangeText={setWebhookSecret}
          onFocus={scrollFocusedIntoView}
          placeholder={configured ? "•••••••• (unchanged)" : "Webhook secret"}
          placeholderTextColor={theme.textMuted}
          autoCapitalize="none"
          secureTextEntry
        />

        <Text style={styles.fieldLabel}>Default transfer mode</Text>
        <Dropdown
          label="Transfer mode"
          value={transferMode}
          options={TRANSFER_MODES}
          onChange={setTransferMode}
        />

        <View style={styles.toggleRow}>
          <Text style={styles.toggleLabel}>Enable disbursements</Text>
          <Switch
            value={isActive}
            onValueChange={setIsActive}
            trackColor={{ true: theme.primary, false: theme.surface }}
            thumbColor="#fff"
          />
        </View>

        <Pressable style={styles.saveBtn} onPress={save} disabled={busy}>
          <Text style={styles.saveBtnText}>
            {busy ? "Saving…" : "Save configuration"}
          </Text>
        </Pressable>

        {configured ? (
          <Pressable
            style={styles.testBtn}
            onPress={testConnection}
            disabled={testing}
          >
            <FlaskConical size={14} color={theme.primary} />
            <Text style={styles.testBtnText}>
              {testing ? "Testing…" : "Test connection"}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { alignItems: "center", justifyContent: "center" },
  container: { padding: 16, gap: 16 },
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
  hint: { fontSize: 12, color: theme.textMuted, lineHeight: 17 },
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
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  toggleLabel: { fontSize: 14, color: theme.text },
  saveBtn: {
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 13,
    alignItems: "center",
    marginTop: 4,
  },
  saveBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  testBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 11,
  },
  testBtnText: { color: theme.primary, fontSize: 13, fontWeight: "600" },
});