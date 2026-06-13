import { useMemo } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { X } from "lucide-react-native";
import type { Theme } from "../theme";
import { useTheme } from "../theme/ThemeProvider";

interface ConfirmDialogProps {
  visible: boolean;
  title?: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm?: () => void;
  onCancel?: () => void;
  isDanger?: boolean;
  // When true, only a single confirm button is shown (informational/alert mode).
  // Mirrors a simple OS alert but in the app's dark theme.
  alertMode?: boolean;
}

/**
 * Themed confirmation / alert dialog — mirrors the web
 * `client/src/components/common/ConfirmDialog.tsx`. Replaces the OS-native
 * `Alert.alert` so dialogs match the app's dark Notion theme.
 *
 * - Two-button confirm (default): Cancel + Confirm (danger = red).
 * - `alertMode`: single confirm button for info/error messages.
 */
export default function ConfirmDialog({
  visible,
  title,
  message,
  confirmText = "Confirm",
  cancelText = "Cancel",
  onConfirm,
  onCancel,
  isDanger = true,
  alertMode = false,
}: ConfirmDialogProps) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <Pressable style={styles.overlay} onPress={onCancel}>
        <Pressable style={styles.card} onPress={() => {}}>
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            <Pressable onPress={onCancel} hitSlop={8}>
              <X size={18} color={theme.textSecondary} />
            </Pressable>
          </View>
          {message ? <Text style={styles.message}>{message}</Text> : null}
          <View style={styles.footer}>
            {alertMode ? null : (
              <Pressable style={styles.cancelBtn} onPress={onCancel}>
                <Text style={styles.cancelText}>{cancelText}</Text>
              </Pressable>
            )}
            <Pressable
              style={[
                styles.confirmBtn,
                isDanger ? styles.danger : styles.primary,
              ]}
              onPress={onConfirm ?? onCancel}
            >
              <Text style={styles.confirmText}>{confirmText}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: theme.bgElevated,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    padding: 20,
    gap: 12,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  title: { fontSize: 17, fontWeight: "700", color: theme.text, flex: 1 },
  message: {
    fontSize: 14,
    color: theme.textSecondary,
    lineHeight: 20,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 10,
    marginTop: 4,
  },
  cancelBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: theme.radiusSm,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.glassBorder,
  },
  cancelText: { color: theme.text, fontSize: 14, fontWeight: "600" },
  confirmBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: theme.radiusSm,
  },
  primary: { backgroundColor: theme.primary },
  danger: { backgroundColor: theme.danger },
  confirmText: { color: "#fff", fontSize: 14, fontWeight: "600" },
});