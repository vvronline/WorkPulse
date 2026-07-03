import { useMemo } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import {
  MessageSquare,
  Phone,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Video as VideoIcon,
} from "lucide-react-native";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import ChatAvatar from "../../src/components/ChatAvatar";
import GroupCompositeAvatar from "../../src/components/GroupCompositeAvatar";

/**
 * Call details screen (mirrors Signal-Android's CallInfoFragment). Opened by
 * tapping a row on the Calls tab. Shows WHO the call was with, its direction /
 * status / type / time / duration, and offers EXPLICIT call-back actions —
 * tapping a history row must never blind-dial the peer (that was the old
 * behaviour and made accidental calls trivially easy).
 *
 * All display data arrives via route params from the already-loaded call-log
 * entry (no extra fetch), exactly like the other chat info screens.
 */
export default function CallInfoScreen() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const params = useLocalSearchParams<{
    callId: string;
    conversationId: string;
    peerName?: string;
    peerAvatar?: string;
    isGroup?: string;
    groupMemberAvatars?: string;
    callType?: string;
    direction?: string; // "outgoing" | "incoming"
    status?: string; // answered | missed | declined | ended | ...
    duration?: string; // seconds
    createdAt?: string; // ISO timestamp
  }>();

  const conversationId = String(params.conversationId || "");
  const name = params.peerName || "Unknown";
  const avatar = params.peerAvatar || null;
  const isGroup = params.isGroup === "1";
  const isVideo = params.callType === "video";
  const outgoing = params.direction === "outgoing";
  const status = params.status || "";
  const missed = status === "missed" && !outgoing;
  const declined = status === "declined" || status === "rejected";
  const durationSecs = params.duration ? Number(params.duration) : 0;

  const groupMemberAvatars = useMemo(() => {
    if (!params.groupMemberAvatars) return [];
    try {
      const parsed = JSON.parse(params.groupMemberAvatars);
      return Array.isArray(parsed)
        ? parsed.filter(
            (v): v is string => typeof v === "string" && v.length > 0,
          )
        : [];
    } catch {
      return [];
    }
  }, [params.groupMemberAvatars]);

  const when = useMemo(() => {
    if (!params.createdAt) return "";
    const d = new Date(params.createdAt);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }, [params.createdAt]);

  const durationLabel = useMemo(() => {
    if (!durationSecs) return null;
    const m = Math.floor(durationSecs / 60);
    const s = durationSecs % 60;
    return m === 0 ? `${s}s` : `${m}m${s > 0 ? ` ${s}s` : ""}`;
  }, [durationSecs]);

  const statusLabel = missed
    ? "Missed call"
    : declined
      ? "Declined call"
      : outgoing
        ? "Outgoing call"
        : "Incoming call";

  const DirectionIcon = missed
    ? PhoneMissed
    : outgoing
      ? PhoneOutgoing
      : PhoneIncoming;
  const directionColor = missed
    ? theme.danger
    : outgoing
      ? theme.success
      : theme.primary;

  // Explicit call-back. This is the ONLY place a call is initiated from the
  // Calls-tab flow (plus the per-row quick call icon) — never a bare row tap.
  const startCall = (type: "voice" | "video") => {
    // GUARD: route params are strings, so a null/undefined conversation_id
    // upstream serialises to the literal "null"/"undefined" — which passed the
    // old truthy check, became NaN on the call screen, and made the server
    // silently drop call_initiate (caller rang forever, receiver never rang).
    const convIdNum = Number(conversationId);
    if (!conversationId || !Number.isFinite(convIdNum) || convIdNum <= 0) {
      Alert.alert(
        "Cannot call",
        "This call's conversation no longer exists. Start a new chat to call them.",
      );
      return;
    }
    router.push({
      pathname: "/call/[conversationId]",
      params: {
        conversationId,
        mode: "outgoing",
        callType: type,
        peerName: name,
        peerAvatar: avatar || "",
        isGroup: isGroup ? "1" : "0",
      },
    });
  };

  const openChat = () => {
    if (!conversationId) return;
    const chatParams: Record<string, string> = {
      id: conversationId,
      name,
    };
    if (isGroup) chatParams.isGroup = "1";
    else if (avatar) chatParams.avatar = avatar;
    router.push({ pathname: "/chat/[id]", params: chatParams });
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: "Call info" }} />

      {/* Peer identity header. */}
      <View style={styles.header}>
        {isGroup ? (
          <GroupCompositeAvatar
            name={name}
            memberAvatars={groupMemberAvatars}
            size={88}
          />
        ) : (
          <ChatAvatar name={name} avatar={avatar} size={88} />
        )}
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
      </View>

      {/* Quick actions — Signal parity: explicit Voice / Video / Message. */}
      <View style={styles.quickRow}>
        <QuickAction
          icon={<Phone size={22} color={theme.primary} />}
          label="Voice call"
          onPress={() => startCall("voice")}
          styles={styles}
        />
        <QuickAction
          icon={<VideoIcon size={22} color={theme.primary} />}
          label="Video call"
          onPress={() => startCall("video")}
          styles={styles}
        />
        <QuickAction
          icon={<MessageSquare size={22} color={theme.primary} />}
          label="Message"
          onPress={openChat}
          styles={styles}
        />
      </View>

      {/* Call details card. */}
      <View style={styles.section}>
        <View style={styles.detailRow}>
          <DirectionIcon size={20} color={directionColor} />
          <View style={styles.detailBody}>
            <Text
              style={[
                styles.detailTitle,
                missed && { color: theme.danger },
              ]}
            >
              {statusLabel}
              {isVideo ? " · Video" : ""}
            </Text>
            <Text style={styles.detailSub}>
              {when}
              {durationLabel ? ` · ${durationLabel}` : ""}
            </Text>
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

function QuickAction({
  icon,
  label,
  onPress,
  styles,
}: {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <Pressable style={styles.quickAction} onPress={onPress}>
      <View style={styles.quickIcon}>{icon}</View>
      <Text style={styles.quickLabel}>{label}</Text>
    </Pressable>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.bg },
    content: { paddingBottom: 40 },
    header: {
      alignItems: "center",
      paddingTop: 28,
      paddingBottom: 20,
    },
    name: {
      fontSize: 22,
      color: theme.text,
      fontFamily: theme.fontBold,
      marginTop: 14,
      maxWidth: "80%",
    },
    quickRow: {
      flexDirection: "row",
      justifyContent: "center",
      gap: 28,
      paddingVertical: 10,
      marginBottom: 16,
    },
    quickAction: { alignItems: "center", gap: 8 },
    quickIcon: {
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      alignItems: "center",
      justifyContent: "center",
    },
    quickLabel: { fontSize: 12, color: theme.textSecondary },
    section: {
      marginHorizontal: 16,
      backgroundColor: theme.cardBg,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: theme.glassBorder,
      overflow: "hidden",
    },
    detailRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      paddingHorizontal: 16,
      paddingVertical: 16,
    },
    detailBody: { flex: 1, gap: 3 },
    detailTitle: {
      fontSize: 15,
      color: theme.text,
      fontFamily: theme.fontMedium,
    },
    detailSub: { fontSize: 13, color: theme.textSecondary },
  });