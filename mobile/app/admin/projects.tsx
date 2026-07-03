import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import {
  Archive,
  ArchiveRestore,
  Folder,
  Plus,
  Trash2,
  X,
} from "../../src/icons";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import { useKeyboardInset } from "../../src/hooks/useKeyboardInset";
import {
  archiveProject,
  createProject,
  deleteProject,
  getProjects,
  type Project,
} from "../../src/admin";

const EMPTY_PROJECTS: Project[] = [];

export default function ProjectsScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const kbInset = useKeyboardInset();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [description, setDescription] = useState("");

  const { data: items = EMPTY_PROJECTS, isLoading: loading } = useQuery({
    queryKey: ["admin", "projects", showArchived],
    queryFn: async () => {
      const r = await getProjects(showArchived);
      const d = r.data as unknown;
      const arr = Array.isArray(d) ? d : ((d as any)?.projects ?? []);
      return arr as Project[];
    },
  });

  function openCreate() {
    setName("");
    setKey("");
    setDescription("");
    setModalOpen(true);
  }

  async function save() {
    if (!name.trim()) {
      Alert.alert("Required", "Project name is required");
      return;
    }
    setBusy(true);
    try {
      await createProject({
        name: name.trim(),
        key: key.trim() || undefined,
        description: description.trim() || undefined,
      });
      setModalOpen(false);
      queryClient.invalidateQueries({ queryKey: ["admin", "projects"] });
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to create");
    } finally {
      setBusy(false);
    }
  }

  function toggleArchive(p: Project) {
    archiveProject(p.id, !p.is_archived)
      .then(() =>
        queryClient.invalidateQueries({ queryKey: ["admin", "projects"] }),
      )
      .catch((e: any) =>
        Alert.alert("Error", e?.response?.data?.error || "Failed"),
      );
  }

  function confirmDelete(p: Project) {
    Alert.alert("Delete project", `Delete "${p.name}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          deleteProject(p.id)
            .then(() =>
              queryClient.invalidateQueries({
                queryKey: ["admin", "projects"],
              }),
            )
            .catch((e: any) =>
              Alert.alert(
                "Error",
                e?.response?.data?.error || "Failed to delete",
              ),
            ),
      },
    ]);
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Projects" }} />

      <View style={styles.filterRow}>
        <Pressable
          style={[styles.chip, !showArchived && styles.chipActive]}
          onPress={() => setShowArchived(false)}
        >
          <Text
            style={[styles.chipText, !showArchived && styles.chipTextActive]}
          >
            Active
          </Text>
        </Pressable>
        <Pressable
          style={[styles.chip, showArchived && styles.chipActive]}
          onPress={() => setShowArchived(true)}
        >
          <Text
            style={[styles.chipText, showArchived && styles.chipTextActive]}
          >
            All (incl. archived)
          </Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.primary} />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(p) => String(p.id)}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <View style={styles.card}>
              <View style={styles.iconWrap}>
                <Folder size={18} color={theme.primary} />
              </View>
              <View style={styles.body}>
                <View style={styles.nameRow}>
                  <Text style={styles.name} numberOfLines={1}>
                    {item.name}
                  </Text>
                  {item.key ? (
                    <View style={styles.keyBadge}>
                      <Text style={styles.keyText}>{item.key}</Text>
                    </View>
                  ) : null}
                </View>
                <Text style={styles.meta}>
                  {item.task_count ?? 0} tasks
                  {item.is_archived ? " · archived" : ""}
                </Text>
              </View>
              <Pressable
                style={styles.iconBtn}
                onPress={() => toggleArchive(item)}
                hitSlop={6}
              >
                {item.is_archived ? (
                  <ArchiveRestore size={16} color={theme.success} />
                ) : (
                  <Archive size={16} color={theme.textSecondary} />
                )}
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
          ListEmptyComponent={<Text style={styles.empty}>No projects.</Text>}
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
              <Text style={styles.sheetTitle}>New project</Text>
              <Pressable onPress={() => setModalOpen(false)} hitSlop={8}>
                <X size={22} color={theme.textSecondary} />
              </Pressable>
            </View>
            <Text style={styles.fieldLabel}>Name</Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="e.g. Web Platform"
              placeholderTextColor={theme.textMuted}
            />
            <Text style={styles.fieldLabel}>Key (optional, e.g. WEB)</Text>
            <TextInput
              style={styles.input}
              value={key}
              onChangeText={(t) => setKey(t.toUpperCase())}
              placeholder="WEB"
              placeholderTextColor={theme.textMuted}
              autoCapitalize="characters"
              maxLength={10}
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
                {busy ? "Creating…" : "Create project"}
              </Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.bg },
    center: { flex: 1, alignItems: "center", justifyContent: "center" },
    filterRow: { flexDirection: "row", gap: 8, padding: 16, paddingBottom: 8 },
    chip: {
      paddingHorizontal: 14,
      paddingVertical: 7,
      borderRadius: theme.radiusFull,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.glassBorder,
    },
    chipActive: { backgroundColor: theme.primary, borderColor: theme.primary },
    chipText: { fontSize: 13, color: theme.textSecondary, fontWeight: "500" },
    chipTextActive: { color: "#fff", fontWeight: "600" },
    list: { padding: 16, paddingTop: 4, gap: 10, paddingBottom: 90 },
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
    nameRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    name: { fontSize: 15, fontWeight: "600", color: theme.text, flexShrink: 1 },
    keyBadge: {
      backgroundColor: theme.surface,
      borderRadius: theme.radiusSm,
      paddingHorizontal: 6,
      paddingVertical: 1,
    },
    keyText: { fontSize: 10, color: theme.textSecondary, fontWeight: "700" },
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
