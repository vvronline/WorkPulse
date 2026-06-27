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
import { DollarSign, Lock, Plus, Trash2, X } from "lucide-react-native";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import { useKeyboardInset } from "../../src/hooks/useKeyboardInset";
import DatePicker from "../../src/components/DatePicker";
import {
  createPayPeriod,
  deletePayPeriod,
  getPayPeriods,
  type PayPeriod,
} from "../../src/admin";

const EMPTY_PERIODS: PayPeriod[] = [];

function monthRange() {
  const d = new Date();
  d.setDate(1);
  const start = d.toISOString().slice(0, 10);
  d.setMonth(d.getMonth() + 1, 0);
  const end = d.toISOString().slice(0, 10);
  return { start, end };
}

function fmtDate(d?: string) {
  if (!d) return "";
  return new Date(d).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function PayrollScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const kbInset = useKeyboardInset();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [startDate, setStartDate] = useState(monthRange().start);
  const [endDate, setEndDate] = useState(monthRange().end);

  const { data: items = EMPTY_PERIODS, isLoading: loading } = useQuery({
    queryKey: ["admin", "payroll"],
    queryFn: async () => {
      try {
        const r = await getPayPeriods();
        return r.data || EMPTY_PERIODS;
      } catch {
        return EMPTY_PERIODS;
      }
    },
  });

  function openCreate() {
    const { start, end } = monthRange();
    setLabel("");
    setStartDate(start);
    setEndDate(end);
    setModalOpen(true);
  }

  async function save() {
    if (!label.trim() || !startDate || !endDate) {
      Alert.alert("Required", "Label, start and end dates are required");
      return;
    }
    if (endDate < startDate) {
      Alert.alert("Invalid", "End date must be on or after start date");
      return;
    }
    setBusy(true);
    const payload = {
      label: label.trim(),
      start_date: startDate,
      end_date: endDate,
    };
    try {
      await createPayPeriod(payload);
      setModalOpen(false);
      queryClient.invalidateQueries({ queryKey: ["admin", "payroll"] });
    } catch (e: any) {
      // Cold-start tenant DB writes can exceed the client timeout (or drop the
      // response) even though the row committed server-side — surfacing a false
      // "failed to create". Before alarming the user, re-fetch and check whether
      // the period actually persisted; only warn if it genuinely didn't.
      const status = e?.response?.status;
      // A 409 (duplicate) is a real, deterministic error — surface it as-is.
      if (status === 409) {
        Alert.alert(
          "Error",
          e?.response?.data?.error ||
            "A pay period with these dates already exists",
        );
        setBusy(false);
        return;
      }
      try {
        const r = await getPayPeriods();
        const list = r.data || [];
        const created = list.find(
          (p) =>
            p.label === payload.label &&
            String(p.start_date).slice(0, 10) === payload.start_date &&
            String(p.end_date).slice(0, 10) === payload.end_date,
        );
        if (created) {
          // It actually saved — treat as success.
          queryClient.setQueryData(["admin", "payroll"], list);
          setModalOpen(false);
          setBusy(false);
          return;
        }
      } catch {
        /* fall through to the error alert below */
      }
      Alert.alert("Error", e?.response?.data?.error || "Failed to create");
    } finally {
      setBusy(false);
    }
  }

  function confirmDelete(p: PayPeriod) {
    Alert.alert("Delete pay period", `Delete "${p.label}"?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          deletePayPeriod(p.id)
            .then(() =>
              queryClient.invalidateQueries({ queryKey: ["admin", "payroll"] }),
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
      <Stack.Screen options={{ title: "Payroll Periods" }} />

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
                <DollarSign size={18} color={theme.primary} />
              </View>
              <View style={styles.body}>
                <View style={styles.nameRow}>
                  <Text style={styles.name}>{item.label}</Text>
                  {item.is_locked ? (
                    <Lock size={13} color={theme.warning} />
                  ) : null}
                </View>
                <Text style={styles.meta}>
                  {fmtDate(item.start_date)} – {fmtDate(item.end_date)}
                </Text>
              </View>
              {!item.is_locked ? (
                <Pressable
                  style={styles.iconBtn}
                  onPress={() => confirmDelete(item)}
                  hitSlop={6}
                >
                  <Trash2 size={16} color={theme.danger} />
                </Pressable>
              ) : null}
            </View>
          )}
          ListEmptyComponent={
            <Text style={styles.empty}>No pay periods yet.</Text>
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
              <Text style={styles.sheetTitle}>New pay period</Text>
              <Pressable onPress={() => setModalOpen(false)} hitSlop={8}>
                <X size={22} color={theme.textSecondary} />
              </Pressable>
            </View>
            <Text style={styles.fieldLabel}>Label</Text>
            <TextInput
              style={styles.input}
              value={label}
              onChangeText={setLabel}
              placeholder="e.g. June 2026"
              placeholderTextColor={theme.textMuted}
            />
            <Text style={styles.fieldLabel}>Start date</Text>
            <DatePicker
              value={startDate}
              onChange={(v) => {
                setStartDate(v);
                if (endDate && v > endDate) setEndDate(v);
              }}
            />
            <Text style={styles.fieldLabel}>End date</Text>
            <DatePicker
              value={endDate}
              onChange={setEndDate}
              minDate={startDate || undefined}
            />
            <Pressable style={styles.saveBtn} onPress={save} disabled={busy}>
              <Text style={styles.saveBtnText}>
                {busy ? "Creating…" : "Create period"}
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
