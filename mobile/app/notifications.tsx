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
import { BellOff, CheckCheck } from "lucide-react-native";

import { theme } from "../src/theme";
import {
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type Notification,
} from "../src/features";

function timeAgo(iso: string) {
  const then = new Date(iso).getTime();
  if (isNaN(then)) return "";
  const diff = Math.max(0, Date.now() - then);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export default function NotificationsScreen() {
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await getNotifications();
      setItems(data.notifications || []);
      setUnread(data.unread || 0);
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

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
  }, [load]);

  const onPressItem = useCallback(async (n: Notification) => {
    if (n.is_read) return;
    setItems((prev) =>
      prev.map((x) => (x.id === n.id ? { ...x, is_read: true } : x)),
    );
    setUnread((u) => Math.max(0, u - 1));
    try {
      await markNotificationRead(n.id);
    } catch {
      /* ignore */
    }
  }, []);

  const onMarkAll = useCallback(async () => {
    setItems((prev) => prev.map((x) => ({ ...x, is_read: true })));
    setUnread(0);
    try {
      await markAllNotificationsRead();
    } catch {
      /* ignore */
    }
  }, []);

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
        keyExtractor={(n) => String(n.id)}
        contentContainerStyle={[styles.list, { paddingTop: 16 }]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.primary}
          />
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <View>
              <Text style={styles.heading}>Notifications</Text>
              {unread > 0 ? (
                <Text style={styles.unread}>{unread} unread</Text>
              ) : null}
            </View>
            {unread > 0 ? (
              <Pressable style={styles.markAll} onPress={onMarkAll} hitSlop={8}>
                <CheckCheck size={16} color={theme.primary} />
                <Text style={styles.markAllText}>Mark all</Text>
              </Pressable>
            ) : null}
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            style={[styles.card, !item.is_read && styles.cardUnread]}
            onPress={() => onPressItem(item)}
          >
            {!item.is_read ? <View style={styles.unreadDot} /> : null}
            <View style={styles.cardBody}>
              <Text style={styles.title} numberOfLines={2}>
                {item.title}
              </Text>
              {item.body ? (
                <Text style={styles.body} numberOfLines={3}>
                  {item.body}
                </Text>
              ) : null}
              {item.task_title ? (
                <Text style={styles.task} numberOfLines={1}>
                  ↳ {item.task_title}
                </Text>
              ) : null}
              <Text style={styles.time}>{timeAgo(item.created_at)}</Text>
            </View>
          </Pressable>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <BellOff size={40} color={theme.textMuted} />
            <Text style={styles.emptyText}>No notifications</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { alignItems: "center", justifyContent: "center" },
  list: { padding: 16, gap: 10, paddingBottom: 32 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  heading: {
    fontSize: 24,
    fontWeight: "800",
    color: theme.text,
    letterSpacing: -0.5,
  },
  unread: { fontSize: 13, color: theme.primary, marginTop: 2 },
  markAll: { flexDirection: "row", alignItems: "center", gap: 5 },
  markAllText: { color: theme.primary, fontWeight: "600", fontSize: 13 },
  card: {
    flexDirection: "row",
    gap: 10,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    borderRadius: theme.radius,
    padding: 14,
  },
  cardUnread: { borderColor: theme.primary + "55", backgroundColor: theme.primaryGlow },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.primary,
    marginTop: 5,
  },
  cardBody: { flex: 1, gap: 3 },
  title: { fontSize: 14, fontWeight: "600", color: theme.text },
  body: { fontSize: 13, color: theme.textSecondary, lineHeight: 18 },
  task: { fontSize: 12, color: theme.primaryLight },
  time: { fontSize: 11, color: theme.textMuted, marginTop: 2 },
  empty: { alignItems: "center", gap: 10, paddingTop: 80 },
  emptyText: { color: theme.textMuted, fontSize: 14 },
});
