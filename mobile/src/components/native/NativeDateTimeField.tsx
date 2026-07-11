import { useMemo, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";

/**
 * Native-backed date/time field powered by `@expo/ui`'s community
 * `DateTimePicker` (SwiftUI on iOS, Jetpack Compose on Android). It renders the
 * app-themed pressable trigger field and, on press, surfaces the OS-native
 * picker:
 *   • Android — a native dialog that opens on mount (presentation="dialog") and
 *     is torn down on select/dismiss.
 *   • iOS — the native inline picker hosted inside the app's themed modal with a
 *     Done action (iOS ignores dialog presentation → always inline).
 *
 * If `@expo/ui` is unavailable at runtime (e.g. an older/dev runtime that
 * doesn't bundle the native module) `available` is false and the caller falls
 * back to the pure-JS implementation.
 */

// --- Safe optional import of @expo/ui ---------------------------------------
// The require is wrapped so a missing native module never crashes the bundle;
// the JS fallback pickers take over when `NativeDateTime.available` is false.
type ExpoUiDateTimePickerProps = {
  value: Date;
  onValueChange?: (event: unknown, date: Date) => void;
  onDismiss?: () => void;
  mode?: "date" | "time" | "datetime";
  minimumDate?: Date;
  maximumDate?: Date;
  display?: "default" | "spinner" | "compact" | "inline";
  is24Hour?: boolean;
  accentColor?: string;
  presentation?: "inline" | "dialog";
  themeVariant?: "dark" | "light";
  style?: object;
};

type NativeDateTimeModule = {
  available: boolean;
  DateTimePicker: React.ComponentType<ExpoUiDateTimePickerProps> | null;
};

const NativeDateTime: NativeDateTimeModule = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("@expo/ui/community/datetime-picker");
    const Cmp = mod?.DateTimePicker ?? mod?.default ?? null;
    return { available: !!Cmp, DateTimePicker: Cmp };
  } catch {
    return { available: false, DateTimePicker: null };
  }
})();

export const nativeDateTimeAvailable = NativeDateTime.available;

export interface NativeDateTimeFieldProps {
  /** Picker mode. */
  mode: "date" | "time";
  /** Currently selected value, or null when unset. */
  date: Date | null;
  /** Called with the chosen native Date when the user confirms a selection. */
  onSelect: (date: Date) => void;
  /** Text shown in the trigger field (formatted by the caller). */
  label: string;
  /** Whether `date` is set (drives placeholder styling). */
  hasValue: boolean;
  /** Leading icon element. */
  icon?: React.ReactNode;
  /** Earliest selectable date. */
  minimumDate?: Date;
  /** Latest selectable date. */
  maximumDate?: Date;
  /** Use 24-hour time (Android). */
  is24Hour?: boolean;
  disabled?: boolean;
}

export default function NativeDateTimeField({
  mode,
  date,
  onSelect,
  label,
  hasValue,
  icon,
  minimumDate,
  maximumDate,
  is24Hour,
  disabled,
}: NativeDateTimeFieldProps) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [open, setOpen] = useState(false);
  const Picker = NativeDateTime.DateTimePicker;

  const openPicker = () => {
    if (disabled || !Picker) return;
    setOpen(true);
  };

  // Draft holds the in-progress iOS inline selection so the parent value only
  // commits when the user taps Done.
  const [draft, setDraft] = useState<Date>(date ?? new Date());

  const handleAndroidChange = (_e: unknown, selected: Date) => {
    setOpen(false);
    if (selected) onSelect(selected);
  };

  return (
    <>
      <Pressable
        style={[styles.field, disabled && styles.fieldDisabled]}
        onPress={openPicker}
      >
        {icon}
        <Text style={[styles.fieldText, !hasValue && styles.fieldPlaceholder]}>
          {label}
        </Text>
      </Pressable>

      {open && Picker && Platform.OS === "android" ? (
        // Android: a native dialog that opens on mount; unmount on select/dismiss.
        <Picker
          value={date ?? new Date()}
          mode={mode}
          minimumDate={minimumDate}
          maximumDate={maximumDate}
          is24Hour={is24Hour}
          accentColor={theme.primary}
          presentation="dialog"
          onValueChange={handleAndroidChange}
          onDismiss={() => setOpen(false)}
        />
      ) : null}

      {Picker && Platform.OS !== "android" ? (
        // iOS (and any inline platform): native picker inside a themed modal.
        <Modal
          visible={open}
          transparent
          animationType="fade"
          onRequestClose={() => setOpen(false)}
        >
          <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
            <Pressable
              style={styles.sheet}
              onPress={(e) => e.stopPropagation()}
            >
              <View style={styles.pickerWrap}>
                <Picker
                  value={draft}
                  mode={mode}
                  minimumDate={minimumDate}
                  maximumDate={maximumDate}
                  is24Hour={is24Hour}
                  accentColor={theme.primary}
                  display={mode === "time" ? "spinner" : "inline"}
                  themeVariant="dark"
                  onValueChange={(_e: unknown, selected: Date) =>
                    setDraft(selected)
                  }
                />
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
                    onSelect(draft);
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
    pickerWrap: { alignItems: "center", justifyContent: "center" },
    footer: {
      flexDirection: "row",
      justifyContent: "flex-end",
      gap: 8,
      marginTop: 12,
    },
    footerBtn: {
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: theme.radiusSm,
      backgroundColor: theme.glass,
      borderWidth: 1,
      borderColor: theme.glassBorder,
    },
    footerBtnPrimary: {
      backgroundColor: theme.primary,
      borderColor: theme.primary,
    },
    footerBtnText: { color: theme.text, fontSize: 13, fontWeight: "600" },
    footerBtnTextPrimary: { color: "#fff", fontSize: 13, fontWeight: "700" },
  });
