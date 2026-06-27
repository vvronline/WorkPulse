import { useMemo, useState } from "react";
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
import { useQuery } from "@tanstack/react-query";
import { UserPlus } from "lucide-react-native";
import { useAuth } from "../../src/auth/AuthContext";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import { Dropdown, type DropdownOption } from "../../src/components/Dropdown";
import { ROLES, roleLabel, canManageRole } from "../../src/constants/roles";
import {
  useKeyboardInset,
  scrollFocusedIntoView,
} from "../../src/hooks/useKeyboardInset";
import { createAdminUser, getDepartments, getTeams } from "../../src/admin";

const EMPTY_OPTIONS: DropdownOption[] = [];

export default function AddPeopleScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const { user: me } = useAuth();
  const kbInset = useKeyboardInset();
  const [busy, setBusy] = useState(false);

  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<string>("employee");
  const [deptId, setDeptId] = useState<string | number | null>(null);
  const [teamId, setTeamId] = useState<string | number | null>(null);

  const { data: refData } = useQuery({
    queryKey: ["admin", "addPeopleRefData"],
    queryFn: async () => {
      const [dRes, tRes] = await Promise.allSettled([
        getDepartments(),
        getTeams(),
      ]);
      const departments: DropdownOption[] =
        dRes.status === "fulfilled"
          ? [
              { value: null, label: "— No department —" },
              ...(dRes.value.data || []).map((d) => ({
                value: d.id,
                label: d.name,
              })),
            ]
          : EMPTY_OPTIONS;
      const teams: DropdownOption[] =
        tRes.status === "fulfilled"
          ? [
              { value: null, label: "— No team —" },
              ...(tRes.value.data || []).map((t) => ({
                value: t.id,
                label: t.name,
              })),
            ]
          : EMPTY_OPTIONS;
      return { departments, teams };
    },
  });
  const departments = refData?.departments ?? EMPTY_OPTIONS;
  const teams = refData?.teams ?? EMPTY_OPTIONS;

  const roleOptions: DropdownOption[] = ROLES.filter((r) =>
    me?.role === "platform_admin" ? true : canManageRole(me?.role ?? "", r),
  ).map((r) => ({ value: r, label: roleLabel(r) }));

  async function submit() {
    if (!fullName.trim() || !username.trim() || !email.trim()) {
      Alert.alert("Required", "Full name, username and email are required");
      return;
    }
    setBusy(true);
    try {
      const { data } = await createAdminUser({
        full_name: fullName.trim(),
        username: username.trim(),
        email: email.trim(),
        password: password.trim() || undefined,
        role,
        department_id: deptId ? Number(deptId) : null,
        team_id: teamId ? Number(teamId) : null,
      });
      Alert.alert("User created", data.message || "User created successfully", [
        { text: "OK", onPress: () => router.back() },
      ]);
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to create user");
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Stack.Screen options={{ title: "Add People" }} />
      <ScrollView
        contentContainerStyle={[
          styles.container,
          { paddingBottom: 48 + kbInset },
        ]}
      >
        <View style={styles.headerRow}>
          <UserPlus size={18} color={theme.primary} />
          <Text style={styles.heading}>Create a new user</Text>
        </View>

        <Text style={styles.fieldLabel}>Full name *</Text>
        <TextInput
          style={styles.input}
          value={fullName}
          onChangeText={setFullName}
          onFocus={scrollFocusedIntoView}
          placeholder="Jane Doe"
          placeholderTextColor={theme.textMuted}
        />

        <Text style={styles.fieldLabel}>Username *</Text>
        <TextInput
          style={styles.input}
          value={username}
          onChangeText={setUsername}
          placeholder="janedoe"
          placeholderTextColor={theme.textMuted}
          onFocus={scrollFocusedIntoView}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Text style={styles.fieldLabel}>Email *</Text>
        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          placeholder="jane@example.com"
          placeholderTextColor={theme.textMuted}
          onFocus={scrollFocusedIntoView}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
        />

        <Text style={styles.fieldLabel}>
          Password (optional — auto-generated if blank)
        </Text>
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          placeholder="Leave blank to auto-generate"
          placeholderTextColor={theme.textMuted}
          onFocus={scrollFocusedIntoView}
          secureTextEntry
          autoCapitalize="none"
        />

        <Text style={styles.fieldLabel}>Role</Text>
        <Dropdown
          label="Role"
          value={role}
          options={roleOptions}
          onChange={(v) => setRole(String(v))}
        />

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

        <Pressable style={styles.submitBtn} onPress={submit} disabled={busy}>
          <Text style={styles.submitBtnText}>
            {busy ? "Creating…" : "Create user"}
          </Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.bg },
    container: { padding: 16, gap: 8, paddingBottom: 48 },
    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginBottom: 8,
    },
    heading: { fontSize: 18, fontWeight: "700", color: theme.text },
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
