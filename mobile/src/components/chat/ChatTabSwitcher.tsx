import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { MessageSquare, Phone, Video } from "lucide-react-native";
import type { Theme } from "../../theme";
import { useTheme } from "../../theme/ThemeProvider";

export type ChatListTab = "msgs" | "meetings" | "calls";

type TabMeta = {
  id: ChatListTab;
  label: string;
  badge?: number;
};

export default function ChatTabSwitcher({
  activeTab,
  meetingsEnabled,
  totalUnread,
  meetingUnread,
  style,
  onChange,
}: {
  activeTab: ChatListTab;
  meetingsEnabled: boolean;
  totalUnread: number;
  meetingUnread: number;
  style?: StyleProp<ViewStyle>;
  onChange: (tab: ChatListTab) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);

  const tabs = useMemo<TabMeta[]>(
    () =>
      [
        { id: "msgs", label: "Chat", badge: totalUnread },
        meetingsEnabled
          ? { id: "meetings", label: "Meet", badge: meetingUnread }
          : null,
        { id: "calls", label: "Calls" },
      ].filter(Boolean) as TabMeta[],
    [meetingsEnabled, meetingUnread, totalUnread],
  );

  return (
    <View style={[styles.rail, style]}>
      {tabs.map((tab) => {
        const active = tab.id === activeTab;
        const iconColor = active ? theme.chatSegmentTextActive : theme.chatSegmentText;
        return (
          <Pressable
            key={tab.id}
            style={({ pressed }) => [
              styles.tab,
              active && styles.tabActive,
              pressed && styles.tabPressed,
            ]}
            onPress={() => onChange(tab.id)}
          >
            {active ? <View style={styles.activeIndicator} /> : null}
            <View style={styles.tabInner}>
              {tab.id === "msgs" ? (
                <MessageSquare size={14} color={iconColor} />
              ) : tab.id === "meetings" ? (
                <Video size={14} color={iconColor} />
              ) : (
                <Phone size={14} color={iconColor} />
              )}
              <Text style={[styles.tabLabel, active && styles.tabLabelActive]} numberOfLines={1}>
                {tab.label}
              </Text>
            </View>
            {tab.badge && tab.badge > 0 ? (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{tab.badge > 99 ? "99+" : tab.badge}</Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    rail: {
      flexDirection: "row",
      gap: 6,
      padding: 6,
      borderRadius: 18,
      backgroundColor: theme.chatSegmentSurface,
      borderWidth: 1,
      borderColor: theme.chatSegmentBorder,
    },
    tab: {
      flex: 1,
      minHeight: 42,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: "transparent",
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 8,
      position: "relative",
    },
    tabActive: {
      backgroundColor: theme.chatSegmentActiveSurface,
      borderColor: theme.chatSegmentActiveBorder,
    },
    tabPressed: {
      backgroundColor: theme.chatRowPressed,
    },
    tabInner: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 4,
      paddingRight: 8,
    },
    tabLabel: {
      color: theme.chatSegmentText,
      fontSize: 12,
      fontWeight: "700",
      flexShrink: 1,
    },
    tabLabelActive: {
      color: theme.chatSegmentTextActive,
    },
    activeIndicator: {
      position: "absolute",
      left: 12,
      right: 12,
      bottom: 3,
      height: 2,
      borderRadius: 999,
      backgroundColor: theme.chatSegmentActiveIndicator,
    },
    badge: {
      position: "absolute",
      top: 4,
      right: 4,
      minWidth: 16,
      height: 16,
      borderRadius: 8,
      paddingHorizontal: 4,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.chatTabBadgeBg,
      borderWidth: 1,
      borderColor: theme.chatTabBadgeBorder,
    },
    badgeText: {
      color: "#fff",
      fontSize: 9,
      fontWeight: "700",
    },
  });
