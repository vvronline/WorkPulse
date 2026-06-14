import { useEffect, useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import WheelColorPicker from "react-native-wheel-color-picker";
import { Check, X } from "lucide-react-native";
import { isValidHex } from "../theme";
import { useTheme } from "../theme/ThemeProvider";

const DEFAULT_PRESETS = [
  "#2383e2",
  "#4daa57",
  "#cb912f",
  "#e03e3e",
  "#9b59b6",
  "#1abc9c",
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#6b7280",
];

function normalizeHex(v: string): string {
  let h = v.trim();
  if (!h.startsWith("#")) h = `#${h}`;
  return h.toLowerCase();
}

interface ColorPickerProps {
  /** Current hex value (e.g. "#2383e2"). */
  value: string;
  /** Called with a valid 6-digit hex whenever the colour changes. */
  onChange: (hex: string) => void;
  /** Optional override of the preset swatch palette. */
  presets?: string[];
  /** Optional label shown above the swatch row. */
  label?: string;
}

/**
 * ColorPicker — preset swatches + hex input + a full RGB colour wheel (opened
 * in a modal). Mirrors the web client's `<input type=color>` capability so any
 * colour can be chosen, while keeping quick presets for common brand hues.
 */
export function ColorPicker({
  value,
  onChange,
  presets = DEFAULT_PRESETS,
  label,
}: ColorPickerProps) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const [wheelOpen, setWheelOpen] = useState(false);
  const [hexText, setHexText] = useState(value);
  // Draft colour while the wheel is open (committed on "Done").
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setHexText(value);
  }, [value]);

  const valid = isValidHex(value);

  function commitHex(text: string) {
    const norm = normalizeHex(text);
    setHexText(norm);
    if (isValidHex(norm)) onChange(norm);
  }

  function openWheel() {
    setDraft(isValidHex(value) ? value : "#2383e2");
    setWheelOpen(true);
  }

  function confirmWheel() {
    if (isValidHex(draft)) onChange(draft);
    setWheelOpen(false);
  }

  return (
    <View style={styles.wrap}>
      {label ? <Text style={styles.label}>{label}</Text> : null}

      <View style={styles.swatchRow}>
        {presets.map((c) => (
          <Pressable
            key={c}
            style={[
              styles.swatch,
              { backgroundColor: c },
              value.toLowerCase() === c.toLowerCase() && styles.swatchActive,
            ]}
            onPress={() => onChange(c)}
          />
        ))}
      </View>

      <View style={styles.hexRow}>
        <Pressable
          style={[
            styles.preview,
            { backgroundColor: valid ? value : theme.surface },
          ]}
          onPress={openWheel}
          accessibilityRole="button"
          accessibilityLabel="Open colour wheel"
        />
        <TextInput
          style={styles.hexInput}
          value={hexText}
          onChangeText={(v) => {
            if (/^#?[0-9a-fA-F]{0,6}$/.test(v)) {
              const norm = v.startsWith("#") ? v : `#${v}`;
              setHexText(norm);
              if (isValidHex(norm)) onChange(norm);
            }
          }}
          onBlur={() => commitHex(hexText)}
          placeholder="#2383e2"
          placeholderTextColor={theme.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={7}
        />
      </View>

      <Modal
        visible={wheelOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setWheelOpen(false)}
      >
        <View style={styles.modalOverlay}>
          <Pressable
            style={styles.modalScrim}
            onPress={() => setWheelOpen(false)}
          />
          <View style={styles.sheet}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Pick a colour</Text>
              <Pressable onPress={() => setWheelOpen(false)} hitSlop={8}>
                <X size={22} color={theme.textSecondary} />
              </Pressable>
            </View>
            <View style={styles.wheelWrap}>
              <WheelColorPicker
                color={draft}
                onColorChangeComplete={(c: string) => setDraft(c)}
                thumbSize={28}
                sliderSize={28}
                noSnap
                row={false}
              />
            </View>
            <View style={styles.draftRow}>
              <View
                style={[styles.draftPreview, { backgroundColor: draft }]}
              />
              <Text style={styles.draftHex}>{draft.toUpperCase()}</Text>
            </View>
            <Pressable style={styles.doneBtn} onPress={confirmWheel}>
              <Check size={16} color="#fff" />
              <Text style={styles.doneBtnText}>Done</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function makeStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    wrap: { gap: 10 },
    label: { fontSize: 12, color: theme.textSecondary, fontWeight: "500" },
    swatchRow: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
    swatch: {
      width: 30,
      height: 30,
      borderRadius: 15,
      borderWidth: 2,
      borderColor: "transparent",
    },
    swatchActive: { borderColor: theme.text },
    hexRow: { flexDirection: "row", alignItems: "center", gap: 10 },
    preview: {
      width: 38,
      height: 38,
      borderRadius: theme.radiusSm,
      borderWidth: 1,
      borderColor: theme.inputBorder,
    },
    hexInput: {
      flex: 1,
      backgroundColor: theme.inputBg,
      borderWidth: 1,
      borderColor: theme.inputBorder,
      borderRadius: theme.radiusSm,
      paddingHorizontal: 14,
      paddingVertical: 10,
      color: theme.text,
      fontSize: 15,
    },
    modalOverlay: { flex: 1, justifyContent: "center", padding: 24 },
    modalScrim: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: "rgba(0,0,0,0.6)",
    },
    sheet: {
      backgroundColor: theme.bgElevated,
      borderRadius: theme.radiusLg,
      padding: 20,
      gap: 16,
    },
    sheetHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    sheetTitle: { fontSize: 16, fontWeight: "700", color: theme.text },
    wheelWrap: { height: 300, justifyContent: "center" },
    draftRow: { flexDirection: "row", alignItems: "center", gap: 12 },
    draftPreview: {
      width: 32,
      height: 32,
      borderRadius: theme.radiusSm,
      borderWidth: 1,
      borderColor: theme.inputBorder,
    },
    draftHex: { fontSize: 15, color: theme.text, fontWeight: "600" },
    doneBtn: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      backgroundColor: theme.primary,
      borderRadius: theme.radiusSm,
      paddingVertical: 13,
    },
    doneBtnText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  });
}