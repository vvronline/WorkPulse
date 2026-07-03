import { useMemo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import {
  Building2,
  Check,
  ClipboardList,
  House,
  X,
} from "../../icons";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import { formatTime } from "../../utils/time";

export type HistoryDay = {
  date: string;
  floorMinutes?: number;
  breakMinutes?: number;
  work_mode?: string | null;
  workMode?: string | null;
  [k: string]: any;
};

/** Daily Log table with Mode / Work / Break / Total / 8hr Target columns.
 *  Mirrors web pages/analytics/HistoryTable.tsx. */
export default function HistoryTable({ history }: { history: HistoryDay[] }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const sorted = useMemo(
    () => [...history].sort((a, b) => (a.date < b.date ? 1 : -1)),
    [history],
  );

  return (
    <View style={styles.card}>
      <View style={styles.titleRow}>
        <ClipboardList size={16} color={theme.text} />
        <Text style={styles.title}>Daily Log</Text>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View>
          <View style={[styles.row, styles.head]}>
            <Text style={[styles.th, styles.cDate]}>Date</Text>
            <Text style={[styles.th, styles.cMode]}>Mode</Text>
            <Text style={[styles.th, styles.cNum]}>Work</Text>
            <Text style={[styles.th, styles.cNum]}>Break</Text>
            <Text style={[styles.th, styles.cNum]}>Total</Text>
            <Text style={[styles.th, styles.cTarget]}>8hr Target</Text>
          </View>

          {sorted.length === 0 ? (
            <View style={styles.row}>
              <Text style={[styles.td, { width: 360, textAlign: "center", color: theme.textMuted }]}>
                No data for this period
              </Text>
            </View>
          ) : (
            sorted.map((day) => {
              const floor = day.floorMinutes || 0;
              const brk = day.breakMinutes || 0;
              const mode = (day.work_mode || day.workMode) === "remote" ? "remote" : "office";
              const met = floor >= 480;
              return (
                <View key={day.date} style={styles.row}>
                  <Text style={[styles.td, styles.cDate]}>
                    {new Date(day.date.slice(0, 10) + "T00:00:00").toLocaleDateString("en-US", {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                    })}
                  </Text>
                  <View style={[styles.cMode, styles.modeCell]}>
                    {mode === "remote" ? (
                      <House size={12} color={theme.success} />
                    ) : (
                      <Building2 size={12} color="#0ea5e9" />
                    )}
                    <Text
                      style={[
                        styles.modeText,
                        { color: mode === "remote" ? theme.success : "#0ea5e9" },
                      ]}
                    >
                      {mode === "remote" ? "Remote" : "Office"}
                    </Text>
                  </View>
                  <Text style={[styles.td, styles.cNum]}>{formatTime(floor)}</Text>
                  <Text style={[styles.td, styles.cNum]}>{formatTime(brk)}</Text>
                  <Text style={[styles.td, styles.cNum]}>{formatTime(floor + brk)}</Text>
                  <View style={[styles.cTarget, styles.targetCell]}>
                    <View
                      style={[
                        styles.targetBadge,
                        {
                          backgroundColor: met
                            ? "rgba(16,185,129,0.12)"
                            : "rgba(239,68,68,0.12)",
                        },
                      ]}
                    >
                      {met ? (
                        <Check size={11} color="#10b981" />
                      ) : (
                        <X size={11} color="#ef4444" />
                      )}
                      <Text
                        style={[
                          styles.targetText,
                          { color: met ? "#10b981" : "#ef4444" },
                        ]}
                      >
                        {met ? "Met" : "Not Met"}
                      </Text>
                    </View>
                  </View>
                </View>
              );
            })
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    card: {
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radiusLg,
      padding: 14,
      gap: 10,
    },
    titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    title: { fontSize: 14, fontWeight: "700", color: theme.text },
    row: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 9,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    head: { borderBottomColor: theme.glassBorder },
    th: {
      fontSize: 10,
      fontWeight: "700",
      color: theme.textMuted,
      textTransform: "uppercase",
      letterSpacing: 0.3,
    },
    td: { fontSize: 12, color: theme.text },
    cDate: { width: 96 },
    cMode: { width: 84 },
    cNum: { width: 64, textAlign: "right" },
    cTarget: { width: 84, alignItems: "flex-end" },
    modeCell: { flexDirection: "row", alignItems: "center", gap: 4 },
    modeText: { fontSize: 11, fontWeight: "600" },
    targetCell: {},
    targetBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 3,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: theme.radiusFull,
    },
    targetText: { fontSize: 11, fontWeight: "700" },
  });