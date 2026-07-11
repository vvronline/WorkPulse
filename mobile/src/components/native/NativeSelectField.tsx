import { useMemo, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { ChevronDown } from "../../icons";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";

/**
 * Native-backed single-select field powered by `@expo/ui`'s community `Picker`
 * (SwiftUI wheel on iOS, Material 3 exposed dropdown on Android). It renders the
 * app-themed pressable trigger field and, on press, opens a themed modal that
 * hosts the native picker with Cancel / Done actions (Done commits a draft
 * selection).
 *
 * When `@expo/ui` is unavailable at runtime, `nativeSelectAvailable` is false
 * and callers fall back to the pure-JS Dropdown implementation.
 */

export type SelectValue = string | number | null;

// --- Safe optional import of @expo/ui Picker --------------------------------
type ExpoUiPickerProps = {
  selectedValue?: SelectValue;
  onValueChange?: (value: SelectValue, index: number) => void;
  enabled?: boolean;
  style?: object;
  children?: React.ReactNode;
};
type ExpoUiPickerComponent = React.ComponentType<ExpoUiPickerProps> & {
  Item: React.ComponentType<{
    label?: string;
    value?: SelectValue;
    color?: string;
  }>;
};

type NativeSelectModule = {
  available: boolean;
  Picker: ExpoUiPickerComponent | null;
};

const NativeSelect: NativeSelectModule = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("@expo/ui/community/picker");
    const Cmp = (mod?.Picker ?? mod?.default ?? null) as
      | ExpoUiPickerComponent
      | null;
    return { available: !!(Cmp && Cmp.Item), Picker: Cmp };
  } catch {
    return { available: false, Picker: null };
  }
})();

export const nativeSelectAvailable = NativeSelect.available;

export type NativeSelectOption = {
  value: SelectValue;
  label: string;
  color?: string;
};

export interface NativeSelectFieldProps {
  label?: string;
  value: SelectValue;
  options: NativeSelectOption[];
  onChange: (value: SelectValue) => void;
  placeholder?: string;
  disabled?: boolean;
}

export default function NativeSelectField({
  label,
  value,
  options,
  onChange,
  placeholder = "Select…",
  disabled,
}: NativeSelectFieldProps) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [open, setOpen] = useState(false);
  const Picker = NativeSelect.Picker;

  const selected = useMemo(
    () => options.find((o) => String(o.value) === String(value)),
    [options, value],
  );

  // Draft holds the in-progress selection so the parent value only commits on Done.
  const [draft, setDraft] = useState<SelectValue>(value);

  const openPicker = () => {
    if (disabled || !Picker) return;
    setDraft(value);
    setOpen(true);
  };

  return (
    <>
      <Pressable
        style={[styles.field, disabled && styles.fieldDisabled]}
        onPress={openPicker}
      >
        <View style={styles.fieldInner}>
          {selected?.color ? (
            <View style={[styles.dot, { backgroundColor: selected.color }]} />
          ) : null}
          <Text
            style={[styles.fieldText, !selected && styles.fieldPlaceholder]}
            numberOfLines={1}
          >
            {selected ? selected.label : placeholder}
          </Text>
        </View>
        <ChevronDown size={18} color={theme.textSecondary} />
      </Pressable>

      {Picker ? (
        <Modal
          visible={open}
          transparent
          animationType="slide"
          onRequestClose={() => setOpen(false)}
        >
          <Pressable style={styles.overlay} onPress={() => setOpen(false)}>
            <Pressable
              style={styles.sheet}
              onPress={(e) => e.stopPropagation()}
            >
              <Text style={styles.sheetTitle}>{label || "Select"}</Text>
              <View style={styles.pickerWrap}>
                <Picker
                  selectedValue={draft}
                  onValueChange={(v) => setDraft(v)}
                >
                  {options.map((o) => (
                    <Picker.Item
                      key={String(o.value)}
                      label={o.label}
                      value={o.value}
                      color={theme.text}
                    />
                  ))}
                </Picker>
              </View>
              <View style={styles.footer}>
                <Pressable
                  style={styles.footerBtn}
                  onPress={() => setOpen(false)}
                >
                  <Text style={styles.footerBtnText}>Cancel</Text>
                </Pressable>
                <Pressable
                  style={[styles.footerBtn, styles.footerBtnPrimary]}
                  onPress={() => {
                    onChange(draft);
                    setOpen(false);
                  }}
                >
                  <Text style={styles.footerBtnTextPrimary}>Done</Text>
                </Pressable>
              </View>
            </Pressable>
          </Pressable>
        </Modal>
      ) : null}
    </>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    field: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      backgroundColor: theme.inputBg,
      borderWidth: 1,
      borderColor: theme.inputBorder,
      borderRadius: theme.radiusSm,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    fieldDisabled: { opacity: 0.5 },
    fieldInner: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1 },
    fieldText: { color: theme.text, fontSize: 15, flex: 1 },
    fieldPlaceholder: { color: theme.textMuted },
    dot: { width: 10, height: 10, borderRadius: 5 },
    overlay: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.6)",
      justifyContent: "flex-end",
    },
    sheet: {
      backgroundColor: theme.bgElevated,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      padding: 20,
    },
    sheetTitle: {
      fontSize: 18,
      fontWeight: "700",
      color: theme.text,
      marginBottom: 8,
    },
    pickerWrap: { alignItems: "stretch", justifyContent: "center" },
    footer: {
      flexDirection: "row",
      justifyContent: "flex-end",
      gap: 8,
      marginTop: 14,
    },
    footerBtn: {
      paddingHorizontal: 16,
      paddingVertical: 11,
      borderRadius: theme.radiusSm,
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
    },
    footerBtnPrimary: {
      backgroundColor: theme.primary,
      borderColor: theme.primary,
    },
    footerBtnText: { color: theme.text, fontSize: 14, fontWeight: "600" },
    footerBtnTextPrimary: { color: "#fff", fontSize: 14, fontWeight: "700" },
  });