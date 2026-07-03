import { useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from "../icons";
import type { Theme } from "../theme";
import { useTheme } from "../theme/ThemeProvider";

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function parseYM(value?: string): { y: number; m: number } | null {
  if (!value || !/^\d{4}-\d{2}$/.test(value)) return null;
  const [y, m] = value.split("-").map((n) => parseInt(n, 10));
  if (m < 1 || m > 12) return null;
  return { y, m: m - 1 };
}

export interface MonthPickerProps {
  /** Selected value in YYYY-MM format. */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

/**
 * Pure-JS month picker. Pressable field opening a year+month grid modal.
 * Returns YYYY-MM strings.
 */
export default function MonthPicker({
  value,
  onChange,
  disabled,
}: MonthPickerProps) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [open, setOpen] = useState(false);
  const parsed = useMemo(() => parseYM(value), [value]);
  const [year, setYear] = useState(parsed?.y ?? new Date().getFullYear());

  const openModal = () => {
    if (disabled) return;
    setYear(parsed?.y ?? new Date().getFullYear());
    setOpen(true);
  };

  const label = parsed
    ? `${MONTHS_SHORT[parsed.m]} ${parsed.y}`
    : "Select month";

  return (
    <>
      <Pressable
        style={[styles.field, disabled && styles.fieldDisabled]}
        onPress={openModal}
      >
        <CalendarIcon size={15} color={theme.textSecondary} />
        <Text style={[styles.fieldText, !parsed && styles.fieldPlaceholder]}>
          {label}
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
            <View style={styles.header}>
              <Pressable
                hitSlop={8}
                style={styles.navBtn}
                onPress={() => setYear((y) => y - 1)}
              >
                <ChevronLeft size={20} color={theme.textSecondary} />
              </Pressable>
              <Text style={styles.headerLabel}>{year}</Text>
              <Pressable
                hitSlop={8}
                style={styles.navBtn}
                onPress={() => setYear((y) => y + 1)}
              >
                <ChevronRight size={20} color={theme.textSecondary} />
              </Pressable>
            </View>

            <View style={styles.grid}>
              {MONTHS_LONG.map((mName, idx) => {
                const isSelected =
                  parsed?.y === year && parsed?.m === idx;
                return (
                  <Pressable
                    key={mName}
                    style={[
                      styles.monthCell,
                      isSelected && styles.monthCellActive,
                    ]}
                    onPress={() => {
                      onChange(`${year}-${String(idx + 1).padStart(2, "0")}`);
                      setOpen(false);
                    }}
                  >
                    <Text
                      style={[
                        styles.monthText,
                        isSelected && styles.monthTextActive,
                      ]}
                    >
                      {MONTHS_SHORT[idx]}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: theme.inputBg,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minWidth: 130,
  },
  fieldDisabled: { opacity: 0.5 },
  fieldText: { color: theme.text, fontSize: 14, flex: 1 },
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
    maxWidth: 340,
    backgroundColor: theme.bgElevated,
    borderRadius: theme.radiusLg,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    padding: 16,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  headerLabel: { fontSize: 18, fontWeight: "800", color: theme.text },
  navBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    alignItems: "center",
    justifyContent: "center",
  },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  monthCell: {
    width: "22%",
    flexGrow: 1,
    paddingVertical: 14,
    borderRadius: theme.radiusSm,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    alignItems: "center",
  },
  monthCellActive: { backgroundColor: theme.primary, borderColor: theme.primary },
  monthText: { fontSize: 14, color: theme.text, fontWeight: "600" },
  monthTextActive: { color: "#fff", fontWeight: "800" },
});