import { useMemo } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { FileText, Image as ImageIcon } from "lucide-react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";

/**
 * "+" composer attach sheet (Signal-style): Photo + File/Document only.
 *
 * Voice messages and Emoji are intentionally NOT in this sheet — they already
 * have first-class controls in the composer itself (the Mic send-button records
 * a voice message; the inline Smile/Keyboard toggle opens the emoji keyboard).
 * Having them here too was a confusing duplicate, so they were removed to match
 * Signal's attach menu.
 */
export default function AttachmentPicker({
  visible,
  onClose,
  onPhoto,
  onDocument,
}: {
  visible: boolean;
  onClose: () => void;
  onPhoto: () => void;
  onDocument: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.plusOverlay} onPress={onClose}>
        <View style={styles.plusSheet}>
          <Pressable style={styles.plusRow} onPress={onPhoto}>
            <ImageIcon size={20} color={theme.text} />
            <Text style={styles.plusText}>Photo</Text>
          </Pressable>
          <Pressable style={styles.plusRow} onPress={onDocument}>
            <FileText size={20} color={theme.text} />
            <Text style={styles.plusText}>File / Document</Text>
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    plusOverlay: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.5)",
      justifyContent: "flex-end",
    },
    plusSheet: {
      backgroundColor: theme.bgElevated,
      borderTopLeftRadius: 18,
      borderTopRightRadius: 18,
      paddingVertical: 8,
      paddingBottom: 28,
    },
    plusRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      paddingHorizontal: 22,
      paddingVertical: 14,
    },
    plusText: { fontSize: 16, color: theme.text, fontFamily: theme.fontMedium },
  });