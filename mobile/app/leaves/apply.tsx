import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { theme } from "../../src/theme";
import { LEAVE_TYPES } from "../../src/constants";
import { applyLeave } from "../../src/features";
import DatePicker from "../../src/components/DatePicker";

const TYPES = Object.entries(LEAVE_TYPES).map(([value, meta]) => ({
  value,
  ...meta,
}));
const DURATIONS: { value: "full" | "half" | "quarter"; label: string }[] = [
  { value: "full", label: "Full Day" },
  { value: "half", label: "Half Day" },
  { value: "quarter", label: "Quarter" },
];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export default function ApplyLeaveScreen() {
  const router = useRouter();
  const [type, setType] = useState("planned");
  const [duration, setDuration] = useState<"full" | "half" | "quarter">("full");
  const [date, setDate] = useState(todayISO());
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const dateValid = /^\d{4}-\d{2}-\d{2}$/.test(date);

  async function submit() {
    if (!dateValid) {
      Alert.alert("Invalid date", "Use the format YYYY-MM-DD.");
      return;
    }
    setBusy(true);
    try {
      await applyLeave({
        leave_type: type,
        dates: [date],
        duration,
        reason: reason.trim() || undefined,
      });
      Alert.alert("Submitted", "Your leave request has been submitted.", [
        { text: "OK", onPress: () => router.back() },
      ]);
    } catch (e: any) {
      Alert.alert("Error", e?.response?.data?.error || "Failed to submit leave");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      {/* Leave type */}
      <Text style={styles.label}>Leave Type</Text>
      <View style={styles.chips}>
        {TYPES.map((t) => {
          const active = t.value === type;
          return (
            <Pressable
              key={t.value}
              style={[
                styles.chip,
                { borderColor: active ? t.color : theme.glassBorder },
                active && { backgroundColor: t.bg },
              ]}
              onPress={() => setType(t.value)}
            >
              <View style={[styles.chipDot, { backgroundColor: t.color }]} />
              <Text style={[styles.chipText, active && { color: t.color }]}>
                {t.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Duration */}
      <Text style={styles.label}>Duration</Text>
      <View style={styles.segment}>
        {DURATIONS.map((d) => {
          const active = d.value === duration;
          return (
            <Pressable
              key={d.value}
              style={[styles.segmentBtn, active && styles.segmentActive]}
              onPress={() => setDuration(d.value)}
            >
              <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                {d.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Date */}
      <Text style={styles.label}>Date</Text>
      <DatePicker value={date} onChange={setDate} />

      {/* Reason */}
      <Text style={styles.label}>Reason (optional)</Text>
      <TextInput
        style={[styles.input, styles.textarea]}
        placeholder="Reason for leave"
        placeholderTextColor={theme.textMuted}
        value={reason}
        onChangeText={setReason}
        multiline
        maxLength={500}
      />

      <Pressable
        style={[styles.submit, busy && styles.submitDisabled]}
        onPress={submit}
        disabled={busy}
      >
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.submitText}>Submit Request</Text>
        )}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  container: { padding: 16, gap: 8 },
  label: {
    fontSize: 11,
    fontWeight: "600",
    color: theme.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 10,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: theme.radiusFull,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chipDot: { width: 8, height: 8, borderRadius: 4 },
  chipText: { fontSize: 13, color: theme.textSecondary, fontWeight: "500" },
  segment: {
    flexDirection: "row",
    backgroundColor: theme.surface,
    borderRadius: theme.radiusSm,
    padding: 3,
    gap: 3,
  },
  segmentBtn: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 5,
    alignItems: "center",
  },
  segmentActive: { backgroundColor: theme.primary },
  segmentText: { fontSize: 13, color: theme.textSecondary, fontWeight: "600" },
  segmentTextActive: { color: "#fff" },
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
  textarea: { minHeight: 90, textAlignVertical: "top" },
  submit: {
    backgroundColor: theme.primary,
    borderRadius: theme.radiusSm,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 20,
  },
  submitDisabled: { opacity: 0.5 },
  submitText: { color: "#fff", fontSize: 15, fontWeight: "600" },
});
