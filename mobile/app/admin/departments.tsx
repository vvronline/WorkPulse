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
import { Building, Pencil, Plus, Trash2, X } from "lucide-react-native";
import { theme } from "../../src/theme";
import { useKeyboardInset } from "../../src/hooks/useKeyboardInset";
import { useAuth } from "../../src/auth/AuthContext";
import {
  createDepartment,
  deleteDepartment,
  getDepartments,
  updateDepartment,
  type Department,
} from "../../src/admin";

export default function DepartmentsScreen() {
  const kbInset = useKeyboardInset();
  const { user } = useAuth();
  // Platform admins are not scoped to a single org server-side, so the
  // departments endpoints require an explicit org_id (read + write).
  const isPlatformAdmin = user?.role === "platform_admin";
  const orgId = (user as any)?.org_id as number | undefined;
  const [items, setItems] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Department | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    const params =
      isPlatformAdmin && orgId != null ? { org_id: orgId } : undefined;
    getDepartments(params)
      .then((r) => setItems(Array.isArray(r.data) ? r.data : []))
      .catch((e: any) => {
        setItems([]);
        setError(e?.response?.data?.error || "Failed to load departments");
      })
      .finally(() => setLoading(false));
  }, [isPlatformAdmin, orgId]);

  useEffect(() => {
    load();
  }, [load]);

  function openCreate() {
    setEditing(null);
    setName("");
    setDescription("");
    setModalOpen(true);
  }

  function openEdit(d: Department) {
    setEditing(d);
    setName(d.name);
    setDescription(d.description ?? "");
    setModalOpen(true);
  }

  async function save() {
    if (!name.trim()) {
      Alert.alert("Required", "Department name is required");
      return;
    }
    setBusy(true);
    try {
      const orgField =
        isPlatformAdmin && orgId != null ? { org_id: orgId } : {};
      if (editing) {
        await updateDepartment(editing.id, {
          name: name.trim(),
          description: description.trim() || undefined,
          ...orgField,
        });
      } else {
        await createDepartment({
          name: name.trim(),
          description: description.trim() || undefined,
          ...orgField,
        });
      }
      setModalOpen(false);
      load();
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  function confirmDelete(d: Department) {
    Alert.alert("Delete department", `Delete "${d.name}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await deleteDepartment(d.id);
            load();
          } catch (e: any) {
            Alert.alert("Error", e?.response?.data?.error || "Failed to delete");
          }
        },
      },
    ]);
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Departments" }} />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.primary} />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(d) => String(d.id)}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <View style={styles.card}>
              <View style={styles.iconWrap}>
                <Building size={18} color={theme.primary} />
              </View>
              <View style={styles.body}>
                <Text style={styles.name}>{item.name}</Text>
                {item.description ? (
                  <Text style={styles.desc} numberOfLines={1}>
                    {item.description}
                  </Text>
                ) : null}
                <Text style={styles.meta}>
                  {item.member_count ?? 0} members
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
            <Text style={styles.empty}>{error ?? "No departments yet."}</Text>
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
                {editing ? "Edit department" : "New department"}
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
              placeholder="e.g. Engineering"
              placeholderTextColor={theme.textMuted}
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
    </View>
  );
}

const styles = StyleSheet.create({
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
  desc: { fontSize: 12, color: theme.textSecondary },
  meta: { fontSize: 11, color: theme.textMuted },
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