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
  // drives the JS-driven height + margin collapse — they MUST be separate
  // Animated.Values because a single node can't mix native and layout drivers.
  const progress = useRef(new Animated.Value(searchOpen ? 1 : 0)).current;
  const layout = useRef(new Animated.Value(searchOpen ? 1 : 0)).current;
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
    Animated.parallel([
      Animated.timing(progress, {
        toValue: searchOpen ? 1 : 0,
        duration: searchOpen ? 220 : 180,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      // Height/margin can't run on the native driver — animate on JS so the
      // panel physically collapses (no invisible band) when search is closed.
      Animated.timing(layout, {
        toValue: searchOpen ? 1 : 0,
        duration: searchOpen ? 220 : 180,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }),
    ]).start();
  }, [progress, layout, searchOpen]);

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
    outputRange: [1, 0.72],
  });
  const tabsScale = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 0.985],
  });
  const searchTranslateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [-8, 0],
  });
  // Collapse the search panel's height (and its top margin) when closed so it
  // never occupies an invisible band that pushes the conversation list down.
  // The field is ~42px tall; the panel adds an 8px top margin when expanded.
  const searchPanelHeight = layout.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 42],
  });
  const searchPanelMarginTop = layout.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 8],
  });

  return (
    <View style={style}>
      <View style={styles.rail}>
        <Animated.View
          style={[
            styles.tabsWrap,
            {
              opacity: tabsOpacity,
              transform: [{ scale: tabsScale }],
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
        <Pressable
          style={({ pressed }) => [
            styles.searchBtn,
            searchOpen && styles.searchBtnActive,
            pressed && styles.tabPressed,
          ]}
          onPress={() => onSearchOpenChange(!searchOpen)}
          hitSlop={8}
        >
          {searchOpen ? (
            <X size={16} color={theme.chatSegmentTextActive} />
          ) : (
            <Search size={16} color={theme.chatSegmentText} />
          )}
        </Pressable>
      </View>
      {/* Outer node: JS-driven height/margin collapse only. A single Animated
          node can't mix native + JS drivers, so the native-driven opacity /
          translateY live on the INNER node below. */}
      <Animated.View
        pointerEvents={searchOpen ? "auto" : "none"}
        style={[
          styles.searchPanel,
          {
            height: searchPanelHeight,
            marginTop: searchPanelMarginTop,
          },
        ]}
      >
        {/* Inner node: native-driven fade + slide. */}
        <Animated.View
          style={{
            opacity: progress,
            transform: [{ translateY: searchTranslateY }],
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
            {searchQuery.trim() ? (
              <Pressable onPress={() => onSearchQueryChange("")} hitSlop={8}>
                <X size={16} color={theme.textSecondary} />
              </Pressable>
            ) : (
              <View style={styles.searchClearSpacer} />
            )}
          </View>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    rail: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      padding: 6,
      borderRadius: 18,
      backgroundColor: theme.chatSegmentSurface,
      borderWidth: 1,
      borderColor: theme.chatSegmentBorder,
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
      borderWidth: 1,
      borderColor: "transparent",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.chatHeaderSurface,
    },
    searchBtnActive: {
      backgroundColor: theme.chatSegmentActiveSurface,
      borderColor: theme.chatSegmentActiveBorder,
    },
    searchPanel: {
      overflow: "hidden",
    },
    searchField: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      minHeight: 42,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.chatSegmentBorder,
      backgroundColor: theme.chatHeaderSurface,
      paddingHorizontal: 12,
    },
    searchInput: {
      flex: 1,
      color: theme.text,
      fontSize: 14,
      paddingVertical: 0,
    },
    searchClearSpacer: {
      width: 16,
      height: 16,
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
