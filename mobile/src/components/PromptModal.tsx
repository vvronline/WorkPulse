import { useEffect, useMemo, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { Theme } from "../theme";
import { useTheme } from "../theme/ThemeProvider";

export type PromptField = {
  key: string;
  label: string;
  placeholder?: string;
  secure?: boolean;
  required?: boolean;
  multiline?: boolean;
  initialValue?: string;
};

type Props = {
  visible: boolean;
  title: string;
  message?: string;
  fields: PromptField[];
  confirmLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onSubmit: (values: Record<string, string>) => void;
};

/**
 * Cross-platform replacement for the iOS-only `Alert.prompt`. Renders a
 * bottom-sheet modal with one or more text inputs (supports secure entry
 * for password re-auth flows) and Confirm / Cancel actions.
 */
export function PromptModal({
  visible,
  title,
  message,
  fields,
  confirmLabel = "Confirm",
  destructive,
  busy,
  error,
  onCancel,
  onSubmit,
}: Props) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const [values, setValues] = useState<Record<string, string>>({});

  // Reset values each time the modal opens.
  useEffect(() => {
    if (visible) {
      const init: Record<string, string> = {};
      for (const f of fields) init[f.key] = f.initialValue ?? "";
      setValues(init);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const missingRequired = fields.some(
    (f) => f.required && !(values[f.key] || "").trim(),
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onCancel}
    >
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable style={styles.scrim} onPress={busy ? undefined : onCancel} />
        <View style={styles.sheet}>
          <Text style={styles.title}>{title}</Text>
          {message ? <Text style={styles.message}>{message}</Text> : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {fields.map((f) => (
            <View key={f.key} style={styles.fieldWrap}>
              <Text style={styles.fieldLabel}>
                {f.label}
                {f.required ? " *" : ""}
              </Text>
              <TextInput
                style={[styles.input, f.multiline && styles.inputMultiline]}
                value={values[f.key] ?? ""}
                onChangeText={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
                placeholder={f.placeholder}
                placeholderTextColor={theme.textMuted}
                secureTextEntry={f.secure}
                autoCapitalize="none"
                autoCorrect={false}
                multiline={f.multiline}
              />
            </View>
          ))}
          <View style={styles.btnRow}>
            <Pressable
              style={[styles.btn, styles.cancelBtn]}
              onPress={onCancel}
              disabled={busy}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[
                styles.btn,
                destructive ? styles.destructiveBtn : styles.confirmBtn,
                (busy || missingRequired) && styles.btnDisabled,
              ]}
              onPress={() => onSubmit(values)}
              disabled={busy || missingRequired}
            >
              <Text style={styles.confirmText}>
                {busy ? "Working…" : confirmLabel}
              </Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
  overlay: { flex: 1, justifyContent: "flex-end" },
  scrim: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  sheet: {
    backgroundColor: theme.bgElevated,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    paddingBottom: 28,
    gap: 10,
  },
  title: { fontSize: 18, fontWeight: "700", color: theme.text },
  message: { fontSize: 13, color: theme.textSecondary, lineHeight: 18 },
  error: { fontSize: 13, color: theme.danger },
  fieldWrap: { gap: 6 },
  fieldLabel: { fontSize: 12, color: theme.textSecondary, fontWeight: "500" },
  input: {
    backgroundColor: theme.inputBg,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    borderRadius: theme.radiusSm,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: theme.text,
    fontSize: 15,
  },
  inputMultiline: { minHeight: 72, textAlignVertical: "top" },
  btnRow: { flexDirection: "row", gap: 10, marginTop: 8 },
  btn: {
    flex: 1,
    borderRadius: theme.radiusSm,
    paddingVertical: 13,
    alignItems: "center",
  },
  cancelBtn: {
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
  },
  confirmBtn: { backgroundColor: theme.primary },
  destructiveBtn: { backgroundColor: theme.danger },
  btnDisabled: { opacity: 0.5 },
  cancelText: { color: theme.textSecondary, fontSize: 15, fontWeight: "600" },
  confirmText: { color: "#fff", fontSize: 15, fontWeight: "600" },
});