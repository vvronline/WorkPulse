import { useCallback } from "react";
import { Pressable, StyleSheet, Text, View, Image } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Bell } from "lucide-react-native";
import { useState } from "react";
import { theme } from "../theme";
import { useAuth } from "../auth/AuthContext";
import { getNotifications } from "../features";
import { uploadUrl } from "../config";

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
  const { user } = useAuth();
  const [unread, setUnread] = useState(0);

  // Refresh unread badge whenever a tab regains focus.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      getNotifications()
        .then((r) => {
          if (active) setUnread(r.data.unread || 0);
        })
        .catch(() => {});
      return () => {
        active = false;
      };
    }, []),
  );

  return (
    <View style={[styles.bar, { paddingTop: insets.top, height: 56 + insets.top }]}>
      {/* Left: logo + title */}
      <View style={styles.left}>
        <View style={styles.logo}>
          <Text style={styles.logoEmoji}>💼</Text>
        </View>
        <Text style={styles.title}>WorkPulse</Text>
      </View>

      {/* Right: notifications + profile */}
      <View style={styles.right}>
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
          <View style={styles.avatar}>
            {uploadUrl(user?.avatar) ? (
              <Image source={{ uri: uploadUrl(user?.avatar)! }} style={styles.avatarImg} />
            ) : (
              <Text style={styles.avatarText}>
                {initials(user?.full_name || user?.username)}
              </Text>
            )}
          </View>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
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
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  logoEmoji: { fontSize: 16 },
  title: { fontSize: 17, fontWeight: "700", color: theme.text, letterSpacing: -0.3 },
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
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  avatarImg: { width: 34, height: 34, borderRadius: 17 },
  avatarText: { color: "#fff", fontSize: 12, fontWeight: "700" },
});
