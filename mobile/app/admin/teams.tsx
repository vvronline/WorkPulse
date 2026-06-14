import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
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
import { Pencil, Plus, Trash2, UsersRound, X } from "lucide-react-native";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import { useDialog } from "../../src/hooks/useDialog";
import { useKeyboardInset } from "../../src/hooks/useKeyboardInset";
import { useAuth } from "../../src/auth/AuthContext";
import { Dropdown, type DropdownOption } from "../../src/components/Dropdown";
import {
  createTeam,
  deleteTeam,
  getDepartments,
  getTeams,
  updateTeam,
  type Team,
} from "../../src/admin";

export default function TeamsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { alert, confirm, dialog } = useDialog();
  const kbInset = useKeyboardInset();
  const { user } = useAuth();
  // Platform admins are not scoped to a single org server-side, so the
  // teams/departments endpoints require an explicit org_id (read + write).
  const isPlatformAdmin = user?.role === "platform_admin";
  const orgId = (user as any)?.org_id as number | undefined;
  const [items, setItems] = useState<Team[]>([]);
  const [departments, setDepartments] = useState<DropdownOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Team | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [deptId, setDeptId] = useState<string | number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params =
      isPlatformAdmin && orgId != null ? { org_id: orgId } : undefined;
    const [tRes, dRes] = await Promise.allSettled([
      getTeams(params),
      getDepartments(params),
    ]);
    if (tRes.status === "fulfilled") {
      setItems(Array.isArray(tRes.value.data) ? tRes.value.data : []);
    } else {
      setItems([]);
      const e = tRes.reason as any;
      setError(e?.response?.data?.error || "Failed to load teams");
    }
    if (dRes.status === "fulfilled")
      setDepartments([
        { value: null, label: "— No department —" },
        ...(Array.isArray(dRes.value.data) ? dRes.value.data : []).map((d) => ({
          value: d.id,
          label: d.name,
        })),
      ]);
    setLoading(false);
  }, [isPlatformAdmin, orgId]);

  useEffect(() => {
    load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    setName("");
    setDescription("");
    setDeptId(null);
    setModalOpen(true);
  }

  function openEdit(t: Team) {
    setEditing(t);
    setName(t.name);
    setDescription(t.description ?? "");
    setDeptId(t.department_id ?? null);
    setModalOpen(true);
  }

  async function save() {
    if (!name.trim()) {
      alert("Required", "Team name is required");
      return;
    }
    setBusy(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim() || undefined,
        department_id: deptId ? Number(deptId) : null,
        ...(isPlatformAdmin && orgId != null ? { org_id: orgId } : {}),
      };
      if (editing) await updateTeam(editing.id, payload);
      else await createTeam(payload);
      setModalOpen(false);
      load();
    } catch (e: any) {
      // A network/timeout error (no HTTP response) does NOT mean the write
      // failed — the server may have committed the row while the client gave
      // up waiting. Don't surface a false failure: close the modal and reload
      // so the list reflects the actual server state. Only show an alert for a
      // real server-returned rejection (4xx/5xx with an error body).
      if (e?.response) {
        alert("Error", e.response.data?.error || "Failed to save");
      } else {
        setModalOpen(false);
        load();
      }
    } finally {
      setBusy(false);
    }
  }

  function confirmDelete(t: Team) {
    confirm({
      title: "Delete team",
      message: `Delete "${t.name}"?`,
      confirmText: "Delete",
      isDanger: true,
      onConfirm: async () => {
        try {
          await deleteTeam(t.id);
          load();
        } catch (e: any) {
          alert("Error", e?.response?.data?.error || "Failed to delete");
        }
      },
    });
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Teams" }} />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.primary} />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(t) => String(t.id)}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <View style={styles.card}>
              <View style={styles.iconWrap}>
                <UsersRound size={18} color={theme.primary} />
              </View>
              <View style={styles.body}>
                <Text style={styles.name}>{item.name}</Text>
                <Text style={styles.meta}>
                  {[item.department_name, `${item.member_count ?? 0} members`]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
              </View>
              <Pressable
                style={styles.iconBtn}
                onPress={() => openEdit(item)}
                hitSlop={6}
              >
                <Pencil size={16} color={theme.textSecondary} />
              </Pressable>
              <Pressable
                style={styles.iconBtn}
                onPress={() => confirmDelete(item)}
                hitSlop={6}
              >
                <Trash2 size={16} color={theme.danger} />
              </Pressable>
            </View>
          )}
          ListEmptyComponent={
            <Text style={styles.empty}>{error ?? "No teams yet."}</Text>
          }
        />
      )}

      <Pressable style={styles.fab} onPress={openCreate}>
        <Plus size={24} color="#fff" />
      </Pressable>

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
              <Text style={styles.sheetTitle}>
                {editing ? "Edit team" : "New team"}
              </Text>
              <Pressable onPress={() => setModalOpen(false)} hitSlop={8}>
                <X size={22} color={theme.textSecondary} />
              </Pressable>
            </View>
            <Text style={styles.fieldLabel}>Name</Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="e.g. Platform Team"
              placeholderTextColor={theme.textMuted}
            />
            <Text style={styles.fieldLabel}>Department</Text>
            <Dropdown
              label="Department"
              value={deptId}
              options={departments}
              onChange={setDeptId}
            />
            <Text style={styles.fieldLabel}>Description (optional)</Text>
            <TextInput
              style={[styles.input, styles.inputMultiline]}
              value={description}
              onChangeText={setDescription}
              placeholder="Short description"
              placeholderTextColor={theme.textMuted}
              multiline
            />
            <Pressable style={styles.saveBtn} onPress={save} disabled={busy}>
              <Text style={styles.saveBtnText}>
                {busy ? "Saving…" : editing ? "Save changes" : "Create"}
              </Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Themed confirm / alert dialog (replaces OS-native Alert). */}
      {dialog}
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  list: { padding: 16, gap: 10, paddingBottom: 90 },
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
  inputMultiline: { minHeight: 70, textAlignVertical: "top" },
  saveBtn: {
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 13,
    alignItems: "center",
    marginTop: 6,
  },
  saveBtnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
});