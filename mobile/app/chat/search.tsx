import { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import { searchMessages, type MessageSearchResult } from "../../src/features";
import { fmtDateTime } from "../../src/components/chat/chatUtils";
import { emitChatJump } from "../../src/realtime/chatJumpEvents";

/**
 * In-conversation search screen (mirrors Signal-Android's conversation search).
 * A debounced query hits /chat/search-messages scoped to this conversation;
 * tapping a result pops back to the thread and emits a jump event so the chat
 * scrolls to that message.
 */
export default function ChatSearch() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string; name?: string }>();
  const convId = Number(params.id);

  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<MessageSearchResult[]>([]);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onChange = useCallback(
    (v: string) => {
      setQ(v);
      if (debounce.current) clearTimeout(debounce.current);
      const term = v.trim();
      if (term.length < 2) {
        setResults([]);
        setLoading(false);
        return;
      }
      debounce.current = setTimeout(() => {
        setLoading(true);
        searchMessages(term, convId)
          .then((r) => setResults(r.data || []))
          .catch(() => setResults([]))
          .finally(() => setLoading(false));
      }, 300);
    },
    [convId],
  );

  const onPick = useCallback(
    (messageId: number) => {
      router.back();
      // Defer so the back-navigation settles before the thread scrolls.
      setTimeout(() => emitChatJump(convId, messageId), 250);
    },
    [convId, router],
  );

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: "Search" }} />
      <View style={styles.searchWrap}>
        <TextInput
          style={styles.input}
          placeholder="Search in this chat…"
          placeholderTextColor={theme.textMuted}
          value={q}
          onChangeText={onChange}
          autoFocus
          returnKeyType="search"
        />
      </View>

      {loading ? (
        <ActivityIndicator style={styles.loading} color={theme.primary} />
      ) : (
        <FlatList
          data={results}
          keyExtractor={(r) => String(r.id)}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <Text style={styles.empty}>
              {q.trim().length < 2
                ? "Type at least 2 characters to search"
                : "No messages found"}
            </Text>
          }
          renderItem={({ item }) => (
            <Pressable style={styles.item} onPress={() => onPick(item.id)}>
              <Text style={styles.itemName} numberOfLines={1}>
                {item.sender_name || "Unknown"} · {fmtDateTime(item.created_at)}
              </Text>
              <Text style={styles.itemText} numberOfLines={2}>
                {item.content ||
                  (item.file_name ? `📎 ${item.file_name}` : "Attachment")}
              </Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.bg },
    searchWrap: { padding: 12 },
    input: {
      backgroundColor: theme.inputBg,
      borderWidth: 1,
      borderColor: theme.inputBorder,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 10,
      color: theme.text,
      fontSize: 15,
    },
    loading: { paddingVertical: 28 },
    empty: {
      fontSize: 13,
      color: theme.textMuted,
      textAlign: "center",
      paddingVertical: 32,
    },
    item: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      gap: 3,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    itemName: { fontSize: 11, color: theme.primaryLight, fontFamily: theme.fontSemiBold },
    itemText: { fontSize: 14, color: theme.text },
  });