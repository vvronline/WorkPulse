import { useMemo } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  Forward,
  Pencil,
  Pin,
  Star,
  Trash2,
} from "lucide-react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import type { ChatMessage, Conversation } from "../../features";

/**
 * Message action sheet (mirrors the web ContextMenu + ForwardModal). The same
 * modal switches to the "Forward to…" picker via `forwardMode` — a single
 * modal avoids the Android dismiss/present race that broke Forward when it was
 * a separate modal.
 */
export default function MessageActionsSheet({
  target,
  forwardMode,
  conversations,
  convId,
  isOwn,
  isStarred,
  onClose,
  onForwardOpen,
  onForwardTo,
  onStar,
  onPin,
  onEdit,
  onDelete,
}: {
  target: ChatMessage | null;
  forwardMode: boolean;
  conversations: Conversation[];
  convId: number;
  isOwn: boolean;
  isStarred: boolean;
  onClose: () => void;
  onForwardOpen: () => void;
  onForwardTo: (targetConvId: number) => void;
  onStar: () => void;
  onPin: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <Modal
      visible={!!target}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.pickerOverlay} onPress={onClose}>
        {forwardMode ? (
          <View style={styles.forwardSheet}>
            <Text style={styles.forwardTitle}>Forward to…</Text>
            <ScrollView style={{ maxHeight: 360 }}>
              {conversations.filter((c) => c.id !== convId).length === 0 ? (
                <Text style={styles.forwardEmpty}>No conversations</Text>
              ) : (
                conversations
                  .filter((c) => c.id !== convId)
                  .map((c) => (
                    <Pressable
                      key={c.id}
                      style={styles.forwardConv}
                      onPress={() => onForwardTo(c.id)}
                    >
                      <Text style={styles.forwardConvName} numberOfLines={1}>
                        {c.is_group
                          ? c.group_name || `Group #${c.id}`
                          : c.other_full_name ||
                            c.other_username ||
                            `Conversation #${c.id}`}
                      </Text>
                    </Pressable>
                  ))
              )}
            </ScrollView>
          </View>
        ) : (
          <View style={styles.actionSheet}>
            {target ? (
              <>
                <Pressable style={styles.actionRow} onPress={onForwardOpen}>
                  <Forward size={18} color={theme.text} />
                  <Text style={styles.actionText}>Forward</Text>
                </Pressable>
                <Pressable style={styles.actionRow} onPress={onStar}>
                  <Star size={18} color={theme.text} />
                  <Text style={styles.actionText}>
                    {isStarred ? "Unsave" : "Save"}
                  </Text>
                </Pressable>
                <Pressable style={styles.actionRow} onPress={onPin}>
                  <Pin size={18} color={theme.text} />
                  <Text style={styles.actionText}>
                    {target.pinned_at ? "Unpin" : "Pin"}
                  </Text>
                </Pressable>
                {isOwn ? (
                  <>
                    <Pressable style={styles.actionRow} onPress={onEdit}>
                      <Pencil size={18} color={theme.text} />
                      <Text style={styles.actionText}>Edit</Text>
                    </Pressable>
                    <Pressable style={styles.actionRow} onPress={onDelete}>
                      <Trash2 size={18} color={theme.danger} />
                      <Text style={[styles.actionText, { color: theme.danger }]}>
                        Delete
                      </Text>
                    </Pressable>
                  </>
                ) : null}
              </>
            ) : null}
          </View>
        )}
      </Pressable>
    </Modal>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    pickerOverlay: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.5)",
      alignItems: "center",
      justifyContent: "center",
    },
    forwardSheet: {
      backgroundColor: theme.bgElevated,
      borderRadius: theme.radius,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      paddingVertical: 8,
      minWidth: 260,
      maxHeight: "70%",
    },
    forwardTitle: {
      fontSize: 15,
      fontWeight: "700",
      color: theme.text,
      paddingHorizontal: 18,
      paddingVertical: 10,
    },
    forwardEmpty: {
      fontSize: 13,
      color: theme.textMuted,
      paddingHorizontal: 18,
      paddingVertical: 12,
    },
    forwardConv: { paddingHorizontal: 18, paddingVertical: 12 },
    forwardConvName: { fontSize: 15, color: theme.text },
    actionSheet: {
      backgroundColor: theme.bgElevated,
      borderRadius: theme.radius,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      paddingVertical: 6,
      minWidth: 200,
    },
    actionRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 18,
      paddingVertical: 12,
    },
    actionText: { fontSize: 15, color: theme.text, fontWeight: "500" },
  });