import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle, G } from "react-native-svg";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";

export type Slice = { label: string; value: number; color: string };

/**
 * Reusable SVG doughnut chart with a legend. Used for the Time Distribution
 * (Work/Break) and Office vs Remote charts. Mirrors web DistributionCharts.
 */
export default function DoughnutChart({
  title,
  icon,
  slices,
  formatValue,
  size = 150,
}: {
  title: string;
  icon?: React.ReactNode;
  slices: Slice[];
  formatValue?: (v: number) => string;
  size?: number;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const total = slices.reduce((s, x) => s + x.value, 0);
  const stroke = 22;
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;

  let offsetAcc = 0;
  const segments = slices.map((sl) => {
    const frac = total > 0 ? sl.value / total : 0;
    const dash = frac * circumference;
    const seg = {
      color: sl.color,
      dashArray: `${dash} ${circumference - dash}`,
      dashOffset: -offsetAcc,
    };
    offsetAcc += dash;
    return seg;
  });

  return (
    <View style={styles.card}>
      <View style={styles.titleRow}>
        {icon}
        <Text style={styles.title}>{title}</Text>
      </View>

      <View style={styles.body}>
        <Svg width={size} height={size}>
          <G rotation={-90} origin={`${cx}, ${cy}`}>
            {/* track */}
            <Circle
              cx={cx}
              cy={cy}
              r={r}
              stroke={theme.surfaceHover}
              strokeWidth={stroke}
              fill="none"
            />
            {total > 0
              ? segments.map((seg, i) => (
                  <Circle
                    key={i}
                    cx={cx}
                    cy={cy}
                    r={r}
                    stroke={seg.color}
                    strokeWidth={stroke}
                    fill="none"
                    strokeDasharray={seg.dashArray}
                    strokeDashoffset={seg.dashOffset}
                  />
                ))
              : null}
          </G>
        </Svg>

        <View style={styles.legend}>
          {slices.map((sl, i) => (
            <View key={i} style={styles.legendItem}>
              <View style={[styles.dot, { backgroundColor: sl.color }]} />
              <Text style={styles.legendLabel}>{sl.label}</Text>
              <Text style={styles.legendValue}>
                {formatValue ? formatValue(sl.value) : String(sl.value)}
              </Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    card: {
      flexGrow: 1,
      flexBasis: "45%",
      minWidth: 150,
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radiusLg,
      padding: 14,
      gap: 10,
    },
    titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    title: { fontSize: 14, fontWeight: "700", color: theme.text },
    body: { alignItems: "center", gap: 10 },
    legend: { width: "100%", gap: 6 },
    legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
    dot: { width: 10, height: 10, borderRadius: 5 },
    legendLabel: { flex: 1, fontSize: 12, color: theme.textSecondary },
    legendValue: { fontSize: 12, fontWeight: "700", color: theme.text },
  });