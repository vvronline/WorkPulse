import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Pin, X as XIcon } from "../../icons";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";
import type { PinnedMessage } from "../../features";

/**
 * Pinned-messages banner shown at the top of the chat (mirrors the web
 * PinnedMessages banner). Shows the most recent pin + a count; tapping jumps
 * to it, the X unpins it.
 */
export default function PinnedBanner({
  latestPin,
  count,
  onJump,
  onUnpin,
}: {
  latestPin: PinnedMessage;
  count: number;
  onJump: (id: number) => void;
  onUnpin: (id: number) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  return (
    <Pressable style={styles.pinBanner} onPress={() => onJump(latestPin.id)}>
      <Pin size={15} color={theme.primary} />
      <View style={{ flex: 1 }}>
        <Text style={styles.pinBannerLabel} numberOfLines={1}>
          Pinned{count > 1 ? ` · ${count}` : ""}
          {latestPin.sender_name ? ` · ${latestPin.sender_name}` : ""}
        </Text>
        <Text style={styles.pinBannerText} numberOfLines={1}>
          {latestPin.content ||
            (latestPin.file_name
              ? `📎 ${latestPin.file_name}`
              : "🎤 Voice message")}
        </Text>
      </View>
      <Pressable hitSlop={8} onPress={() => onUnpin(latestPin.id)}>
        <XIcon size={16} color={theme.textSecondary} />
      </Pressable>
    </Pressable>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    pinBanner: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 14,
      paddingVertical: 8,
      backgroundColor: theme.bgSecondary,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    pinBannerLabel: {
      fontSize: 11,
      fontWeight: "700",
      color: theme.primaryLight,
    },
    pinBannerText: { fontSize: 13, color: theme.textSecondary },
  });