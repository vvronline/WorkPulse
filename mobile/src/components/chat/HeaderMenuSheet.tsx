import { useMemo } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  FileText,
  FolderOpen,
  Pin,
  Search,
  Star,
  Trash2,
  X as XIcon,
} from "../../icons";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import { uploadUrl } from "../../config";
import type {
  MessageSearchResult,
  PinnedMessage,
  SharedFile,
  StarredMessage,
} from "../../features";
import { fmtDateTime, fmtSize, type HeaderSheet } from "./chatUtils";
import NativeBottomSheet from "../native/NativeBottomSheet";

/**
 * Header 3-dot menu (mirrors the web ChatHeader overflow menu) — one sheet
 * whose content switches between the menu rows and each panel (search /
 * pinned / files / saved). A single sheet avoids the Android dismiss/present
 * race when switching between panels.
 *
 * Presented via the shared `NativeBottomSheet` (native `@expo/ui` sheet with a
 * JS `Modal` fallback). A fixed `85%` snap point gives the scrollable panels
 * room.
 */
export default function HeaderMenuSheet({
  sheet,
  name,
  convId,
  loading,
  searchQ,
  searchResults,
  pinnedMsgs,
  sharedFiles,
  savedMsgs,
  onClose,
  onOpenPanel,
  onSearchChange,
  onJump,
  onUnpin,
  onUnstar,
  onClearChat,
}: {
  sheet: HeaderSheet;
  name?: string;
  convId: number;
  loading: boolean;
  searchQ: string;
  searchResults: MessageSearchResult[];
  pinnedMsgs: PinnedMessage[];
  sharedFiles: SharedFile[];
  savedMsgs: StarredMessage[];
  onClose: () => void;
  onOpenPanel: (panel: HeaderSheet) => void;
  onSearchChange: (v: string) => void;
  onJump: (id: number) => void;
  onUnpin: (id: number) => void;
  onUnstar: (id: number) => void;
  onClearChat: () => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const title =
    sheet === "search"
      ? "Search messages"
      : sheet === "pinned"
        ? "Pinned messages"
        : sheet === "files"
          ? "Shared files"
          : sheet === "saved"
            ? "Saved messages"
            : name || "Chat";

  // The menu list is content-sized; the scrollable panels need a taller sheet.
  const isPanel = sheet !== "menu" && !!sheet;

  return (
    <NativeBottomSheet
      visible={!!sheet}
      onClose={onClose}
      snapPoints={isPanel ? ["85%"] : undefined}
    >
      <View style={styles.hmSheet}>
        <View style={styles.allHeader}>
          <Text style={styles.allTitle}>{title}</Text>
          <Pressable onPress={onClose} hitSlop={8}>
            <XIcon size={22} color={theme.textSecondary} />
          </Pressable>
        </View>

        {sheet === "menu" ? (
          <>
            <Pressable
              style={styles.plusRow}
              onPress={() => onOpenPanel("search")}
            >
              <Search size={20} color={theme.text} />
              <Text style={styles.plusText}>Search messages</Text>
            </Pressable>
            <Pressable
              style={styles.plusRow}
              onPress={() => onOpenPanel("pinned")}
            >
              <Pin size={20} color={theme.text} />
              <Text style={styles.plusText}>Pinned messages</Text>
            </Pressable>
            <Pressable
              style={styles.plusRow}
              onPress={() => onOpenPanel("files")}
            >
              <FolderOpen size={20} color={theme.text} />
              <Text style={styles.plusText}>Shared files</Text>
            </Pressable>
            <Pressable
              style={styles.plusRow}
              onPress={() => onOpenPanel("saved")}
            >
              <Star size={20} color={theme.text} />
              <Text style={styles.plusText}>Saved messages</Text>
            </Pressable>
            <View style={styles.hmDivider} />
            <Pressable style={styles.plusRow} onPress={onClearChat}>
              <Trash2 size={20} color={theme.danger} />
              <Text style={[styles.plusText, { color: theme.danger }]}>
                Clear chat
              </Text>
            </Pressable>
          </>
        ) : sheet === "search" ? (
          <>
            <TextInput
              style={styles.hmSearchInput}
              placeholder="Search in this chat…"
              placeholderTextColor={theme.textMuted}
              value={searchQ}
              onChangeText={onSearchChange}
              autoFocus
            />
            {loading ? (
              <ActivityIndicator
                style={styles.hmLoading}
                color={theme.primary}
              />
            ) : (
              <ScrollView style={styles.hmList}>
                {searchResults.length === 0 ? (
                  <Text style={styles.hmEmpty}>
                    {searchQ.trim().length < 2
                      ? "Type at least 2 characters to search"
                      : "No messages found"}
                  </Text>
                ) : (
                  searchResults.map((r) => (
                    <Pressable
                      key={r.id}
                      style={styles.hmItem}
                      onPress={() => onJump(r.id)}
                    >
                      <Text style={styles.hmItemName} numberOfLines={1}>
                        {r.sender_name || "Unknown"} ·{" "}
                        {fmtDateTime(r.created_at)}
                      </Text>
                      <Text style={styles.hmItemText} numberOfLines={2}>
                        {r.content ||
                          (r.file_name ? `📎 ${r.file_name}` : "Attachment")}
                      </Text>
                    </Pressable>
                  ))
                )}
              </ScrollView>
            )}
          </>
        ) : sheet === "pinned" ? (
          <ScrollView style={styles.hmList}>
            {pinnedMsgs.length === 0 ? (
              <Text style={styles.hmEmpty}>No pinned messages</Text>
            ) : (
              pinnedMsgs.map((p) => (
                <View key={p.id} style={styles.hmItemRow}>
                  <Pressable style={{ flex: 1 }} onPress={() => onJump(p.id)}>
                    <Text style={styles.hmItemName} numberOfLines={1}>
                      {p.sender_name || "Unknown"} · {fmtDateTime(p.created_at)}
                    </Text>
                    <Text style={styles.hmItemText} numberOfLines={2}>
                      {p.content ||
                        (p.file_name ? `📎 ${p.file_name}` : "Attachment")}
                    </Text>
                  </Pressable>
                  <Pressable hitSlop={8} onPress={() => onUnpin(p.id)}>
                    <XIcon size={16} color={theme.textSecondary} />
                  </Pressable>
                </View>
              ))
            )}
          </ScrollView>
        ) : sheet === "files" ? (
          loading ? (
            <ActivityIndicator style={styles.hmLoading} color={theme.primary} />
          ) : (
            <ScrollView style={styles.hmList}>
              {sharedFiles.length === 0 ? (
                <Text style={styles.hmEmpty}>No shared files</Text>
              ) : (
                sharedFiles.map((f) => (
                  <Pressable
                    key={f.id}
                    style={styles.hmItemRow}
                    onPress={() => {
                      const u = uploadUrl(f.file_url);
                      if (u) Linking.openURL(u);
                    }}
                  >
                    <FileText size={20} color={theme.primary} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.hmItemTitle} numberOfLines={1}>
                        {f.file_name || "File"}
                      </Text>
                      <Text style={styles.hmItemText} numberOfLines={1}>
                        {f.sender_name || "Unknown"} ·{" "}
                        {fmtDateTime(f.created_at)}
                        {f.file_size ? ` · ${fmtSize(f.file_size)}` : ""}
                      </Text>
                    </View>
                  </Pressable>
                ))
              )}
            </ScrollView>
          )
        ) : sheet === "saved" ? (
          loading ? (
            <ActivityIndicator style={styles.hmLoading} color={theme.primary} />
          ) : (
            <ScrollView style={styles.hmList}>
              {savedMsgs.length === 0 ? (
                <Text style={styles.hmEmpty}>No saved messages</Text>
              ) : (
                savedMsgs.map((m) => (
                  <View key={m.id} style={styles.hmItemRow}>
                    <Pressable
                      style={{ flex: 1 }}
                      onPress={() => {
                        // Jump only works for messages in THIS chat —
                        // /chat/starred is global across conversations.
                        if (m.conversation_id === convId) onJump(m.id);
                      }}
                    >
                      <Text style={styles.hmItemName} numberOfLines={1}>
                        {m.sender_name || "Unknown"} ·{" "}
                        {fmtDateTime(m.created_at)}
                        {m.conversation_id !== convId && m.group_name
                          ? ` · ${m.group_name}`
                          : ""}
                      </Text>
                      <Text style={styles.hmItemText} numberOfLines={2}>
                        {m.content ||
                          (m.file_name ? `📎 ${m.file_name}` : "Attachment")}
                      </Text>
                    </Pressable>
                    <Pressable hitSlop={8} onPress={() => onUnstar(m.id)}>
                      <Star size={16} color={theme.warning} />
                    </Pressable>
                  </View>
                ))
              )}
            </ScrollView>
          )
        ) : null}
      </View>
    </NativeBottomSheet>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    allHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: 6,
      paddingBottom: 10,
    },
    allTitle: { fontSize: 16, fontWeight: "700", color: theme.text },
    plusRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      paddingHorizontal: 22,
      paddingVertical: 14,
    },
    plusText: { fontSize: 16, color: theme.text, fontWeight: "500" },
    // Header 3-dot menu sheet + panels.
    hmSheet: {
      paddingHorizontal: 12,
      paddingTop: 12,
      paddingBottom: 12,
    },
    hmDivider: {
      height: 1,
      backgroundColor: theme.border,
      marginVertical: 6,
      marginHorizontal: 16,
    },
    hmSearchInput: {
      backgroundColor: theme.inputBg,
      borderWidth: 1,
      borderColor: theme.inputBorder,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 10,
      color: theme.text,
      fontSize: 15,
      marginHorizontal: 6,
      marginBottom: 8,
    },
    hmList: { maxHeight: 480 },
    hmEmpty: {
      fontSize: 13,
      color: theme.textMuted,
      textAlign: "center",
      paddingVertical: 28,
    },
    hmLoading: { paddingVertical: 28 },
    hmItem: {
      paddingHorizontal: 10,
      paddingVertical: 10,
      gap: 2,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    hmItemRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 10,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    hmItemName: { fontSize: 11, fontWeight: "700", color: theme.primaryLight },
    hmItemTitle: { fontSize: 14, color: theme.text, fontWeight: "500" },
    hmItemText: { fontSize: 13, color: theme.textSecondary },
  });