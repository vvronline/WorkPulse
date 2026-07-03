import { useMemo } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Camera, FileText, Image as ImageIcon } from "../../icons";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import RecentMediaStrip, { type RecentMediaItem } from "./RecentMediaStrip";

/**
 * "+" composer attach sheet (Signal-style AttachmentKeyboard): a horizontal
 * RECENT-MEDIA strip across the top (tap a recent photo/video to send), then
 * Camera + Photo + File/Document rows.
 *
 * The recent-media strip mirrors Signal-Android's AttachmentKeyboard, which
 * surfaces the device's most-recent gallery items inline so the common
 * "share the photo I just took" flow is one tap. A leading "Gallery" tile and
 * the Photo row both open the full system picker.
 *
 * Voice messages and Emoji are intentionally NOT in this sheet — they already
 * have first-class controls in the composer itself (the Mic send-button records
 * a voice message; the inline Smile/Keyboard toggle opens the emoji keyboard).
 */
export default function AttachmentPicker({
  visible,
  onClose,
  onPhoto,
  onDocument,
  onPickRecent,
  onOpenCamera,
}: {
  visible: boolean;
  onClose: () => void;
  onPhoto: () => void;
  onDocument: () => void;
  // A recent-gallery thumbnail tapped in the strip. Optional so older callers
  // still type-check; when omitted the strip is hidden.
  onPickRecent?: (item: RecentMediaItem) => void;
  // Open the Signal-style in-app camera. Optional for the same reason.
  onOpenCamera?: () => void;
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
        {/* Stop propagation so taps inside the sheet don't close it. */}
        <Pressable style={styles.plusSheet} onPress={() => {}}>
          {/* Signal-style recent-media strip (only when a handler is wired). */}
          {onPickRecent ? (
            <View style={styles.stripWrap}>
              <RecentMediaStrip
                height={92}
                active={visible}
                onPick={onPickRecent}
                onOpenGallery={onPhoto}
              />
            </View>
          ) : null}

          {onOpenCamera ? (
            <Pressable style={styles.plusRow} onPress={onOpenCamera}>
              <Camera size={20} color={theme.text} />
              <Text style={styles.plusText}>Camera</Text>
            </Pressable>
          ) : null}
          <Pressable style={styles.plusRow} onPress={onPhoto}>
            <ImageIcon size={20} color={theme.text} />
            <Text style={styles.plusText}>Photo</Text>
          </Pressable>
          <Pressable style={styles.plusRow} onPress={onDocument}>
            <FileText size={20} color={theme.text} />
            <Text style={styles.plusText}>File / Document</Text>
          </Pressable>
        </Pressable>
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
    // Padding around the recent-media strip + a divider under it.
    stripWrap: {
      paddingTop: 12,
      paddingBottom: 10,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
      marginBottom: 6,
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
