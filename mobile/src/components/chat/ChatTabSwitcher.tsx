import { useEffect, useMemo, useRef } from "react";
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { MessageSquare, Phone, Search, Video, X } from "lucide-react-native";
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
  searchOpen,
  searchQuery,
  style,
  onChange,
  onSearchQueryChange,
  onSearchOpenChange,
}: {
  activeTab: ChatListTab;
  meetingsEnabled: boolean;
  totalUnread: number;
  meetingUnread: number;
  searchOpen: boolean;
  searchQuery: string;
  style?: StyleProp<ViewStyle>;
  onChange: (tab: ChatListTab) => void;
  onSearchQueryChange: (text: string) => void;
  onSearchOpenChange: (open: boolean) => void;
}) {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  // `progress` drives native-driver visuals (opacity / transform). `layout`
  // drives the inline morph between tab rail and search field.
  const progress = useRef(new Animated.Value(searchOpen ? 1 : 0)).current;
  const searchInputRef = useRef<TextInput | null>(null);

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

  useEffect(() => {
    Animated.timing(progress, {
      toValue: searchOpen ? 1 : 0,
      duration: searchOpen ? 220 : 180,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [progress, searchOpen]);

  useEffect(() => {
    if (!searchOpen) {
      searchInputRef.current?.blur();
      return;
    }
    const t = setTimeout(() => searchInputRef.current?.focus(), 140);
    return () => clearTimeout(t);
  }, [searchOpen]);

  const tabsOpacity = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 0],
  });
  const tabsScale = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 0.97],
  });
  const tabsTranslateX = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -14],
  });
  const searchOpacity = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1],
  });
  const searchTranslateX = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [14, 0],
  });
  const searchScale = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [0.97, 1],
  });
  const triggerOpacity = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 0],
  });

  return (
    <View style={style}>
      <View style={styles.rail}>
        <Animated.View
          pointerEvents={searchOpen ? "none" : "auto"}
          style={[
            styles.tabsWrap,
            {
              opacity: tabsOpacity,
              transform: [{ scale: tabsScale }, { translateX: tabsTranslateX }],
            },
          ]}
        >
          {tabs.map((tab) => {
            const active = tab.id === activeTab;
            const iconColor = active
              ? theme.chatSegmentTextActive
              : theme.chatSegmentText;
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
                <View
                  style={[
                    styles.tabInner,
                    tab.badge && tab.badge > 0 ? styles.tabInnerWithBadge : null,
                  ]}
                >
                  {tab.id === "msgs" ? (
                    <MessageSquare size={14} color={iconColor} />
                  ) : tab.id === "meetings" ? (
                    <Video size={14} color={iconColor} />
                  ) : (
                    <Phone size={14} color={iconColor} />
                  )}
                  <Text
                    style={[styles.tabLabel, active && styles.tabLabelActive]}
                    numberOfLines={1}
                  >
                    {tab.label}
                  </Text>
                </View>
                {tab.badge && tab.badge > 0 ? (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>
                      {tab.badge > 99 ? "99+" : tab.badge}
                    </Text>
                  </View>
                ) : null}
              </Pressable>
            );
          })}
        </Animated.View>
        <Animated.View
          pointerEvents={searchOpen ? "auto" : "none"}
          style={{
            ...styles.searchInlineWrap,
            opacity: searchOpacity,
            transform: [{ translateX: searchTranslateX }, { scale: searchScale }],
          }}
        >
          <View style={styles.searchField}>
            <Search size={15} color={theme.textMuted} />
            <TextInput
              ref={searchInputRef}
              value={searchQuery}
              onChangeText={onSearchQueryChange}
              placeholder="Search chats"
              placeholderTextColor={theme.textMuted}
              style={styles.searchInput}
              autoCapitalize="none"
              returnKeyType="search"
            />
            <Pressable
              onPress={() => {
                if (searchQuery.trim()) {
                  onSearchQueryChange("");
                  return;
                }
                onSearchOpenChange(false);
              }}
              hitSlop={8}
            >
              <X size={16} color={theme.textSecondary} />
            </Pressable>
          </View>
        </Animated.View>
        <Animated.View
          pointerEvents={searchOpen ? "none" : "auto"}
          style={{ opacity: triggerOpacity }}
        >
          <Pressable
            style={({ pressed }) => [
              styles.searchBtn,
              searchOpen && styles.searchBtnActive,
              pressed && styles.tabPressed,
            ]}
            onPress={() => onSearchOpenChange(true)}
            hitSlop={8}
          >
            <Search size={16} color={theme.chatSegmentText} />
          </Pressable>
        </Animated.View>
      </View>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    rail: {
      position: "relative",
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      padding: 6,
      borderRadius: 18,
      backgroundColor: theme.chatSegmentSurface,
    },
    tabsWrap: {
      flex: 1,
      flexDirection: "row",
      gap: 6,
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
      overflow: "hidden",
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
    },
    tabInnerWithBadge: {
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
    searchBtn: {
      width: 42,
      height: 42,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.chatHeaderSurface,
    },
    searchBtnActive: {
      backgroundColor: theme.chatSegmentActiveSurface,
      borderColor: theme.chatSegmentActiveBorder,
    },
    searchInlineWrap: {
      position: "absolute",
      left: 6,
      right: 6,
      top: 6,
      bottom: 6,
      justifyContent: "center",
    },
    searchField: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      minHeight: 42,
      borderRadius: 12,
      backgroundColor: theme.chatHeaderSurface,
      paddingHorizontal: 12,
    },
    searchInput: {
      flex: 1,
      color: theme.text,
      fontSize: 14,
      paddingVertical: 0,
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
