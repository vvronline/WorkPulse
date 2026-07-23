import { useMemo } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Fingerprint, ScanFace, ShieldCheck, X } from "../icons";
import type { Theme } from "../theme";
import { useTheme } from "../theme/ThemeProvider";

type Props = {
  visible: boolean;
  /** "in" | "out" — only affects the copy shown in the sheet. */
  mode?: "in" | "out";
  onEnrollFace: () => void;
  onUseFingerprint: () => void;
  onClose: () => void;
};

/**
 * Shown when a verification-required user has NOT enrolled a face yet and taps
 * Clock In / Clock Out. Lets them pick how to verify:
 *
 *   • Enroll Face      → route to Profile → Face Enrollment.
 *   • Use Fingerprint  → verify with the device biometric (the server accepts a
 *                        fingerprint from the office without a face on file).
 *
 * Face enrollment is stored server-side; a fingerprint is a device-only
 * capability, so there is nothing to "enroll" for it — the caller checks the
 * device has a biometric set up before opening the fingerprint flow.
 */
export default function VerifyMethodChooser({
  visible,
  mode = "in",
  onEnrollFace,
  onUseFingerprint,
  onClose,
}: Props) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const verb = mode === "out" ? "clock out" : "clock in";

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <View style={styles.card}>
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <ShieldCheck size={18} color={theme.primary} />
              <Text style={styles.title}>Verification required</Text>
            </View>
            <Pressable onPress={onClose} hitSlop={8}>
              <X size={22} color={theme.textSecondary} />
            </Pressable>
          </View>

          <Text style={styles.subtitle}>
            Your organization requires identity verification to {verb}. You
            haven&apos;t set up face verification yet — choose how you&apos;d
            like to verify.
          </Text>

          <Pressable style={styles.optionBtn} onPress={onEnrollFace}>
            <View style={styles.optionIcon}>
              <ScanFace size={20} color={theme.primary} />
            </View>
            <View style={styles.optionTextWrap}>
              <Text style={styles.optionTitle}>Enroll Face</Text>
              <Text style={styles.optionSub}>
                Set up face verification once, then use it every time.
              </Text>
            </View>
          </Pressable>

          <Pressable style={styles.optionBtn} onPress={onUseFingerprint}>
            <View style={styles.optionIcon}>
              <Fingerprint size={20} color={theme.primary} />
            </View>
            <View style={styles.optionTextWrap}>
              <Text style={styles.optionTitle}>Use Fingerprint</Text>
              <Text style={styles.optionSub}>
                Verify with your device fingerprint / biometric.
              </Text>
            </View>
          </Pressable>

          <Pressable style={styles.cancelBtn} onPress={onClose}>
            <Text style={styles.cancelBtnText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.5)",
      justifyContent: "flex-end",
    },
    card: {
      backgroundColor: theme.bgElevated,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      padding: 20,
      gap: 12,
    },
    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
    },
    headerLeft: { flexDirection: "row", alignItems: "center", gap: 8 },
    title: { fontSize: 18, fontWeight: "700", color: theme.text },
    subtitle: {
      fontSize: 13,
      color: theme.textSecondary,
      lineHeight: 19,
    },
    optionBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      borderRadius: theme.radiusSm,
      padding: 14,
    },
    optionIcon: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: theme.primaryGlow,
      alignItems: "center",
      justifyContent: "center",
    },
    optionTextWrap: { flex: 1, gap: 2 },
    optionTitle: { fontSize: 15, fontWeight: "700", color: theme.text },
    optionSub: { fontSize: 12, color: theme.textSecondary },
    cancelBtn: {
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 12,
      marginTop: 2,
    },
    cancelBtnText: { color: theme.textSecondary, fontSize: 14, fontWeight: "600" },
  });
