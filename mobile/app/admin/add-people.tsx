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
import { useQuery } from "@tanstack/react-query";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { FileText, Upload, UserPlus } from "../../src/icons";
import { useAuth } from "../../src/auth/AuthContext";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import { Dropdown, type DropdownOption } from "../../src/components/Dropdown";
import { ROLES, roleLabel, canManageRole } from "../../src/constants/roles";
import {
  useKeyboardInset,
  scrollFocusedIntoView,
} from "../../src/hooks/useKeyboardInset";
import {
  createAdminUser,
  getAdminOrganizations,
  getDepartments,
  getTeams,
  importAdminUsers,
  type ImportUserRow,
  type ImportUsersResult,
} from "../../src/admin";

const EMPTY_OPTIONS: DropdownOption[] = [];

type Method = "single" | "paste" | "file";

type ParsedRow = ImportUserRow;
type ParseError = { line: number; errors: string };

const METHODS: { key: Method; title: string; desc: string; icon: any }[] = [
  {
    key: "single",
    title: "Add one user",
    desc: "Create a single account with full details.",
    icon: UserPlus,
  },
  {
    key: "paste",
    title: "Paste a list",
    desc: "Paste rows from a spreadsheet or text editor.",
    icon: FileText,
  },
  {
    key: "file",
    title: "Upload a file",
    desc: "CSV or JSON file (up to 200 users per batch).",
    icon: Upload,
  },
];

/** Parse pasted TSV/CSV text — mirrors the web AddPeopleWizard.parsePaste(). */
function parsePaste(text: string): {
  rows: ParsedRow[];
  errors: ParseError[];
} {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return { rows: [], errors: [] };

  // Detect delimiter (tab > comma > semicolon).
  const first = lines[0];
  const delim = first.includes("\t")
    ? "\t"
    : first.split(",").length > first.split(";").length
      ? ","
      : ";";

  // Header detection: first row contains name/email/user/role.
  const headerCells = first.split(delim).map((c) => c.trim().toLowerCase());
  const hasHeader = headerCells.some((c) => /name|email|user|role/.test(c));
  const cols = hasHeader
    ? headerCells
    : ["full_name", "email", "username", "role", "department_name", "team_name"];
  const dataLines = hasHeader ? lines.slice(1) : lines;

  const rows: ParsedRow[] = [];
  const errors: ParseError[] = [];
  dataLines.forEach((line, i) => {
    const cells = line.split(delim).map((c) => c.trim());
    const row: Record<string, string> = {};
    cols.forEach((col, idx) => {
      row[col] = cells[idx] || "";
    });

    const errs: string[] = [];
    if (!row.full_name) errs.push("missing name");
    if (!row.email) errs.push("missing email");
    else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(row.email))
      errs.push("invalid email");
    if (!row.username) {
      row.username = (row.email.split("@")[0] || "")
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "");
      if (!row.username) errs.push("cannot infer username");
    }

    if (errs.length)
      errors.push({
        line: i + (hasHeader ? 2 : 1),
        errors: errs.join(", "),
      });
    else
      rows.push({
        username: row.username,
        full_name: row.full_name,
        email: row.email,
        role: row.role || undefined,
        department_name: row.department_name || undefined,
        team_name: row.team_name || undefined,
      });
  });
  return { rows, errors };
}

export default function AddPeopleScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const { user: me } = useAuth();
  const kbInset = useKeyboardInset();
  const [busy, setBusy] = useState(false);

  const isPlatformAdmin = me?.role === "platform_admin";

  // Chosen input method (null = still on the method chooser).
  const [method, setMethod] = useState<Method | null>(null);

  // ─── Shared defaults / assignment ───
  const [role, setRole] = useState<string>("employee");
  const [orgId, setOrgId] = useState<string | number | null>(
    (me as any)?.org_id ?? null,
  );
  const [deptId, setDeptId] = useState<string | number | null>(null);
  const [teamId, setTeamId] = useState<string | number | null>(null);

  // ─── Single-user form ───
  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // ─── Paste ───
  const [pasted, setPasted] = useState("");
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [parseErrors, setParseErrors] = useState<ParseError[]>([]);

  // ─── File ───
  const [fileRows, setFileRows] = useState<ParsedRow[] | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  // ─── Result ───
  const [result, setResult] = useState<ImportUsersResult | null>(null);

  useEffect(() => {
    const { rows, errors } = parsePaste(pasted);
    setParsedRows(rows);
    setParseErrors(errors);
  }, [pasted]);

  // Platform admins pick which organization to add people to; everyone else is
  // scoped to their own org server-side.
  const { data: orgs = EMPTY_OPTIONS } = useQuery({
    queryKey: ["admin", "addPeople", "orgs"],
    enabled: isPlatformAdmin,
    queryFn: async () => {
      const r = await getAdminOrganizations();
      const list = (r.data as any)?.data || r.data || [];
      return [
        { value: null, label: "— Select organization —" },
        ...(Array.isArray(list) ? list : []).map((o: any) => ({
          value: o.id,
          label: o.name,
        })),
      ] as DropdownOption[];
    },
  });

  // Departments/Teams are org-scoped. Platform admins MUST pass org_id or the
  // server returns an empty list (their own org_id is null).
  const refDataEnabled = !isPlatformAdmin || orgId != null;
  const { data: refData } = useQuery({
    queryKey: ["admin", "addPeople", "refData", isPlatformAdmin ? orgId : null],
    enabled: refDataEnabled,
    queryFn: async () => {
      const params =
        isPlatformAdmin && orgId != null ? { org_id: Number(orgId) } : undefined;
      const [dRes, tRes] = await Promise.allSettled([
        getDepartments(params),
        getTeams(params),
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
    isPlatformAdmin ? true : canManageRole(me?.role ?? "", r),
  ).map((r) => ({ value: r, label: roleLabel(r) }));

  // Resolve the selected dept/team names for use as bulk-import row defaults.
  const deptName = useMemo(
    () => departments.find((d) => d.value === deptId)?.label,
    [departments, deptId],
  );
  const teamName = useMemo(
    () => teams.find((t) => t.value === teamId)?.label,
    [teams, teamId],
  );

  function resetToMethods() {
    setMethod(null);
    setResult(null);
    setFullName("");
    setUsername("");
    setEmail("");
    setPassword("");
    setPasted("");
    setParsedRows([]);
    setParseErrors([]);
    setFileRows(null);
    setFileName(null);
  }

  async function pickFile() {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        type: ["text/csv", "application/json", "text/comma-separated-values"],
      });
      if (res.canceled || !res.assets?.[0]) return;
      const asset = res.assets[0];
      if (!/\.(csv|json)$/i.test(asset.name || "")) {
        Alert.alert("Unsupported", "Only .csv or .json files are accepted.");
        return;
      }
      const raw = (
        await FileSystem.readAsStringAsync(asset.uri)
      ).trim();

      let rows: ParsedRow[] = [];
      if (/\.json$/i.test(asset.name || "")) {
        let json: any;
        try {
          json = JSON.parse(raw);
        } catch {
          Alert.alert("Invalid JSON", "The selected file is not valid JSON.");
          return;
        }
        const arr = Array.isArray(json) ? json : [];
        if (!Array.isArray(json)) {
          Alert.alert("Invalid JSON", "The JSON file must contain an array of users.");
          return;
        }
        rows = arr
          .map((u: any) => ({
            username: String(u.username || "").trim(),
            full_name: String(u.full_name || u.name || "").trim(),
            email: String(u.email || "").trim(),
            role: u.role ? String(u.role).trim() : undefined,
            department_name: u.department_name
              ? String(u.department_name).trim()
              : undefined,
            team_name: u.team_name ? String(u.team_name).trim() : undefined,
            manager_username: u.manager_username
              ? String(u.manager_username).trim()
              : undefined,
          }))
          .filter((u) => u.full_name && u.email);
      } else {
        // Reuse the paste parser for CSV content.
        const parsed = parsePaste(raw);
        rows = parsed.rows;
      }

      if (rows.length === 0) {
        Alert.alert("No rows", "No valid users were found in the file.");
        return;
      }
      if (rows.length > 200) {
        Alert.alert("Too many", "Maximum 200 users per import batch.");
        return;
      }
      setFileRows(rows);
      setFileName(asset.name || "selected file");
    } catch (e: any) {
      Alert.alert("Error", e?.message || "Failed to read file");
    }
  }

  // Apply the selected defaults (role / department / team) to rows that don't
  // already specify them, matching the web wizard behaviour.
  function withDefaults(rows: ParsedRow[]): ParsedRow[] {
    return rows.map((r) => ({
      ...r,
      role: r.role || role,
      department_name: r.department_name || deptName || undefined,
      team_name: r.team_name || teamName || undefined,
    }));
  }

  async function submitSingle() {
    if (!fullName.trim() || !username.trim() || !email.trim()) {
      Alert.alert("Required", "Full name, username and email are required");
      return;
    }
    if (isPlatformAdmin && orgId == null) {
      Alert.alert("Required", "Select an organization first");
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
        org_id: isPlatformAdmin ? (orgId ? Number(orgId) : null) : undefined,
        department_id: deptId ? Number(deptId) : null,
        team_id: teamId ? Number(teamId) : null,
      });
      const pw = data.initial_password
        ? `\n\nInitial password (shown once): ${data.initial_password}`
        : "";
      Alert.alert(
        "User created",
        (data.message || "User created successfully") + pw,
        [{ text: "OK", onPress: () => router.back() }],
      );
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to create user");
    } finally {
      setBusy(false);
    }
  }

  async function submitBulk(rows: ParsedRow[]) {
    if (rows.length === 0) {
      Alert.alert("Nothing to import", "No valid rows to import.");
      return;
    }
    if (isPlatformAdmin && orgId == null) {
      Alert.alert("Required", "Select an organization first");
      return;
    }
    setBusy(true);
    try {
      const { data } = await importAdminUsers(
        withDefaults(rows),
        isPlatformAdmin ? (orgId ? Number(orgId) : null) : undefined,
      );
      setResult(data);
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Import failed");
    } finally {
      setBusy(false);
    }
  }

  // ─── Render: method chooser ───
  if (!method) {
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: "Add People" }} />
        <ScrollView contentContainerStyle={styles.container}>
          <View style={styles.headerRow}>
            <UserPlus size={18} color={theme.primary} />
            <Text style={styles.heading}>How would you like to add people?</Text>
          </View>
          {METHODS.map((m) => {
            const Icon = m.icon;
            return (
              <Pressable
                key={m.key}
                style={styles.methodCard}
                onPress={() => setMethod(m.key)}
              >
                <View style={styles.methodIcon}>
                  <Icon size={20} color={theme.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.methodTitle}>{m.title}</Text>
                  <Text style={styles.methodDesc}>{m.desc}</Text>
                </View>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
    );
  }

  // ─── Render: result summary (bulk) ───
  if (result) {
    const creds = result.details.filter((d) => d.initial_password);
    return (
      <View style={styles.screen}>
        <Stack.Screen options={{ title: "Add People" }} />
        <ScrollView contentContainerStyle={styles.container}>
          <Text style={styles.heading}>Import complete</Text>
          <View style={styles.summaryRow}>
            <Text style={[styles.summaryPill, styles.summaryOk]}>
              {result.imported} imported
            </Text>
            {result.failed.length > 0 && (
              <Text style={[styles.summaryPill, styles.summaryFail]}>
                {result.failed.length} failed
              </Text>
            )}
          </View>

          {result.failed.length > 0 && (
            <View style={styles.errorBox}>
              <Text style={styles.errorTitle}>Failed rows</Text>
              {result.failed.slice(0, 20).map((f, i) => (
                <Text key={i} style={styles.errorRow}>
                  Row {f.row}: {f.error}
                </Text>
              ))}
              {result.failed.length > 20 && (
                <Text style={styles.errorRow}>
                  … and {result.failed.length - 20} more
                </Text>
              )}
            </View>
          )}

          {creds.length > 0 && (
            <View style={styles.credBox}>
              <Text style={styles.errorTitle}>
                Initial passwords (shown once)
              </Text>
              {creds.map((d) => (
                <View key={d.id} style={styles.credRow}>
                  <Text style={styles.credName}>
                    {d.full_name} (@{d.username})
                  </Text>
                  <Text style={styles.credPw}>{d.initial_password}</Text>
                </View>
              ))}
            </View>
          )}

          <Pressable style={styles.submitBtn} onPress={resetToMethods}>
            <Text style={styles.submitBtnText}>Add more people</Text>
          </Pressable>
          <Pressable
            style={styles.secondaryBtn}
            onPress={() => router.back()}
          >
            <Text style={styles.secondaryBtnText}>Done</Text>
          </Pressable>
        </ScrollView>
      </View>
    );
  }

  // Shared assignment defaults block (org / role / dept / team).
  const renderDefaults = () => (
    <>
      {isPlatformAdmin && (
        <>
          <Text style={styles.fieldLabel}>Organization *</Text>
          <Dropdown
            label="Organization"
            value={orgId}
            options={orgs}
            onChange={(v) => {
              setOrgId(v as any);
              setDeptId(null);
              setTeamId(null);
            }}
          />
        </>
      )}

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
    </>
  );

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Stack.Screen options={{ title: "Add People" }} />
      <ScrollView
        contentContainerStyle={[styles.container, { paddingBottom: 48 + kbInset }]}
      >
        <Pressable onPress={resetToMethods} style={styles.backLink}>
          <Text style={styles.backLinkText}>‹ Choose another method</Text>
        </Pressable>

        {method === "single" && (
          <>
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

            {renderDefaults()}

            <Pressable
              style={styles.submitBtn}
              onPress={submitSingle}
              disabled={busy}
            >
              <Text style={styles.submitBtnText}>
                {busy ? "Creating…" : "Create user"}
              </Text>
            </Pressable>
          </>
        )}

        {method === "paste" && (
          <>
            <View style={styles.headerRow}>
              <FileText size={18} color={theme.primary} />
              <Text style={styles.heading}>Paste a list</Text>
            </View>
            <Text style={styles.helpText}>
              One user per line. Tabs, commas, or semicolons accepted. First row
              may be a header (e.g. full_name, email, username, role).
            </Text>
            <TextInput
              style={styles.textarea}
              value={pasted}
              onChangeText={setPasted}
              onFocus={scrollFocusedIntoView}
              placeholder={
                "full_name, email, username, role\nJane Doe, jane@example.com, janedoe, employee"
              }
              placeholderTextColor={theme.textMuted}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
            />

            {pasted.length > 0 && (
              <View style={styles.summaryRow}>
                <Text style={[styles.summaryPill, styles.summaryOk]}>
                  {parsedRows.length} valid
                </Text>
                {parseErrors.length > 0 && (
                  <Text style={[styles.summaryPill, styles.summaryFail]}>
                    {parseErrors.length} skipped
                  </Text>
                )}
              </View>
            )}
            {parseErrors.length > 0 && (
              <View style={styles.errorBox}>
                <Text style={styles.errorTitle}>Skipped rows</Text>
                {parseErrors.slice(0, 5).map((e, i) => (
                  <Text key={i} style={styles.errorRow}>
                    Line {e.line}: {e.errors}
                  </Text>
                ))}
                {parseErrors.length > 5 && (
                  <Text style={styles.errorRow}>
                    … and {parseErrors.length - 5} more
                  </Text>
                )}
              </View>
            )}

            {renderDefaults()}

            <Pressable
              style={styles.submitBtn}
              onPress={() => submitBulk(parsedRows)}
              disabled={busy || parsedRows.length === 0}
            >
              <Text style={styles.submitBtnText}>
                {busy
                  ? "Importing…"
                  : `Import ${parsedRows.length} user${parsedRows.length === 1 ? "" : "s"}`}
              </Text>
            </Pressable>
          </>
        )}

        {method === "file" && (
          <>
            <View style={styles.headerRow}>
              <Upload size={18} color={theme.primary} />
              <Text style={styles.heading}>Upload a file</Text>
            </View>
            <Text style={styles.helpText}>
              CSV or JSON, max 200 users per batch. Required columns: username,
              full_name, email. Optional: password, role, department_name,
              team_name, manager_username.
            </Text>

            <Pressable style={styles.dropZone} onPress={pickFile}>
              <Upload size={26} color={theme.textSecondary} />
              <Text style={styles.dropTitle}>
                {fileName || "Tap to choose a CSV or JSON file"}
              </Text>
              {fileRows && (
                <Text style={styles.dropSub}>
                  {fileRows.length} user{fileRows.length === 1 ? "" : "s"} ready
                </Text>
              )}
            </Pressable>

            {renderDefaults()}

            <Pressable
              style={styles.submitBtn}
              onPress={() => fileRows && submitBulk(fileRows)}
              disabled={busy || !fileRows}
            >
              <Text style={styles.submitBtnText}>
                {busy
                  ? "Importing…"
                  : fileRows
                    ? `Import ${fileRows.length} user${fileRows.length === 1 ? "" : "s"}`
                    : "Import"}
              </Text>
            </Pressable>
          </>
        )}
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
    heading: { fontSize: 18, fontWeight: "700", color: theme.text, flexShrink: 1 },
    helpText: {
      fontSize: 12,
      color: theme.textSecondary,
      marginBottom: 8,
      lineHeight: 17,
    },
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
    textarea: {
      backgroundColor: theme.inputBg,
      borderWidth: 1,
      borderColor: theme.inputBorder,
      borderRadius: theme.radiusSm,
      paddingHorizontal: 14,
      paddingVertical: 12,
      color: theme.text,
      fontSize: 14,
      minHeight: 160,
      textAlignVertical: "top",
    },
    submitBtn: {
      backgroundColor: theme.primary,
      borderRadius: theme.radiusSm,
      paddingVertical: 14,
      alignItems: "center",
      marginTop: 18,
    },
    submitBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
    secondaryBtn: {
      borderRadius: theme.radiusSm,
      paddingVertical: 14,
      alignItems: "center",
      marginTop: 10,
      borderWidth: 1,
      borderColor: theme.inputBorder,
    },
    secondaryBtnText: { color: theme.text, fontSize: 15, fontWeight: "600" },
    // Method chooser
    methodCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.inputBorder,
      borderRadius: theme.radiusSm,
      padding: 14,
      marginTop: 4,
    },
    methodIcon: {
      width: 40,
      height: 40,
      borderRadius: 10,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.inputBg,
    },
    methodTitle: { fontSize: 15, fontWeight: "600", color: theme.text },
    methodDesc: { fontSize: 12, color: theme.textSecondary, marginTop: 2 },
    backLink: { marginBottom: 4 },
    backLinkText: { color: theme.primary, fontSize: 13, fontWeight: "600" },
    // Paste / summary
    summaryRow: { flexDirection: "row", gap: 8, marginTop: 8 },
    summaryPill: {
      fontSize: 12,
      fontWeight: "600",
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 999,
      overflow: "hidden",
    },
    summaryOk: {
      color: theme.success,
      backgroundColor: theme.inputBg,
    },
    summaryFail: {
      color: theme.danger,
      backgroundColor: theme.inputBg,
    },
    errorBox: {
      backgroundColor: theme.inputBg,
      borderRadius: theme.radiusSm,
      padding: 12,
      marginTop: 10,
      gap: 4,
    },
    errorTitle: {
      fontSize: 13,
      fontWeight: "700",
      color: theme.text,
      marginBottom: 4,
    },
    errorRow: { fontSize: 12, color: theme.textSecondary },
    // File
    dropZone: {
      borderWidth: 1,
      borderColor: theme.inputBorder,
      borderStyle: "dashed",
      borderRadius: theme.radiusSm,
      paddingVertical: 28,
      paddingHorizontal: 16,
      alignItems: "center",
      gap: 8,
      backgroundColor: theme.surface,
    },
    dropTitle: {
      fontSize: 14,
      fontWeight: "600",
      color: theme.text,
      textAlign: "center",
    },
    dropSub: { fontSize: 12, color: theme.success, fontWeight: "600" },
    // Credentials
    credBox: {
      backgroundColor: theme.inputBg,
      borderRadius: theme.radiusSm,
      padding: 12,
      marginTop: 12,
      gap: 8,
    },
    credRow: { gap: 2 },
    credName: { fontSize: 13, color: theme.text, fontWeight: "600" },
    credPw: { fontSize: 13, color: theme.primary, fontFamily: "monospace" },
  });