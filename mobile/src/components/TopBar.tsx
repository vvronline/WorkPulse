import { useCallback, useMemo } from "react";
import { Pressable, StyleSheet, Text, View, Image } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Bell, Search } from "lucide-react-native";
import { useEffect, useState } from "react";
import type { Theme } from "../theme";
import { useTheme } from "../theme/ThemeProvider";
import { useAuth } from "../auth/AuthContext";
import { getNotifications, getMyStatus } from "../features";
import { uploadUrl } from "../config";
import { socket } from "../realtime/socket";
import { chatUnreadManager } from "../realtime/chatUnreadEvents";
import { pushNotificationService } from "../services/pushNotificationService";
import StatusDot from "./StatusDot";

function initials(name?: string) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  const a = parts[0]?.[0] ?? "";
  const b = parts[1]?.[0] ?? "";
  return (a + b).toUpperCase() || "?";
}

/**
 * Shared top navigation bar mirroring the web Navbar on mobile:
 * logo + org name on the left, notification bell + profile avatar on the right.
 */
export default function TopBar() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const { user } = useAuth();
  const [unread, setUnread] = useState(0);
  // Current user's resolved effective presence, shown as a dot on the avatar
  // (mirrors the web Navbar avatar status badge).
  const [myStatus, setMyStatus] = useState<string | null>(null);

  // Refresh unread badge whenever a tab regains focus. Also reconcile the
  // launcher/app-icon badge with the combined unread total (notifications +
  // chat) so it stays accurate when items are read in-app — push delivery sets
  // it on arrival, this clears/decrements it once the user catches up.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      getNotifications()
        .then((r) => {
          if (!active) return;
          const notifUnread = r.data.unread || 0;
          setUnread(notifUnread);
          const total = notifUnread + chatUnreadManager.getTotalUnread();
          pushNotificationService.setBadgeCount(Math.max(0, total)).catch(() => {});
        })
        .catch(() => {});
      getMyStatus()
        .then((r) => {
          if (active) setMyStatus(r.data?.effective ?? null);
        })
        .catch(() => {});
      return () => {
        active = false;
      };
    }, []),
  );

  // Keep the avatar status dot live via the unified `user_status` WS event.
  useEffect(() => {
    const off = socket.subscribe((msg) => {
      if (msg.type !== "user_status") return;
      if (!user?.id || msg.data?.userId !== user.id) return;
      setMyStatus(msg.data.effective);
    });
    return off;
  }, [user?.id]);

  return (
    <View style={[styles.bar, { paddingTop: insets.top, height: 56 + insets.top }]}>
      {/* Left: logo + title */}
      <View style={styles.left}>
        <View style={styles.logo}>
          <Image
            source={require("../../assets/icon.png")}
            style={styles.logoImg}
            resizeMode="cover"
          />
        </View>
        <Text style={styles.title}>loops</Text>
      </View>

      {/* Right: search + notifications + profile */}
      <View style={styles.right}>
        <Pressable
          style={styles.iconBtn}
          onPress={() => router.push("/search")}
          hitSlop={6}
          accessibilityLabel="Search"
        >
          <Search size={20} color={theme.textSecondary} />
        </Pressable>
        <Pressable
          style={styles.iconBtn}
          onPress={() => router.push("/notifications")}
          hitSlop={6}
        >
          <Bell size={20} color={theme.textSecondary} />
          {unread > 0 ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{unread > 99 ? "99+" : unread}</Text>
            </View>
          ) : null}
        </Pressable>

        <Pressable onPress={() => router.push("/profile")} hitSlop={6}>
          <View style={styles.avatarWrap}>
            <View style={styles.avatar}>
              {uploadUrl(user?.avatar) ? (
                <Image source={{ uri: uploadUrl(user?.avatar)! }} style={styles.avatarImg} />
              ) : (
                <Text style={styles.avatarText}>
                  {initials(user?.full_name || user?.username)}
                </Text>
              )}
            </View>
            {myStatus ? (
              <View style={styles.avatarStatus}>
                <StatusDot status={myStatus} size={12} borderColor={theme.bgSecondary} />
              </View>
            ) : null}
          </View>
        </Pressable>
      </View>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    backgroundColor: theme.bgSecondary,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  left: { flexDirection: "row", alignItems: "center", gap: 10 },
  logo: {
    width: 32,
    height: 32,
    borderRadius: 9,
    overflow: "hidden",
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  logoImg: { width: 32, height: 32, borderRadius: 9 },
  title: {
    fontSize: 22,
    fontFamily: theme.fontBrand,
    color: theme.text,
    letterSpacing: 0.3,
    // Pacifico has tall ascenders/descenders; nudge baseline so it sits
    // centered next to the logo without clipping.
    paddingTop: 2,
  },
  right: { flexDirection: "row", alignItems: "center", gap: 12 },
  iconBtn: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: theme.glass,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    alignItems: "center",
    justifyContent: "center",
  },
  badge: {
    position: "absolute",
    top: 4,
    right: 4,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: theme.danger,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
    borderWidth: 2,
    borderColor: theme.bgSecondary,
  },
  badgeText: { color: "#fff", fontSize: 9, fontWeight: "700" },
  avatarWrap: { width: 34, height: 34 },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  avatarStatus: { position: "absolute", bottom: -1, right: -1 },
  avatarImg: { width: 34, height: 34, borderRadius: 17 },
  avatarText: { color: "#fff", fontSize: 12, fontWeight: "700" },
});
