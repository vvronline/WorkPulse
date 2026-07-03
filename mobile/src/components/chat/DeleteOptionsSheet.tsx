import { useMemo } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Trash2 } from "../../icons";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";

/**
 * WhatsApp/Telegram/Signal-style delete chooser. Shown when deleting one or
 * more messages. Presents the applicable options as a bottom sheet:
 *   • "Delete for everyone" — only when every target is the user's OWN message
 *     (the server only allows deleting your own messages); removes them for all
 *     participants.
 *   • "Delete for me" — always available; hides the message(s) on this device.
 *   • "Cancel".
 *
 * The buttons ARE the confirmation (no extra confirm dialog), matching the
 * native chat apps.
 */
export default function DeleteOptionsSheet({
  visible,
  count,
  canDeleteForEveryone,
  onDeleteForEveryone,
  onDeleteForMe,
  onClose,
}: {
  visible: boolean;
  count: number;
  canDeleteForEveryone: boolean;
  onDeleteForEveryone: () => void;
  onDeleteForMe: () => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const title =
    count > 1 ? `Delete ${count} messages?` : "Delete message?";

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.header}>
            <Trash2 size={20} color={theme.danger} />
            <Text style={styles.title}>{title}</Text>
          </View>

          {canDeleteForEveryone ? (
            <Pressable style={styles.row} onPress={onDeleteForEveryone}>
              <Text style={[styles.rowText, styles.rowDanger]}>
                Delete for everyone
              </Text>
            </Pressable>
          ) : null}

          <Pressable style={styles.row} onPress={onDeleteForMe}>
            <Text style={[styles.rowText, styles.rowDanger]}>
              Delete for me
            </Text>
          </Pressable>

          <Pressable style={styles.row} onPress={onClose}>
            <Text style={styles.rowText}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
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
    sheet: {
      backgroundColor: theme.bgElevated,
      borderTopLeftRadius: 18,
      borderTopRightRadius: 18,
      paddingTop: 8,
      paddingBottom: 28,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 22,
      paddingVertical: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.glassBorder,
    },
    title: {
      fontSize: 16,
      color: theme.text,
      fontFamily: theme.fontSemiBold,
    },
    row: {
      paddingHorizontal: 22,
      paddingVertical: 16,
    },
    rowText: {
      fontSize: 16,
      color: theme.text,
      fontFamily: theme.fontMedium,
    },
    rowDanger: {
      color: theme.danger,
    },
  });
