import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { BarChart3, Calendar, Palmtree, Target, Building2 } from "lucide-react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";

export type WidgetsData = {
  avgFloorMinutes?: number;
  punctualityPercent?: number;
  attendancePercent?: number;
  targetMetDays?: number;
  workDays?: number;
  leaveCount?: number;
  officeDays?: number;
  remoteDays?: number;
  [k: string]: unknown;
};

function formatTime(totalMinutes: number): string {
  const hrs = Math.floor(Math.abs(totalMinutes) / 60);
  const mins = Math.abs(totalMinutes) % 60;
  return `${String(hrs).padStart(2, "0")}h ${String(mins).padStart(2, "0")}m`;
}

/** Dashboard widgets grid — mirrors web components/dashboard/WidgetsGrid.tsx. */
export default function WidgetsGrid({ widgets }: { widgets?: WidgetsData | null }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  if (!widgets) return null;

  const punct = Number(widgets.punctualityPercent ?? 0);
  const attend = Number(widgets.attendancePercent ?? 0);
  const punctColor = punct >= 80 ? theme.success : theme.warning;
  const attendColor =
    attend >= 90 ? theme.success : attend >= 75 ? theme.warning : theme.danger;

  return (
    <View style={styles.grid}>
      <View style={styles.card}>
        <View style={[styles.iconBg, { backgroundColor: theme.primaryGlow }]}>
          <BarChart3 size={18} color={theme.primary} />
        </View>
        <Text style={styles.value}>{formatTime(Number(widgets.avgFloorMinutes ?? 0))}</Text>
        <Text style={styles.label}>Avg Work Time</Text>
      </View>

      <View style={styles.card}>
        <View style={[styles.iconBg, { backgroundColor: "rgba(245,158,11,0.14)" }]}>
          <Text style={{ fontSize: 16 }}>⏰</Text>
        </View>
        <Text style={[styles.value, { color: punctColor }]}>{punct}%</Text>
        <Text style={styles.label}>Punctuality</Text>
      </View>

      <View style={styles.card}>
        <View style={[styles.iconBg, { backgroundColor: "rgba(34,197,94,0.14)" }]}>
          <Calendar size={18} color={theme.success} />
        </View>
        <Text style={[styles.value, { color: attendColor }]}>{attend}%</Text>
        <Text style={styles.label}>Attendance</Text>
      </View>

      <View style={styles.card}>
        <View style={[styles.iconBg, { backgroundColor: "rgba(14,165,233,0.14)" }]}>
          <Target size={18} color="#0ea5e9" />
        </View>
        <Text style={styles.value}>
          {Number(widgets.targetMetDays ?? 0)}/{Number(widgets.workDays ?? 0)}
        </Text>
        <Text style={styles.label}>8hr Target Met</Text>
      </View>

      <View style={styles.card}>
        <View style={[styles.iconBg, { backgroundColor: "rgba(168,85,247,0.14)" }]}>
          <Palmtree size={18} color="#a855f7" />
        </View>
        <Text style={[styles.value, { color: theme.warning }]}>
          {Number(widgets.leaveCount ?? 0)}
        </Text>
        <Text style={styles.label}>Leaves (Month)</Text>
      </View>

      <View style={styles.card}>
        <View style={[styles.iconBg, { backgroundColor: theme.primaryGlow }]}>
          <Building2 size={18} color={theme.primary} />
        </View>
        <View style={styles.modeSplit}>
          <Text style={[styles.modeNum, { color: "#0ea5e9" }]}>
            {Number(widgets.officeDays ?? 0)}
          </Text>
          <Text style={styles.modeDivider}>/</Text>
          <Text style={[styles.modeNum, { color: theme.success }]}>
            {Number(widgets.remoteDays ?? 0)}
          </Text>
        </View>
        <Text style={styles.label}>Office / Remote</Text>
      </View>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    grid: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginVertical: 8 },
    card: {
      flexGrow: 1,
      flexBasis: "30%",
      minWidth: 100,
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radius,
      paddingVertical: 14,
      paddingHorizontal: 10,
      alignItems: "center",
      gap: 6,
    },
    iconBg: {
      width: 36,
      height: 36,
      borderRadius: 10,
      alignItems: "center",
      justifyContent: "center",
    },
    value: { fontSize: 17, fontWeight: "800", color: theme.text },
    label: {
      fontSize: 10,
      color: theme.textMuted,
      textTransform: "uppercase",
      letterSpacing: 0.3,
      textAlign: "center",
    },
    modeSplit: { flexDirection: "row", alignItems: "center", gap: 4 },
    modeNum: { fontSize: 17, fontWeight: "800" },
    modeDivider: { fontSize: 15, color: theme.textMuted },
  });