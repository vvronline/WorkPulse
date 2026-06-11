import { Image, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { uploadUrl } from "../config";
import StatusDot from "./StatusDot";

/**
 * Avatar with an optional status badge — mirrors the web
 * `client/src/components/chat/ChatAvatar.tsx`. Shows initials (or image) plus a
 * status dot overlaid bottom-right when `userStatus`/`online` is provided.
 */

const SIZES: Record<string, number> = {
  sm: 32,
  md: 44,
  lg: 56,
  xl: 72,
};

function initials(name?: string | null) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  return (
    ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase().slice(0, 2) ||
    "?"
  );
}

interface ChatAvatarProps {
  name?: string | null;
  avatar?: string | null;
  size?: keyof typeof SIZES | number;
  // Rich status value ("available" | "busy" | "dnd" | "brb" | "away" |
  // "in_call" | "in_meeting" | "offline"). Takes precedence over `online`.
  userStatus?: string | null;
  // Fallback online/offline boolean when no rich status is available.
  online?: boolean;
  // Surface color the dot's ring blends into (defaults to the app bg).
  ringColor?: string;
}

export default function ChatAvatar({
  name,
  avatar,
  size = "md",
  userStatus,
  online,
  ringColor = theme.bg,
}: ChatAvatarProps) {
  const dim = typeof size === "number" ? size : SIZES[size] || SIZES.md;
  const uri = uploadUrl(avatar);
  const showDot = !!userStatus || online !== undefined;
  const dotSize = Math.max(10, Math.round(dim * 0.32));

  const effectiveStatus =
    userStatus || (online === undefined ? null : online ? "available" : "offline");

  return (
    <View style={{ width: dim, height: dim }}>
      {uri ? (
        <Image
          source={{ uri }}
          style={{ width: dim, height: dim, borderRadius: dim / 2 }}
        />
      ) : (
        <View
          style={[
            styles.initialsWrap,
            { width: dim, height: dim, borderRadius: dim / 2 },
          ]}
        >
          <Text style={[styles.initialsText, { fontSize: dim * 0.38 }]}>
            {initials(name)}
          </Text>
        </View>
      )}
      {showDot ? (
        <View style={styles.dotWrap}>
          <StatusDot
            status={effectiveStatus}
            size={dotSize}
            borderColor={ringColor}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  initialsWrap: {
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  initialsText: { color: "#fff", fontWeight: "700" },
  dotWrap: {
    position: "absolute",
    right: -1,
    bottom: -1,
  },
});