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
import { Pencil, Wallet, X } from "lucide-react-native";
import { theme } from "../../src/theme";
import { useKeyboardInset } from "../../src/hooks/useKeyboardInset";
import { Dropdown, type DropdownOption } from "../../src/components/Dropdown";
import {
  getCompensationTemplates,
  getEmployeeCompensations,
  setEmployeeCompensation,
  type EmployeeCompensation,
} from "../../src/admin";

function fmtMoney(v?: number | string | null): string {
  if (v == null || v === "") return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export default function CompensationScreen() {
  const kbInset = useKeyboardInset();
  const [items, setItems] = useState<EmployeeCompensation[]>([]);
  const [templates, setTemplates] = useState<DropdownOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<EmployeeCompensation | null>(null);
  const [annualCtc, setAnnualCtc] = useState("");
  const [templateId, setTemplateId] = useState<string | number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [empR, tmplR] = await Promise.allSettled([
      getEmployeeCompensations(),
      getCompensationTemplates(),
    ]);
    if (empR.status === "fulfilled") {
      setItems(Array.isArray(empR.value.data) ? empR.value.data : []);
    } else {
      const e = empR.reason as any;
      setItems([]);
      setError(e?.response?.data?.error || "Failed to load compensation");
    }
    if (tmplR.status === "fulfilled")
      setTemplates(
        (Array.isArray(tmplR.value.data) ? tmplR.value.data : []).map((t) => ({
          value: t.id,
          label: t.name,
        })),
      );
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function openEdit(emp: EmployeeCompensation) {
    setEditing(emp);
    setAnnualCtc(
      emp.annual_ctc != null && emp.annual_ctc !== ""
        ? String(emp.annual_ctc)
        : "",
    );
    setTemplateId(emp.template_id ?? null);
    setModalOpen(true);
  }

  async function save() {
    if (!editing) return;
    const ctc = Number(annualCtc);
    if (!annualCtc || !Number.isFinite(ctc) || ctc <= 0) {
      Alert.alert("Required", "Enter a valid annual CTC");
      return;
    }
    setBusy(true);
    try {
      await setEmployeeCompensation(editing.user_id, {
        annual_ctc: ctc,
        template_id: templateId ? Number(templateId) : null,
      });
      setModalOpen(false);
      load();
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  const filtered = search.trim()
    ? items.filter((i) =>
        (i.full_name || i.username || "")
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
      )
    : items;

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Stack.Screen options={{ title: "Compensation" }} />
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Compensation" }} />

      <View style={styles.searchWrap}>
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={setSearch}
          placeholder="Search employees…"
          placeholderTextColor={theme.textMuted}
        />
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(i) => String(i.user_id)}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <View style={styles.iconWrap}>
              <Wallet size={18} color={theme.primary} />
            </View>
            <View style={styles.body}>
              <Text style={styles.name} numberOfLines={1}>
                {item.full_name || item.username}
              </Text>
              <Text style={styles.meta} numberOfLines={1}>
                {item.annual_ctc != null && item.annual_ctc !== ""
                  ? `CTC ${fmtMoney(item.annual_ctc)}/yr`
                  : "No compensation set"}
                {item.template_name ? ` · ${item.template_name}` : ""}
              </Text>
            </View>
            <Pressable
              style={styles.iconBtn}
              onPress={() => openEdit(item)}
              hitSlop={6}
            >
              <Pencil size={16} color={theme.textSecondary} />
            </Pressable>
          </View>
        )}
        ListEmptyComponent={
          <Text style={styles.empty}>{error ?? "No employees found."}</Text>
        }
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
              <Text style={styles.sheetTitle} numberOfLines={1}>
                {editing?.full_name || editing?.username || "Compensation"}
              </Text>
              <Pressable onPress={() => setModalOpen(false)} hitSlop={8}>
                <X size={22} color={theme.textSecondary} />
              </Pressable>
            </View>
            <Text style={styles.fieldLabel}>Annual CTC</Text>
            <TextInput
              style={styles.input}
              value={annualCtc}
              onChangeText={setAnnualCtc}
              placeholder="e.g. 1200000"
              placeholderTextColor={theme.textMuted}
              keyboardType="numeric"
            />
            {templates.length > 0 ? (
              <>
                <Text style={styles.fieldLabel}>Compensation template</Text>
                <Dropdown
                  label="Template"
                  value={templateId}
                  options={[
                    { value: null, label: "— No template —" },
                    ...templates,
                  ]}
                  onChange={setTemplateId}
                />
              </>
            ) : null}
            <Pressable style={styles.saveBtn} onPress={save} disabled={busy}>
              <Text style={styles.saveBtnText}>
                {busy ? "Saving…" : "Save compensation"}
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
  center: { alignItems: "center", justifyContent: "center", flex: 1 },
  searchWrap: { padding: 16, paddingBottom: 8 },
  searchInput: {
    backgroundColor: theme.inputBg,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: theme.text,
    fontSize: 14,
  },
  list: { padding: 16, paddingTop: 4, gap: 10, paddingBottom: 40 },
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
    gap: 12,
  },
  sheetTitle: {
    flex: 1,
    fontSize: 18,
    fontWeight: "700",
    color: theme.text,
  },
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