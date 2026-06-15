import { useMemo, useState } from "react";
import { LayoutChangeEvent, StyleSheet, Text, View } from "react-native";
import Svg, { Polyline, Line, Circle, G, Text as SvgText } from "react-native-svg";
import { TrendingUp } from "lucide-react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";

/** Work Time Trend line chart (SVG). Mirrors web TrendChart. */
export default function TrendChart({
  labels,
  floorHours,
}: {
  labels: string[];
  floorHours: number[];
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
  const maxVal = Math.max(1, ...floorHours);
  const n = floorHours.length;
  const stepX = n > 1 ? chartW / (n - 1) : 0;
  const gridLines = 4;

  const points = floorHours
    .map((v, i) => {
      const x = padL + i * stepX;
      const y = padT + chartH - (v / maxVal) * chartH;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <View style={styles.card} onLayout={onLayout}>
      <View style={styles.titleRow}>
        <TrendingUp size={16} color={theme.text} />
        <Text style={styles.title}>Work Time Trend</Text>
      </View>

      {width > 0 ? (
        <Svg width={width} height={height}>
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

          {n > 1 ? (
            <Polyline
              points={points}
              fill="none"
              stroke={theme.primary}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ) : null}

          {floorHours.map((v, i) => {
            const x = padL + i * stepX;
            const y = padT + chartH - (v / maxVal) * chartH;
            return (
              <G key={i}>
                <Circle cx={x} cy={y} r={3} fill={theme.primary} />
                {i % Math.ceil(n / 7 || 1) === 0 ? (
                  <SvgText
                    x={x}
                    y={height - 10}
                    fontSize={8}
                    fill={theme.textMuted}
                    textAnchor="middle"
                  >
                    {(labels[i] || "").split(",")[0]}
                  </SvgText>
                ) : null}
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
  });