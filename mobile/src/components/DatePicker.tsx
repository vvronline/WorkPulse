import { useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
} from "../icons";
import type { Theme } from "../theme";
import { useTheme } from "../theme/ThemeProvider";

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTHS = [
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

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

function parseYMD(value?: string): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(value + "T00:00:00");
  return isNaN(d.getTime()) ? null : d;
}

function buildMonthGrid(cursor: Date): Date[] {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const startOffset = first.getDay();
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - startOffset);
  const days: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    days.push(d);
  }
  return days;
}

export interface DatePickerProps {
  /** Selected value in YYYY-MM-DD format (empty string = unset). */
  value: string;
  onChange: (value: string) => void;
  /** Minimum selectable date (YYYY-MM-DD). */
  minDate?: string;
  /** Maximum selectable date (YYYY-MM-DD). */
  maxDate?: string;
  placeholder?: string;
  /** Disable interaction. */
  disabled?: boolean;
}

/**
 * Pure-JS date picker (no native modules). Renders a pressable field that
 * opens a themed month-grid calendar modal. Returns YYYY-MM-DD strings.
 */
export default function DatePicker({
  value,
  onChange,
  minDate,
  maxDate,
  placeholder = "Select date",
  disabled,
}: DatePickerProps) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [open, setOpen] = useState(false);
  const selected = useMemo(() => parseYMD(value), [value]);
  const [cursor, setCursor] = useState<Date>(
    () => selected || new Date(),
  );

  const min = useMemo(() => parseYMD(minDate), [minDate]);
  const max = useMemo(() => parseYMD(maxDate), [maxDate]);
  const days = useMemo(() => buildMonthGrid(cursor), [cursor]);
  const todayKey = ymd(new Date());

  const openModal = () => {
    if (disabled) return;
    setCursor(selected || new Date());
    setOpen(true);
  };

  const isDisabled = (d: Date): boolean => {
    const k = ymd(d);
    if (min && k < ymd(min)) return true;
    if (max && k > ymd(max)) return true;
    return false;
  };

  const label = selected
    ? selected.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : placeholder;

  return (
    <>
      <Pressable
        style={[styles.field, disabled && styles.fieldDisabled]}
        onPress={openModal}
      >
        <CalendarIcon size={16} color={theme.textSecondary} />
        <Text style={[styles.fieldText, !selected && styles.fieldPlaceholder]}>
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
                onPress={() =>
                  setCursor(
                    (c) => new Date(c.getFullYear(), c.getMonth() - 1, 1),
                  )
                }
              >
                <ChevronLeft size={20} color={theme.textSecondary} />
              </Pressable>
              <Text style={styles.headerLabel}>
                {MONTHS[cursor.getMonth()]} {cursor.getFullYear()}
              </Text>
              <Pressable
                hitSlop={8}
                style={styles.navBtn}
                onPress={() =>
                  setCursor(
                    (c) => new Date(c.getFullYear(), c.getMonth() + 1, 1),
                  )
                }
              >
                <ChevronRight size={20} color={theme.textSecondary} />
              </Pressable>
            </View>

            <View style={styles.weekRow}>
              {WEEKDAYS.map((w, i) => (
                <Text key={i} style={styles.weekday}>
                  {w}
                </Text>
              ))}
            </View>

            <View style={styles.grid}>
              {days.map((d) => {
                const key = ymd(d);
                const inMonth = d.getMonth() === cursor.getMonth();
                const isSelected = selected ? key === ymd(selected) : false;
                const isToday = key === todayKey;
                const blocked = isDisabled(d);
                return (
                  <Pressable
                    key={key}
                    style={styles.cell}
                    disabled={blocked}
                    onPress={() => {
                      onChange(key);
                      setOpen(false);
                    }}
                  >
                    <View
                      style={[
                        styles.cellInner,
                        isSelected && styles.cellSelected,
                        isToday && !isSelected && styles.cellToday,
                      ]}
                    >
                      <Text
                        style={[
                          styles.cellNum,
                          !inMonth && styles.cellNumMuted,
                          blocked && styles.cellNumBlocked,
                          isSelected && styles.cellNumActive,
                        ]}
                      >
                        {d.getDate()}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>

            <View style={styles.footer}>
              <Pressable
                style={styles.footerBtn}
                onPress={() => {
                  const now = new Date();
                  if (!isDisabled(now)) {
                    onChange(ymd(now));
                    setOpen(false);
                  } else {
                    setCursor(new Date(now.getFullYear(), now.getMonth(), 1));
                  }
                }}
              >
                <Text style={styles.footerBtnText}>Today</Text>
              </Pressable>
              <Pressable
                style={styles.footerBtn}
                onPress={() => setOpen(false)}
              >
                <Text style={styles.footerBtnText}>Close</Text>
              </Pressable>
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
    maxWidth: 360,
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
    marginBottom: 12,
  },
  headerLabel: { fontSize: 16, fontWeight: "800", color: theme.text },
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
  weekRow: { flexDirection: "row", marginBottom: 4 },
  weekday: {
    flex: 1,
    textAlign: "center",
    fontSize: 11,
    fontWeight: "700",
    color: theme.textMuted,
  },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  cell: { width: `${100 / 7}%`, aspectRatio: 1, padding: 2 },
  cellInner: {
    flex: 1,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  cellSelected: { backgroundColor: theme.primary },
  cellToday: { backgroundColor: theme.primaryGlow },
  cellNum: { fontSize: 14, color: theme.text, fontWeight: "500" },
  cellNumMuted: { color: theme.textMuted, opacity: 0.5 },
  cellNumBlocked: { color: theme.textMuted, opacity: 0.25 },
  cellNumActive: { color: "#fff", fontWeight: "700" },
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
    marginTop: 12,
  },
  footerBtn: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: theme.radiusSm,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
  },
  footerBtnText: { color: theme.text, fontSize: 13, fontWeight: "600" },
});