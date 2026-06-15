import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Building2, House } from "lucide-react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import { formatTime } from "../../utils/time";

export type AnalyticsDay = {
  floorMinutes: number;
  breakMinutes: number;
  workMode?: string;
  [k: string]: any;
};

/** Six summary cards — mirrors web pages/analytics/SummaryStats.tsx. */
export default function SummaryStats({ data }: { data: AnalyticsDay[] }) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const totalFloor = data.reduce((s, d) => s + (d.floorMinutes || 0), 0);
  const totalBreak = data.reduce((s, d) => s + (d.breakMinutes || 0), 0);
  const workingDays = data.filter((d) => (d.floorMinutes || 0) > 0).length;
  const avgFloor = workingDays > 0 ? Math.round(totalFloor / workingDays) : 0;
  const daysMetTarget = data.filter((d) => (d.floorMinutes || 0) >= 480).length;
  const officeDays = data.filter(
    (d) => (d.floorMinutes || 0) > 0 && d.workMode !== "remote",
  ).length;
  const remoteDays = data.filter(
    (d) => (d.floorMinutes || 0) > 0 && d.workMode === "remote",
  ).length;

  return (
    <View style={styles.grid}>
      <Card label="Total Work Time" value={formatTime(totalFloor)} color={theme.primary} />
      <Card label="Total Break Time" value={formatTime(totalBreak)} color={theme.warning} />
      <Card label="Avg Work / Day" value={formatTime(avgFloor)} color={theme.primary} />
      <Card
        label="Days Met 8hr Target"
        value={`${daysMetTarget} / ${workingDays}`}
        color={theme.text}
      />
      <Card
        label="Office Days"
        value={String(officeDays)}
        color="#0ea5e9"
        icon={<Building2 size={15} color="#0ea5e9" />}
      />
      <Card
        label="Remote Days"
        value={String(remoteDays)}
        color={theme.success}
        icon={<House size={15} color={theme.success} />}
      />
    </View>
  );
}

function Card({
  label,
  value,
  color,
  icon,
}: {
  label: string;
  value: string;
  color: string;
  icon?: React.ReactNode;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <View style={styles.card}>
      <Text style={styles.cardLabel}>{label}</Text>
      <View style={styles.valueRow}>
        {icon}
        <Text style={[styles.cardValue, { color }]}>{value}</Text>
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
      paddingHorizontal: 12,
      gap: 6,
    },
    cardLabel: {
      fontSize: 10,
      color: theme.textMuted,
      textTransform: "uppercase",
      letterSpacing: 0.3,
    },
    valueRow: { flexDirection: "row", alignItems: "center", gap: 6 },
    cardValue: { fontSize: 17, fontWeight: "800" },
  });