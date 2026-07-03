import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter, usePathname } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Phone, Video as VideoIcon } from "../icons";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../theme/ThemeProvider";
import { socket } from "./socket";
import {
  beginCallNavigation,
  isCallActive,
  onCallNavigationEnd,
} from "./callRouting";
import { getActiveCall, type ActiveCall } from "../features";
import { SERVER_ORIGIN } from "../config";

/**
 * Global "Ongoing call — tap to return" banner (mobile parity with the web
 * client's refresh-rejoin). The web client auto-rejoins an active call on a page
 * refresh (useCallState restores `wp_active_call` + sends `call_reconnect`).
 * Mobile has no such auto-restore because navigating away from the call screen
 * unmounts it entirely — so a user who backs out of (or is killed/reopened
 * during) a still-live call had NO way back in.
 *
 * This listener polls `GET /chat/calls/active` on mount and whenever the app
 * returns to the foreground. When the server reports a still-answered call AND
 * the full-screen call screen is NOT currently mounted (checked via the
 * callRouting guard), it shows a tappable bar. Tapping navigates to
 * `/call/[conversationId]` in `reconnect` mode, which acquires media, emits
 * `call_reconnect`, and re-binds the WebRTC session (see the call screen's
 * reconnect effect + the peer's `call_reconnect` re-offer handler).
 */
export default function OngoingCallBanner() {
  const { user } = useAuth();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const pathname = usePathname();
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  // Guards a refresh in-flight so overlapping AppState/poll triggers don't
  // hammer the endpoint.
  const checkingRef = useRef(false);

  const onCallScreen = pathname?.startsWith("/call/") ?? false;

  const refresh = useCallback(async () => {
    if (!user) {
      setActiveCall(null);
      return;
    }
    // Never show the banner while the call screen itself is up (either route is
    // /call/... or the navigation guard is claimed for an active/ringing call).
    if (onCallScreen || isCallActive()) {
      setActiveCall(null);
      return;
    }
    if (checkingRef.current) return;
    checkingRef.current = true;
    try {
      const { data } = await getActiveCall();
      // `id` present means there is a still-answered call for this user.
      setActiveCall(data && (data as ActiveCall).id ? (data as ActiveCall) : null);
    } catch {
      // No active call / request failed — hide the banner.
      setActiveCall(null);
    } finally {
      checkingRef.current = false;
    }
  }, [user, onCallScreen]);

  // Check on mount + whenever the logged-in user or current route changes.
  // When LEAVING the call screen (onCallScreen true → false), the server may
  // not have committed `status = 'ended'` yet, so the immediate poll can still
  // report the call as answered and re-show a stale banner. Re-poll once more
  // after a short delay to defeat that race.
  useEffect(() => {
    void refresh();
    if (!onCallScreen) {
      const t = setTimeout(() => void refresh(), 1000);
      return () => clearTimeout(t);
    }
  }, [refresh, onCallScreen]);

  // The party that ENDS a call never receives a `call_ended` socket echo from
  // the server, so clear the banner immediately when the local user leaves any
  // call (hang-up / decline / back-press out of the call screen).
  useEffect(() => {
    const off = onCallNavigationEnd(() => setActiveCall(null));
    return off;
  }, []);

  // Re-check whenever the app returns to the foreground (covers killed/reopened
  // and background→foreground while a call is still live on the other side).
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  // React to realtime call lifecycle so the banner appears/disappears promptly
  // without waiting for the next foreground/route change.
  useEffect(() => {
    if (!user) return;
    const off = socket.subscribe((msg) => {
      switch (msg.type) {
        case "call_accepted":
        case "call_started":
        case "call_reconnect":
          void refresh();
          break;
        case "call_ended":
        case "call_rejected":
        case "call_handled_elsewhere":
          // The call we may be advertising just ended — clear immediately.
          setActiveCall(null);
          break;
      }
    });
    return off;
  }, [user, refresh]);

  if (!user || !activeCall || onCallScreen) return null;

  const isVideo = activeCall.call_type === "video";
  const name =
    (!activeCall.is_group ? activeCall.other_name : activeCall.group_name) ||
    activeCall.caller_name ||
    "Ongoing call";
  const avatar = !activeCall.is_group
    ? activeCall.other_avatar
    : null;
  const avatarUrl =
    avatar && avatar.startsWith("http")
      ? avatar
      : avatar
        ? `${SERVER_ORIGIN}${avatar.startsWith("/") ? "" : "/"}${avatar}`
        : null;

  const handlePress = () => {
    // Claim navigation so a concurrent path (push notification, etc.) can't also
    // mount the call screen and crash Fabric ("child already has a parent").
    if (!beginCallNavigation(activeCall.id, activeCall.conversation_id)) return;
    setActiveCall(null);
    router.push({
      pathname: "/call/[conversationId]",
      params: {
        conversationId: String(activeCall.conversation_id),
        mode: "reconnect",
        callType: isVideo ? "video" : "voice",
        callId: String(activeCall.id),
        peerId: activeCall.other_user_id
          ? String(activeCall.other_user_id)
          : "",
        peerName: name,
        peerAvatar: avatar || "",
      },
    });
  };

  return (
    <View
      pointerEvents="box-none"
      style={[styles.wrap, { top: insets.top + 6 }]}
    >
      <Pressable
        onPress={handlePress}
        style={[styles.banner, { backgroundColor: theme.success }]}
      >
        <View style={styles.left}>
          {avatarUrl ? (
            <Image source={{ uri: avatarUrl }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, styles.avatarFallback]}>
              {isVideo ? (
                <VideoIcon size={16} color="#fff" />
              ) : (
                <Phone size={16} color="#fff" />
              )}
            </View>
          )}
          <View style={{ flexShrink: 1 }}>
            <Text style={styles.title} numberOfLines={1}>
              Ongoing {isVideo ? "video" : "voice"} call
            </Text>
            <Text style={styles.subtitle} numberOfLines={1}>
              {name} · Tap to return
            </Text>
          </View>
        </View>
        <View style={styles.returnPill}>
          <Phone size={14} color="#fff" />
          <Text style={styles.returnText}>Return</Text>
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 50,
    elevation: 50,
    paddingHorizontal: 12,
  },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    width: "100%",
    maxWidth: 560,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  left: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flexShrink: 1,
  },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "rgba(255,255,255,0.25)",
  },
  avatarFallback: {
    alignItems: "center",
    justifyContent: "center",
  },
  title: { color: "#fff", fontSize: 14, fontWeight: "700" },
  subtitle: { color: "rgba(255,255,255,0.9)", fontSize: 12 },
  returnPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(0,0,0,0.2)",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  returnText: { color: "#fff", fontSize: 13, fontWeight: "700" },
});