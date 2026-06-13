import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Theme } from "../theme";
import { useTheme } from "../theme/ThemeProvider";
import { getAgileConfig } from "../features";

type PointValue = number | string | null;

// Fibonacci fallback mirrors the web AgileConfigContext FALLBACK_CONFIG so the
// picker still works before/without a server config response.
const FALLBACK_SCALE: (number | string)[] = [
  0.5, 1, 2, 3, 5, 8, 13, 21, 34,
];

/**
 * Normalise the estimation_values field, which the server may return as a real
 * array, a JSON-encoded string, or a comma-separated string.
 */
function parseScale(
  values: (number | string)[] | string | null | undefined,
): (number | string)[] {
  if (Array.isArray(values)) return values;
  if (typeof values === "string" && values.trim()) {
    try {
      const parsed = JSON.parse(values);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return values
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean)
        .map((v) => (isNaN(Number(v)) ? v : Number(v)));
    }
  }
  return [];
}

interface StoryPointPickerProps {
  value?: PointValue;
  onChange: (value: PointValue) => void;
  disabled?: boolean;
  /**
   * Optional pre-loaded scale + unit. When omitted the picker fetches the
   * tenant Agile config itself. Pass these in to avoid a duplicate request
   * when the parent already has the config.
   */
  scale?: (number | string)[];
  unitLabel?: string;
  /** When false (story points feature disabled) the picker renders nothing. */
  enabled?: boolean;
}

export default function StoryPointPicker({
  value,
  onChange,
  disabled,
  scale: scaleProp,
  unitLabel: unitProp,
  enabled,
}: StoryPointPickerProps) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [scale, setScale] = useState<(number | string)[]>(
    scaleProp && scaleProp.length ? scaleProp : FALLBACK_SCALE,
  );
  const [unitLabel, setUnitLabel] = useState<string>(unitProp || "SP");
  const [storyPointsEnabled, setStoryPointsEnabled] = useState<boolean>(
    enabled !== false,
  );

  useEffect(() => {
    // If the parent supplied a scale, trust it and skip the fetch.
    if (scaleProp && scaleProp.length) {
      setScale(scaleProp);
      if (unitProp) setUnitLabel(unitProp);
      return;
    }
    let cancelled = false;
    getAgileConfig()
      .then((r) => {
        if (cancelled) return;
        const s = r.data?.settings;
        const parsed = parseScale(s?.estimation_values);
        if (parsed.length) setScale(parsed);
        if (s?.estimation_unit_label) setUnitLabel(s.estimation_unit_label);
        if (s?.enable_story_points === false) setStoryPointsEnabled(false);
      })
      .catch(() => {
        /* keep fallback scale */
      });
    return () => {
      cancelled = true;
    };
  }, [scaleProp, unitProp]);

  if (enabled === false || !storyPointsEnabled) return null;

  const isSel = (v: PointValue) => String(value ?? "") === String(v ?? "");

  const handlePress = (v: PointValue) => {
    if (disabled) return;
    // Toggle off if the user taps the currently selected chip.
    onChange(isSel(v) ? null : v);
  };

  return (
    <View style={styles.wrap}>
      <Pressable
        style={[styles.chip, value == null && styles.chipActive]}
        onPress={() => handlePress(null)}
        disabled={disabled}
      >
        <Text style={[styles.chipText, value == null && styles.chipTextActive]}>
          ?
        </Text>
      </Pressable>
      {scale.map((v) => {
        const active = isSel(v);
        return (
          <Pressable
            key={String(v)}
            style={[styles.chip, active && styles.chipActive]}
            onPress={() => handlePress(v)}
            disabled={disabled}
          >
            <Text style={[styles.chipText, active && styles.chipTextActive]}>
              {String(v)}
            </Text>
          </Pressable>
        );
      })}
      <Text style={styles.unit}>{unitLabel}</Text>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
  wrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
  },
  chip: {
    minWidth: 40,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: theme.radiusFull,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    backgroundColor: theme.glass,
    alignItems: "center",
    justifyContent: "center",
  },
  chipActive: {
    backgroundColor: theme.primary,
    borderColor: theme.primary,
  },
  chipText: { fontSize: 13, fontWeight: "600", color: theme.textSecondary },
  chipTextActive: { color: "#fff" },
  unit: { fontSize: 12, color: theme.textMuted, marginLeft: 2 },
});