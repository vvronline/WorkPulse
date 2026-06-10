import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { MessagesSquare, PenSquare } from "lucide-react-native";
import { theme } from "../../src/theme";
import { getConversations, type Conversation } from "../../src/features";
import { socket } from "../../src/realtime/socket";

function initials(name?: string | null) {
  if (!name) return "?";
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "?";
}

function timeAgo(iso?: string | null) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (isNaN(then)) return "";
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function ChatScreen() {
  const router = useRouter();
  const [items, setItems] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await getConversations();
      setItems(data || []);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Refresh list on focus and when a new message arrives over the socket.
  useFocusEffect(
    useCallback(() => {
      load();
      const off = socket.subscribe((msg) => {
        if (msg.type === "chat_message") load();
      });
      return off;
    }, [load]),
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
  }, [load]);

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <FlatList
        data={items}
        keyExtractor={(c) => String(c.id)}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.primary}
          />
        }
        ListHeaderComponent={<Text style={styles.heading}>Chat</Text>}
        renderItem={({ item }) => {
          const name = item.is_group
            ? item.group_name || "Group"
            : item.other_full_name || item.other_username || "User";
          const preview = item.last_file_url
            ? "📎 Attachment"
            : item.last_message || "No messages yet";
          return (
            <Pressable
              style={styles.row}
              onPress={() =>
                router.push({
                  pathname: "/chat/[id]",
                  params: { id: String(item.id), name },
                })
              }
              android_ripple={{ color: theme.surfaceHover }}
            >
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{initials(name)}</Text>
              </View>
              <View style={styles.body}>
                <View style={styles.rowTop}>
                  <Text style={styles.name} numberOfLines={1}>
                    {name}
                  </Text>
                  <Text style={styles.time}>{timeAgo(item.last_message_at)}</Text>
                </View>
                <View style={styles.rowBottom}>
                  <Text style={styles.preview} numberOfLines={1}>
                    {preview}
                  </Text>
                  {item.unread_count > 0 ? (
                    <View style={styles.unread}>
                      <Text style={styles.unreadText}>
                        {item.unread_count > 99 ? "99+" : item.unread_count}
                      </Text>
                    </View>
                  ) : null}
                </View>
              </View>
            </Pressable>
          );
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <MessagesSquare size={40} color={theme.textMuted} />
            <Text style={styles.emptyText}>No conversations yet</Text>
          </View>
        }
      />
      <Pressable style={styles.fab} onPress={() => router.push("/chat/new")}>
        <PenSquare size={22} color="#fff" />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { alignItems: "center", justifyContent: "center" },
  fab: {
    position: "absolute",
    right: 20,
    bottom: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
    elevation: 4,
  },
  list: { padding: 16, gap: 6, paddingBottom: 32 },
  heading: {
    fontSize: 24,
    fontWeight: "800",
    color: theme.text,
    letterSpacing: -0.5,
    marginBottom: 10,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 4,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  body: { flex: 1, gap: 3 },
  rowTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  name: { flex: 1, fontSize: 15, fontWeight: "600", color: theme.text },
  time: { fontSize: 11, color: theme.textMuted },
  rowBottom: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  preview: { flex: 1, fontSize: 13, color: theme.textSecondary },
  unread: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  unreadText: { color: "#fff", fontSize: 11, fontWeight: "700" },
  empty: { alignItems: "center", gap: 10, paddingTop: 80 },
  emptyText: { color: theme.textMuted, fontSize: 14 },
});
