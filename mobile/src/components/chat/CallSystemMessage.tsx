import { useMemo } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import {
  PhoneIncoming,
  PhoneMissed,
  PhoneOff,
  PhoneOutgoing,
  Video,
} from "lucide-react-native";
import { useTheme } from "../../theme/ThemeProvider";
import type { Theme } from "../../theme";
import type { ChatMessage } from "../../features";

type Props = {
  message: ChatMessage;
  userId?: number | string;
  onCallBack?: (type: "voice" | "video") => void;
};

function fmtDuration(secs?: number | null): string | null {
  if (!secs || secs <= 0) return null;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${String(m % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Signal-style inline call-history row rendered in the conversation thread for a
 * `system` message whose `metadata.type === "call"`. Shows the call direction,
 * type (voice/video), status and (for answered calls) the duration. Tapping the
 * row redials with the same media type.
 */
export default function CallSystemMessage({
  message,
  userId,
  onCallBack,
}: Props) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const meta = message.metadata || {};
  const isVideo = meta.callType === "video";
  const outgoing = Number(meta.callerId) === Number(userId);
  const status = meta.status || "ended";
  const duration = fmtDuration(meta.duration);

  // Confirm before redialing so an accidental tap on a history row never places
  // an unexpected call (mirrors Signal's call-back affordance).
  function confirmCallBack() {
    if (!onCallBack) return;
    const kind = isVideo ? "video" : "voice";
    Alert.alert(
      `Call back?`,
      `Start a new ${kind} call?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: isVideo ? "Video call" : "Call",
          onPress: () => onCallBack(isVideo ? "video" : "voice"),
        },
      ],
      { cancelable: true },
    );
  }

  let label: string;
  let danger = false;
  let Icon = outgoing ? PhoneOutgoing : PhoneIncoming;

  if (status === "missed") {
    danger = true;
    Icon = PhoneMissed;
    label = outgoing
      ? `No answer · ${isVideo ? "Video" : "Voice"} call`
      : `Missed ${isVideo ? "video" : "voice"} call`;
  } else if (status === "declined") {
    Icon = PhoneOff;
    label = outgoing
      ? `${isVideo ? "Video" : "Voice"} call declined`
      : `Declined ${isVideo ? "video" : "voice"} call`;
  } else {
    label = `${outgoing ? "Outgoing" : "Incoming"} ${isVideo ? "video" : "voice"} call`;
  }

  return (
    <View style={styles.wrap}>
      <Pressable style={styles.pill} onPress={confirmCallBack} hitSlop={6}>
        <View style={[styles.iconWrap, danger ? styles.iconWrapDanger : null]}>
          {isVideo && status !== "missed" && status !== "declined" ? (
            <Video size={15} color={theme.textSecondary} />
          ) : (
            <Icon
              size={15}
              color={danger ? theme.danger : theme.textSecondary}
            />
          )}
        </View>
        <Text
          style={[styles.label, danger ? styles.labelDanger : null]}
          numberOfLines={1}
        >
          {label}
        </Text>
        {duration ? <Text style={styles.duration}>{duration}</Text> : null}
      </Pressable>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    wrap: {
      alignItems: "center",
      paddingVertical: 6,
      paddingHorizontal: 12,
    },
    pill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      maxWidth: "88%",
      backgroundColor: theme.surface,
      borderRadius: 18,
      paddingVertical: 7,
      paddingHorizontal: 12,
    },
    iconWrap: {
      width: 24,
      height: 24,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.surfaceHover,
    },
    iconWrapDanger: {
      backgroundColor: "rgba(224,62,62,0.16)",
    },
    label: {
      color: theme.textSecondary,
      fontSize: 13,
      fontFamily: theme.fontMedium,
      flexShrink: 1,
    },
    labelDanger: { color: theme.danger },
    duration: {
      color: theme.textMuted,
      fontSize: 12,
      fontFamily: theme.fontRegular,
    },
  });
