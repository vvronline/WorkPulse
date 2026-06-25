import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Star, X as XIcon } from "lucide-react-native";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import {
  getPinnedMessages,
  getStarredMessages,
  pinMessage,
  starMessage,
  type PinnedMessage,
  type StarredMessage,
} from "../../src/features";
import { fmtDateTime } from "../../src/components/chat/chatUtils";
import { emitChatJump } from "../../src/realtime/chatJumpEvents";

type Mode = "pinned" | "saved";

type Row = {
  id: number;
  conversation_id?: number;
  content?: string | null;
  file_name?: string | null;
  created_at: string;
  sender_name?: string | null;
  group_name?: string | null;
};

/**
 * Pinned / Saved messages screen. `mode` selects the list. Tapping a row pops
 * back to the thread and jumps to that message (saved messages are global, so
 * jump only fires for ones in the current conversation). The trailing icon
 * unpins / unstars in place.
 */
export default function ChatSaved() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const params = useLocalSearchParams<{
    id: string;
    name?: string;
    mode?: Mode;
  }>();
  const convId = Number(params.id);
  const mode: Mode = params.mode === "saved" ? "saved" : "pinned";

  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<Row[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (mode === "pinned") {
        const r = await getPinnedMessages(convId);
        setRows((r.data as PinnedMessage[]) || []);
      } else {
        const r = await getStarredMessages();
        setRows((r.data as StarredMessage[]) || []);
      }
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [convId, mode]);

  useEffect(() => {
    load();
  }, [load]);

  const onJump = useCallback(
    (row: Row) => {
      // Saved messages are global; only jump when the row belongs to the chat
      // we came from.
      const targetConv = row.conversation_id ?? convId;
      if (targetConv !== convId) return;
      router.back();
      router.back();
      setTimeout(() => emitChatJump(convId, row.id), 280);
    },
    [convId, router],
  );

  const onRemove = useCallback(
    (id: number) => {
      if (mode === "pinned") {
        pinMessage(id)
          .then(() => setRows((prev) => prev.filter((r) => r.id !== id)))
          .catch(() => {});
      } else {
        starMessage(id)
          .then(() => setRows((prev) => prev.filter((r) => r.id !== id)))
          .catch(() => {});
      }
    },
    [mode],
  );

  const title = mode === "pinned" ? "Pinned messages" : "Saved messages";

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title }} />
      {loading ? (
        <ActivityIndicator style={styles.loading} color={theme.primary} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => String(r.id)}
          ListEmptyComponent={
            <Text style={styles.empty}>
              {mode === "pinned" ? "No pinned messages" : "No saved messages"}
            </Text>
          }
          renderItem={({ item }) => (
            <View style={styles.row}>
              <Pressable style={{ flex: 1 }} onPress={() => onJump(item)}>
                <Text style={styles.name} numberOfLines={1}>
                  {item.sender_name || "Unknown"} ·{" "}
                  {fmtDateTime(item.created_at)}
                  {mode === "saved" &&
                  item.conversation_id !== convId &&
                  item.group_name
                    ? ` · ${item.group_name}`
                    : ""}
                </Text>
                <Text style={styles.text} numberOfLines={2}>
                  {item.content ||
                    (item.file_name ? `📎 ${item.file_name}` : "Attachment")}
                </Text>
              </Pressable>
              <Pressable hitSlop={8} onPress={() => onRemove(item.id)}>
                {mode === "pinned" ? (
                  <XIcon size={18} color={theme.textSecondary} />
                ) : (
                  <Star size={18} color={theme.warning} fill={theme.warning} />
                )}
              </Pressable>
            </View>
          )}
        />
      )}
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.bg },
    loading: { paddingVertical: 28 },
    empty: {
      fontSize: 13,
      color: theme.textMuted,
      textAlign: "center",
      paddingVertical: 36,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 13,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    name: {
      fontSize: 11,
      color: theme.primaryLight,
      fontFamily: theme.fontSemiBold,
    },
    text: { fontSize: 14, color: theme.text, marginTop: 3 },
  });