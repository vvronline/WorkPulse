import { useCallback, useEffect, useRef, useState } from "react";
import { Redirect, Tabs } from "expo-router";
import {
  ActivityIndicator,
  AppState,
  Pressable,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle,
  View,
} from "react-native";
import * as Notifications from "expo-notifications";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Calendar,
  Clock,
  Home,
  Menu,
  MessageSquare,
  ClipboardList,
} from "../../src/icons";
import { useAuth, userHasFeature } from "../../src/auth/AuthContext";
import { useTheme } from "../../src/theme/ThemeProvider";
import TopBar from "../../src/components/TopBar";
import { getConversations } from "../../src/features";
import { socket } from "../../src/realtime/socket";
import {
  subscribeChatUnreadChanged,
} from "../../src/realtime/chatUnreadEvents";
import { chatUnreadManager } from "../../src/realtime/chatUnreadEvents";
import { pushNotificationService } from "../../src/services/pushNotificationService";

// Custom bottom-tab button that replaces React Navigation's default
// `PlatformPressable` (which applies the Android Material ripple). This renders
// a plain Pressable with NO ripple and a subtle Signal-style opacity dim while
// pressed — matching the rest of the app's touch feedback.
type TabBarButtonProps = {
  children?: React.ReactNode;
  onPress?: (e: GestureResponderEvent) => void;
  onLongPress?: (e: GestureResponderEvent) => void;
  accessibilityState?: { selected?: boolean; disabled?: boolean };
  accessibilityLabel?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

function TabBarButton({
  children,
  onPress,
  onLongPress,
  accessibilityState,
  accessibilityLabel,
  testID,
  style,
}: TabBarButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      onPress={onPress}
      onLongPress={onLongPress}
      android_ripple={null}
      style={({ pressed }) => [
        style,
        { opacity: pressed ? 0.6 : 1 },
      ]}
    >
      {children}
    </Pressable>
  );
}

export default function TabsLayout() {
  const theme = useTheme();
  const { user, loading } = useAuth();
  // Bottom safe-area inset (home indicator / gesture nav bar). Mirrors how
  // Signal-Android respects the system window insets so the tab bar isn't
  // crammed flush against the bottom edge of the screen.
  const insets = useSafeAreaInsets();
  // Plan/feature gating — mirrors the web MobileTabBar which only renders the
  // Calendar/Tasks/Chat tabs when the tenant's plan enables them. A disabled
  // tab is hidden with `href: null` (same mechanism used for `leaves`).
  const calendarEnabled = userHasFeature(user, "calendar");
  const tasksEnabled = userHasFeature(user, "tasks");
  const chatEnabled = userHasFeature(user, "chat");
  const attendanceEnabled = userHasFeature(user, "attendance");
  // Total unread chat messages, shown as a badge on the Chat tab icon
  // (mirrors the web sidebar's chat unread count). Driven by the conversations
  // list + live `chat_message` WS events so it updates without opening Chat.
  const [chatUnread, setChatUnread] = useState(0);
  // Coalesce bursts of chat_* WS events into a single unread re-pull instead of
  // one full getConversations() per event (a busy chat used to hammer this).
  const unreadRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshUnread = useCallback(() => {
    getConversations()
      .then((r) => {
        const conversations = r.data || [];
        // T029: Sync unread counts with chatUnreadManager
        conversations.forEach((conv) => {
          chatUnreadManager.updateUnreadCount(conv.id, conv.unread_count || 0);
        });
        const total = conversations.reduce(
          (sum, c) => sum + (c.unread_count || 0),
          0,
        );
        setChatUnread(total);
        // T029: Update launcher badge with total unread
        pushNotificationService.setBadgeCount(total).catch(() => {});
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!user) return;
    socket.connect();
    // Don't track chat unread when the chat feature is disabled for the tenant.
    if (!chatEnabled) {
      setChatUnread(0);
      pushNotificationService.clearBadge().catch(() => {});
      return;
    }
    refreshUnread();
    const scheduleUnreadRefresh = () => {
      if (unreadRefreshTimer.current) return;
      unreadRefreshTimer.current = setTimeout(() => {
        unreadRefreshTimer.current = null;
        refreshUnread();
      }, 400);
    };
    // Any incoming chat message (for a conversation we're not actively in)
    // bumps the badge; we re-pull the authoritative unread totals so the count
    // matches the server's per-conversation unread tracking. Debounced so a
    // burst of messages doesn't trigger one full fetch each.
    const off = socket.subscribe((msg) => {
      if (msg.type.startsWith("chat_")) {
        scheduleUnreadRefresh();
      }
    });
    const offUnreadChanged = subscribeChatUnreadChanged(() => {
      refreshUnread();
    });
    // T029: Listen to unread manager for real-time badge updates
    const unsubUnreadChange = chatUnreadManager.onUnreadChange((_convId, _count) => {
      const total = chatUnreadManager.getTotalUnread();
      setChatUnread(total);
      pushNotificationService.setBadgeCount(total).catch(() => {});
    });
    // Refresh when returning to the foreground (WS may have reconnected).
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") {
        refreshUnread();
      }
    });
    return () => {
      off();
      offUnreadChanged();
      unsubUnreadChange();
      sub.remove();
      if (unreadRefreshTimer.current) {
        clearTimeout(unreadRefreshTimer.current);
        unreadRefreshTimer.current = null;
      }
    };
  }, [user, chatEnabled, refreshUnread]);

  useEffect(() => {
    if (!user || !chatEnabled) {
      Notifications.setBadgeCountAsync(0).catch(() => {});
      return;
    }
    Notifications.setBadgeCountAsync(chatUnread).catch(() => {});
  }, [chatEnabled, chatUnread, user?.id]);

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
        // Replace the default ripple-emitting tab button with our no-ripple,
        // opacity-dim Pressable (Signal-style press feedback).
        tabBarButton: (props) => <TabBarButton {...(props as TabBarButtonProps)} />,
        tabBarStyle: {
          backgroundColor: theme.bgSecondary,
          borderTopColor: theme.border,
          // Grow the bar to include the bottom safe-area inset so it clears the
          // home indicator / gesture nav bar instead of sitting flush against
          // the screen edge (matches Signal-Android's inset-aware bars).
          // Enforce a MINIMUM bottom gap so devices that report a 0 inset (e.g.
          // 3-button nav / no gesture bar) still get visible breathing room
          // between the icons and the screen edge instead of a cramped bar.
          height: 68 + Math.max(insets.bottom, 14),
          paddingTop: 10,
          paddingBottom: Math.max(insets.bottom, 14),
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
        name="attendance"
        options={{
          title: "Attendance",
          tabBarIcon: ({ color, size }) => <Clock color={color} size={size} />,
          // Hidden when the tenant's plan disables the attendance feature.
          href: attendanceEnabled ? undefined : null,
        }}
      />
      <Tabs.Screen
        name="calendar"
        options={{
          title: "Calendar",
          tabBarIcon: ({ color, size }) => <Calendar color={color} size={size} />,
          // Moved into the More menu — kept registered but hidden from the tab bar.
          href: null,
        }}
      />
      <Tabs.Screen
        name="tasks"
        options={{
          title: "Tasks",
          tabBarIcon: ({ color, size }) => (
            <ClipboardList color={color} size={size} />
          ),
          // Hidden when the tenant's plan disables the tasks feature.
          href: tasksEnabled ? undefined : null,
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
          // Hidden when the tenant's plan disables the chat feature.
          href: chatEnabled ? undefined : null,
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
      {/*
        Co-located *.styles.ts files in this (tabs) directory are picked up by
        expo-router as routes, which leaks them into the tab bar as broken
        entries AFTER the "More" tab. Explicitly hide them with href: null so
        only the real screens render. (Keep in sync with any new *.styles files
        added here.)
      */}
      <Tabs.Screen name="attendance.styles" options={{ href: null }} />
      <Tabs.Screen name="calendar.styles" options={{ href: null }} />
      <Tabs.Screen name="tasks.styles" options={{ href: null }} />
    </Tabs>
  );
}
