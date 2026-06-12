import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack } from "expo-router";
import { Ban, CheckCircle2, KeyRound, Plus, Shield, X } from "lucide-react-native";
import { theme } from "../../src/theme";
import { useKeyboardInset } from "../../src/hooks/useKeyboardInset";
import { PromptModal } from "../../src/components/PromptModal";
import {
  createPlatformUser,
  deactivatePlatformUser,
  getPlatformUsers,
  resetPlatformUserPassword,
  type PlatformUser,
} from "../../src/admin";

export default function PlatformAdminsScreen() {
  const kbInset = useKeyboardInset();
  const [admins, setAdmins] = useState<PlatformUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // Cross-platform reset-password modal (Alert.prompt is iOS-only).
  const [pwTarget, setPwTarget] = useState<PlatformUser | null>(null);
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    getPlatformUsers()
      .then((r) => setAdmins(Array.isArray(r.data) ? r.data : []))
      .catch(() => setAdmins([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function create() {
    if (!fullName.trim() || !username.trim() || !email.trim() || !password.trim()) {
      Alert.alert("Required", "All fields are required");
      return;
    }
    setBusy(true);
    try {
      await createPlatformUser({
        full_name: fullName.trim(),
        username: username.trim(),
        email: email.trim(),
        password: password.trim(),
      });
      setModalOpen(false);
      setFullName("");
      setUsername("");
      setEmail("");
      setPassword("");
      load();
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to create");
    } finally {
      setBusy(false);
    }
  }

  function deactivate(a: PlatformUser) {
    Alert.alert("Deactivate admin", `Deactivate ${a.full_name}?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Deactivate",
        style: "destructive",
        onPress: () =>
          deactivatePlatformUser(a.id)
            .then(() => load())
            .catch((e: any) =>
              Alert.alert("Error", e?.response?.data?.error || "Failed"),
            ),
      },
    ]);
  }

  async function submitResetPassword(values: Record<string, string>) {
    if (!pwTarget) return;
    const pw = values.password || "";
    if (pw.length < 8) {
      setPwError("Password must be at least 8 characters");
      return;
    }
    setPwBusy(true);
    setPwError(null);
    try {
      await resetPlatformUserPassword(pwTarget.id, pw);
      setPwTarget(null);
      Alert.alert("Done", "Password reset");
    } catch (e: any) {
      setPwError(e?.response?.data?.error || "Failed to reset password");
    } finally {
      setPwBusy(false);
    }
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Platform Admins" }} />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.primary} />
        </View>
      ) : (
        <FlatList
          data={admins}
          keyExtractor={(a) => String(a.id)}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            <Text style={styles.intro}>
              Platform administrators can act across all tenants.
            </Text>
          }
          renderItem={({ item }) => (
            <View style={styles.card}>
              <View style={styles.iconWrap}>
                <Shield size={18} color={theme.primary} />
              </View>
              <View style={styles.body}>
                <View style={styles.nameRow}>
                  <Text style={styles.name} numberOfLines={1}>
                    {item.full_name}
                  </Text>
                  {item.is_active ? (
                    <CheckCircle2 size={13} color={theme.success} />
                  ) : (
                    <Ban size={13} color={theme.danger} />
                  )}
                </View>
                <Text style={styles.meta} numberOfLines={1}>
                  {item.email || `@${item.username}`}
                </Text>
              </View>
              <Pressable
                style={styles.iconBtn}
                onPress={() => {
                  setPwError(null);
                  setPwTarget(item);
                }}
                hitSlop={6}
              >
                <KeyRound size={16} color={theme.textSecondary} />
              </Pressable>
              {item.is_active ? (
                <Pressable
                  style={styles.iconBtn}
                  onPress={() => deactivate(item)}
                  hitSlop={6}
                >
                  <Ban size={16} color={theme.danger} />
                </Pressable>
              ) : null}
            </View>
          )}
          ListEmptyComponent={
            <Text style={styles.empty}>No platform admins.</Text>
          }
        />
      )}

      <Pressable style={styles.fab} onPress={() => setModalOpen(true)}>
        <Plus size={24} color="#fff" />
      </Pressable>

      <PromptModal
        visible={!!pwTarget}
        title="Reset password"
        message={pwTarget ? `New password for ${pwTarget.full_name}` : undefined}
        fields={[
          {
            key: "password",
            label: "New password",
            placeholder: "Min 8 characters",
            secure: true,
            required: true,
          },
        ]}
        confirmLabel="Reset"
        busy={pwBusy}
        error={pwError}
        onCancel={() => {
          setPwTarget(null);
          setPwError(null);
        }}
        onSubmit={submitResetPassword}
      />

      <Modal
        visible={modalOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setModalOpen(false)}
      >
        <KeyboardAvoidingView
          style={styles.modalOverlay}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <Pressable
            style={styles.modalScrim}
            onPress={() => setModalOpen(false)}
          />
          <View style={[styles.sheet, { marginBottom: kbInset }]}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>New platform admin</Text>
              <Pressable onPress={() => setModalOpen(false)} hitSlop={8}>
                <X size={22} color={theme.textSecondary} />
              </Pressable>
            </View>
            <Text style={styles.fieldLabel}>Full name</Text>
            <TextInput
              style={styles.input}
              value={fullName}
              onChangeText={setFullName}
              placeholder="Jane Admin"
              placeholderTextColor={theme.textMuted}
            />
            <Text style={styles.fieldLabel}>Username</Text>
            <TextInput
              style={styles.input}
              value={username}
              onChangeText={setUsername}
              placeholder="jadmin"
              placeholderTextColor={theme.textMuted}
              autoCapitalize="none"
            />
            <Text style={styles.fieldLabel}>Email</Text>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              placeholder="jane@platform.com"
              placeholderTextColor={theme.textMuted}
              autoCapitalize="none"
              keyboardType="email-address"
            />
            <Text style={styles.fieldLabel}>Password</Text>
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              placeholder="Initial password"
              placeholderTextColor={theme.textMuted}
              secureTextEntry
              autoCapitalize="none"
            />
            <Pressable style={styles.saveBtn} onPress={create} disabled={busy}>
              <Text style={styles.saveBtnText}>
                {busy ? "Creating…" : "Create admin"}
              </Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  list: { padding: 16, gap: 10, paddingBottom: 90 },
  intro: { fontSize: 13, color: theme.textSecondary, marginBottom: 4 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radius,
    padding: 12,
  },
  iconWrap: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: theme.primaryGlow,
    alignItems: "center",
    justifyContent: "center",
  },
  body: { flex: 1, gap: 2 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  name: { fontSize: 15, fontWeight: "600", color: theme.text },
  meta: { fontSize: 12, color: theme.textSecondary },
  iconBtn: { padding: 6 },
  empty: {
    color: theme.textMuted,
    fontSize: 13,
    textAlign: "center",
    paddingTop: 32,
  },
  fab: {
    position: "absolute",
    right: 20,
    bottom: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
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
  },
  sheetTitle: { fontSize: 18, fontWeight: "700", color: theme.text },
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
    paddingVertical: 13,
    alignItems: "center",
    marginTop: 6,
  },
  saveBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
});