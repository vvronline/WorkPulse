import { useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Clock } from "lucide-react-native";
import { theme } from "../theme";

const ROW_HEIGHT = 44;

function clampHHMM(value?: string): { h: number; m: number } | null {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [h, m] = value.split(":").map((n) => parseInt(n, 10));
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return { h, m };
}

function fmt(h: number, m: number): string {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function to12h(h: number, m: number): string {
  const period = h >= 12 ? "PM" : "AM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:${String(m).padStart(2, "0")} ${period}`;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
/** Minute steps of 5 for a compact wheel. */
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);

export interface TimePickerProps {
  /** Selected value in HH:mm (24h) format. */
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

/**
 * Pure-JS time picker (no native modules). Pressable field that opens a themed
 * hour/minute selector modal. Returns HH:mm (24-hour) strings.
 */
export default function TimePicker({
  value,
  onChange,
  placeholder = "Select time",
  disabled,
}: TimePickerProps) {
  const [open, setOpen] = useState(false);
  const parsed = useMemo(() => clampHHMM(value), [value]);
  const [hour, setHour] = useState(parsed?.h ?? 9);
  const [minute, setMinute] = useState(parsed?.m ?? 0);

  const hourRef = useRef<ScrollView>(null);
  const minRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (open) {
      const p = clampHHMM(value);
      setHour(p?.h ?? 9);
      setMinute(p?.m ?? 0);
    }
  }, [open, value]);

  const openModal = () => {
    if (disabled) return;
    setOpen(true);
  };

  const confirm = () => {
    onChange(fmt(hour, minute));
    setOpen(false);
  };

  // Snap nearest minute to a 5-step for display selection state.
  const nearestMinIndex = MINUTES.reduce(
    (best, m, idx) =>
      Math.abs(m - minute) < Math.abs(MINUTES[best] - minute) ? idx : best,
    0,
  );

  return (
    <>
      <Pressable
        style={[styles.field, disabled && styles.fieldDisabled]}
        onPress={openModal}
      >
        <Clock size={16} color={theme.textSecondary} />
        <Text style={[styles.fieldText, !parsed && styles.fieldPlaceholder]}>
          {parsed ? to12h(parsed.h, parsed.m) : placeholder}
        </Text>
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.title}>{to12h(hour, minute)}</Text>

            <View style={styles.wheels}>
              <View style={styles.wheelCol}>
                <Text style={styles.wheelLabel}>Hour</Text>
                <ScrollView
                  ref={hourRef}
                  style={styles.wheel}
                  showsVerticalScrollIndicator={false}
                  contentContainerStyle={styles.wheelContent}
                >
                  {HOURS.map((h) => (
                    <Pressable
                      key={h}
                      style={[
                        styles.wheelItem,
                        hour === h && styles.wheelItemActive,
                      ]}
                      onPress={() => setHour(h)}
                    >
                      <Text
                        style={[
                          styles.wheelText,
                          hour === h && styles.wheelTextActive,
                        ]}
                      >
                        {String(h).padStart(2, "0")}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>

              <View style={styles.wheelCol}>
                <Text style={styles.wheelLabel}>Minute</Text>
                <ScrollView
                  ref={minRef}
                  style={styles.wheel}
                  showsVerticalScrollIndicator={false}
                  contentContainerStyle={styles.wheelContent}
                >
                  {MINUTES.map((m, idx) => (
                    <Pressable
                      key={m}
                      style={[
                        styles.wheelItem,
                        nearestMinIndex === idx && styles.wheelItemActive,
                      ]}
                      onPress={() => setMinute(m)}
                    >
                      <Text
                        style={[
                          styles.wheelText,
                          nearestMinIndex === idx && styles.wheelTextActive,
                        ]}
                      >
                        {String(m).padStart(2, "0")}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
            </View>

            <View style={styles.footer}>
              <Pressable
                style={styles.footerBtn}
                onPress={() => setOpen(false)}
              >
                <Text style={styles.footerBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.footerBtn, styles.footerBtnPrimary]}
                onPress={confirm}
              >
                <Text style={styles.footerBtnTextPrimary}>Set Time</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: theme.inputBg,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  fieldDisabled: { opacity: 0.5 },
  fieldText: { color: theme.text, fontSize: 15, flex: 1 },
  fieldPlaceholder: { color: theme.textMuted },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  sheet: {
    width: "100%",
    maxWidth: 320,
    backgroundColor: theme.bgElevated,
    borderRadius: theme.radiusLg,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    padding: 16,
  },
  title: {
    fontSize: 24,
    fontWeight: "800",
    color: theme.text,
    textAlign: "center",
    marginBottom: 12,
  },
  wheels: { flexDirection: "row", gap: 12, justifyContent: "center" },
  wheelCol: { flex: 1, alignItems: "center" },
  wheelLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: theme.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  wheel: {
    height: ROW_HEIGHT * 4,
    width: "100%",
    backgroundColor: theme.glass,
    borderRadius: theme.radiusSm,
    borderWidth: 1,
    borderColor: theme.glassBorder,
  },
  wheelContent: { paddingVertical: 4 },
  wheelItem: {
    height: ROW_HEIGHT,
    alignItems: "center",
    justifyContent: "center",
    marginHorizontal: 6,
    borderRadius: theme.radiusSm,
  },
  wheelItemActive: { backgroundColor: theme.primary },
  wheelText: { fontSize: 18, color: theme.text, fontWeight: "500" },
  wheelTextActive: { color: "#fff", fontWeight: "800" },
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 16,
  },
  footerBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: theme.radiusSm,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
  },
  footerBtnPrimary: { backgroundColor: theme.primary, borderColor: theme.primary },
  footerBtnText: { color: theme.text, fontSize: 13, fontWeight: "600" },
  footerBtnTextPrimary: { color: "#fff", fontSize: 13, fontWeight: "700" },
});