import { useMemo, useState } from "react";
import { LayoutChangeEvent, StyleSheet, Text, View } from "react-native";
import Svg, { Rect, Line, G, Text as SvgText } from "react-native-svg";
import { BarChart3 } from "lucide-react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";

const WORK_COLOR = "#0ea5e9";
const BREAK_COLOR = "#f59e0b";

/** Daily Work vs Break grouped bar chart (SVG). Mirrors web WorkBreakChart. */
export default function WorkBreakChart({
  labels,
  floorHours,
  breakHours,
}: {
  labels: string[];
  floorHours: number[];
  breakHours: number[];
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [width, setWidth] = useState(0);

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  const height = 200;
  const padL = 30;
  const padB = 28;
  const padT = 10;
  const chartW = Math.max(0, width - padL - 8);
  const chartH = height - padB - padT;
  const maxVal = Math.max(1, ...floorHours, ...breakHours);
  const groups = labels.length;
  const groupW = groups > 0 ? chartW / groups : 0;
  const barW = Math.min(14, groupW / 3);

  const gridLines = 4;

  return (
    <View style={styles.card} onLayout={onLayout}>
      <View style={styles.titleRow}>
        <BarChart3 size={16} color={theme.text} />
        <Text style={styles.title}>Daily Work vs Break Time</Text>
      </View>

      <View style={styles.legend}>
        <View style={styles.legendItem}>
          <View style={[styles.dot, { backgroundColor: WORK_COLOR }]} />
          <Text style={styles.legendText}>Work (hrs)</Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.dot, { backgroundColor: BREAK_COLOR }]} />
          <Text style={styles.legendText}>Break (hrs)</Text>
        </View>
      </View>

      {width > 0 ? (
        <Svg width={width} height={height}>
          {/* grid + y labels */}
          {Array.from({ length: gridLines + 1 }).map((_, i) => {
            const y = padT + (chartH * i) / gridLines;
            const val = (maxVal * (gridLines - i)) / gridLines;
            return (
              <G key={i}>
                <Line
                  x1={padL}
                  y1={y}
                  x2={padL + chartW}
                  y2={y}
                  stroke={theme.border}
                  strokeWidth={1}
                />
                <SvgText
                  x={padL - 6}
                  y={y + 3}
                  fontSize={9}
                  fill={theme.textMuted}
                  textAnchor="end"
                >
                  {val.toFixed(0)}
                </SvgText>
              </G>
            );
          })}

          {/* bars */}
          {labels.map((lbl, i) => {
            const gx = padL + i * groupW + groupW / 2;
            const fH = (floorHours[i] / maxVal) * chartH;
            const bH = (breakHours[i] / maxVal) * chartH;
            return (
              <G key={i}>
                <Rect
                  x={gx - barW - 1}
                  y={padT + chartH - fH}
                  width={barW}
                  height={fH}
                  rx={3}
                  fill={WORK_COLOR}
                />
                <Rect
                  x={gx + 1}
                  y={padT + chartH - bH}
                  width={barW}
                  height={bH}
                  rx={3}
                  fill={BREAK_COLOR}
                />
                <SvgText
                  x={gx}
                  y={height - 10}
                  fontSize={8}
                  fill={theme.textMuted}
                  textAnchor="middle"
                >
                  {lbl.split(",")[0]}
                </SvgText>
              </G>
            );
          })}
        </Svg>
      ) : null}
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
      gap: 8,
    },
    titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    title: { fontSize: 14, fontWeight: "700", color: theme.text },
    legend: { flexDirection: "row", gap: 16 },
    legendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
    dot: { width: 9, height: 9, borderRadius: 2 },
    legendText: { fontSize: 11, color: theme.textSecondary },
  });