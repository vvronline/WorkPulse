import { useCallback, useEffect, useState } from "react";
import { Redirect, Tabs } from "expo-router";
import { ActivityIndicator, AppState, View } from "react-native";
import {
  Calendar,
  Home,
  Menu,
  MessageSquare,
  ClipboardList,
} from "lucide-react-native";
import { useAuth } from "../../src/auth/AuthContext";
import { theme } from "../../src/theme";
import TopBar from "../../src/components/TopBar";
import { getConversations } from "../../src/features";
import { socket } from "../../src/realtime/socket";

export default function TabsLayout() {
  const { user, loading } = useAuth();
  // Total unread chat messages, shown as a badge on the Chat tab icon
  // (mirrors the web sidebar's chat unread count). Driven by the conversations
  // list + live `chat_message` WS events so it updates without opening Chat.
  const [chatUnread, setChatUnread] = useState(0);

  const refreshUnread = useCallback(() => {
    getConversations()
      .then((r) => {
        const total = (r.data || []).reduce(
          (sum, c) => sum + (c.unread_count || 0),
          0,
        );
        setChatUnread(total);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!user) return;
    socket.connect();
    refreshUnread();
    // Any incoming chat message (for a conversation we're not actively in)
    // bumps the badge; we re-pull the authoritative unread totals so the count
    // matches the server's per-conversation unread tracking.
    const off = socket.subscribe((msg) => {
      if (msg.type === "chat_message" || msg.type === "chat_read") {
        refreshUnread();
      }
    });
    // Refresh when returning to the foreground (WS may have reconnected).
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") refreshUnread();
    });
    return () => {
      off();
      sub.remove();
    };
  }, [user, refreshUnread]);

  if (loading) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.bg,
        }}
      >
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  if (!user) {
    return <Redirect href="/login" />;
  }

  return (
    <Tabs
      screenOptions={{
        // Persistent top bar (logo + notifications + profile) on every tab,
        // mirroring the web Navbar.
        header: () => <TopBar />,
        tabBarActiveTintColor: theme.primary,
        tabBarInactiveTintColor: theme.textMuted,
        tabBarStyle: {
          backgroundColor: theme.bgSecondary,
          borderTopColor: theme.border,
          height: 60,
          paddingTop: 6,
          paddingBottom: 8,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: "500" },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ color, size }) => <Home color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="calendar"
        options={{
          title: "Calendar",
          tabBarIcon: ({ color, size }) => <Calendar color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="tasks"
        options={{
          title: "Tasks",
          tabBarIcon: ({ color, size }) => (
            <ClipboardList color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: "Chat",
          tabBarIcon: ({ color, size }) => (
            <MessageSquare color={color} size={size} />
          ),
          tabBarBadge: chatUnread > 0 ? (chatUnread > 99 ? "99+" : chatUnread) : undefined,
          tabBarBadgeStyle: {
            backgroundColor: theme.danger,
            color: "#fff",
            fontSize: 10,
          },
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: "More",
          tabBarIcon: ({ color, size }) => <Menu color={color} size={size} />,
        }}
      />
      {/* Reachable from the More menu, not shown as its own tab. */}
      <Tabs.Screen name="leaves" options={{ href: null }} />
    </Tabs>
  );
}
