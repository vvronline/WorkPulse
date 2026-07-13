import { useMemo } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import {
  ChevronRight,
  FolderOpen,
  Phone,
  Pin,
  Search,
  Settings,
  Star,
  Video as VideoIcon,
} from "../../src/icons";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import ChatAvatar from "../../src/components/ChatAvatar";
import GroupCompositeAvatar from "../../src/components/GroupCompositeAvatar";
import { STATUS_LABEL, WORK_MODE_LABEL } from "../../src/components/chat/chatUtils";

// Coloured dot next to the office/remote badge (green = office, blue = remote,
// amber = hybrid). Mirrors the web ChatHeader.
const WORK_MODE_COLOR: Record<string, string> = {
  office: "#16a34a",
  remote: "#2563eb",
  hybrid: "#d97706",
};

/**
 * Conversation profile / settings screen (mirrors Signal-Android's
 * ConversationSettingsFragment). Opened by tapping the chat header. Provides
 * the large avatar + name, quick call/search actions, and entry points to the
 * shared-media gallery, pinned and saved messages.
 */
export default function ChatInfo() {
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const params = useLocalSearchParams<{
    id: string;
    name?: string;
    avatar?: string;
    peerId?: string;
    isGroup?: string;
    groupMemberAvatars?: string;
    peerStatus?: string;
    peerWorkMode?: string;
    memberCount?: string;
    myRole?: string;
    description?: string;
  }>();

  const convId = Number(params.id);
  const name = params.name || "Chat";
  const avatar = params.avatar || null;
  const isGroup = params.isGroup === "1";
  const groupMemberAvatars = useMemo(() => {
    if (!params.groupMemberAvatars) return [];
    try {
      const parsed = JSON.parse(params.groupMemberAvatars);
      return Array.isArray(parsed)
        ? parsed.filter((v): v is string => typeof v === "string" && v.length > 0)
        : [];
    } catch {
      return [];
    }
  }, [params.groupMemberAvatars]);
  const peerStatus = params.peerStatus || null;
  const peerWorkMode = params.peerWorkMode || null;
  const memberCount = params.memberCount ? Number(params.memberCount) : 0;
  const myRole = params.myRole || "member";
  const description = params.description || "";

  const subtitle = isGroup
    ? memberCount
      ? `${memberCount} members`
      : "Group"
    : peerStatus
      ? STATUS_LABEL[peerStatus] || peerStatus
      : "";

  const goToMedia = (tab: "media" | "files" | "links") =>
    router.push({
      pathname: "/chat/shared",
      params: { id: String(convId), name, tab },
    });

  const goToSearch = () =>
    router.push({
      pathname: "/chat/search",
      params: { id: String(convId), name },
    });

  const goToPinned = () =>
    router.push({
      pathname: "/chat/saved",
      params: { id: String(convId), name, mode: "pinned" },
    });

  const goToSaved = () =>
    router.push({
      pathname: "/chat/saved",
      params: { id: String(convId), name, mode: "saved" },
    });

  const goToGroupSettings = () =>
    router.push({
      pathname: "/chat/group",
      params: {
        id: String(convId),
        name,
        description,
        myRole,
      },
    });

  const startCall = (type: "voice" | "video") =>
    router.push({
      pathname: "/call/[conversationId]",
      params: {
        conversationId: String(convId),
        mode: "outgoing",
        callType: type,
        peerName: name,
        peerAvatar: avatar || "",
        isGroup: isGroup ? "1" : "0",
      },
    });

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: "Conversation info" }} />

      {/* Profile header. */}
      <View style={styles.header}>
        {isGroup ? (
          <GroupCompositeAvatar
            name={name}
            avatar={avatar}
            memberAvatars={groupMemberAvatars}
            size={88}
          />
        ) : (
          <ChatAvatar name={name} avatar={avatar} size={88} />
        )}
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        {!isGroup && peerWorkMode && WORK_MODE_LABEL[peerWorkMode] ? (
          <View style={styles.workModeBadge}>
            <View
              style={[
                styles.workModeDot,
                {
                  backgroundColor:
                    WORK_MODE_COLOR[peerWorkMode] || "#16a34a",
                },
              ]}
            />
            <Text style={styles.workModeText}>
              {WORK_MODE_LABEL[peerWorkMode]}
            </Text>
          </View>
        ) : null}
      </View>

      {/* Quick actions. Call/Video are available for 1:1 AND group chats —
          the native call screen connects the first member to answer (parity
          with the chat header + web). */}
      <View style={styles.quickRow}>
        <QuickAction
          icon={<Phone size={22} color={theme.primary} />}
          label="Call"
          onPress={() => startCall("voice")}
          styles={styles}
        />
        <QuickAction
          icon={<VideoIcon size={22} color={theme.primary} />}
          label="Video"
          onPress={() => startCall("video")}
          styles={styles}
        />
        <QuickAction
          icon={<Search size={22} color={theme.primary} />}
          label="Search"
          onPress={goToSearch}
          styles={styles}
        />
      </View>

      {/* Section: group management (groups only). */}
      {isGroup && (
        <View style={styles.section}>
          <SettingRow
            icon={<Settings size={20} color={theme.text} />}
            label="Group settings & members"
            onPress={goToGroupSettings}
            styles={styles}
            theme={theme}
            last
          />
        </View>
      )}

      {/* Section: shared content. */}
      <View style={styles.section}>
        <SettingRow
          icon={<FolderOpen size={20} color={theme.text} />}
          label="Shared media, files & links"
          onPress={() => goToMedia("media")}
          styles={styles}
          theme={theme}
        />
        <SettingRow
          icon={<Pin size={20} color={theme.text} />}
          label="Pinned messages"
          onPress={goToPinned}
          styles={styles}
          theme={theme}
        />
        <SettingRow
          icon={<Star size={20} color={theme.text} />}
          label="Saved messages"
          onPress={goToSaved}
          styles={styles}
          theme={theme}
          last
        />
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

function SettingRow({
  icon,
  label,
  onPress,
  styles,
  theme,
  last,
}: {
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  styles: ReturnType<typeof makeStyles>;
  theme: Theme;
  last?: boolean;
}) {
  return (
    <Pressable
      style={[styles.settingRow, last && { borderBottomWidth: 0 }]}
      onPress={onPress}
    >
      {icon}
      <Text style={styles.settingLabel}>{label}</Text>
      <ChevronRight size={18} color={theme.textMuted} />
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
    subtitle: {
      fontSize: 14,
      color: theme.textSecondary,
      marginTop: 4,
    },
    // Office/remote badge under the name (whether the peer is currently logged
    // in from the office or working remotely, from today's attendance clock-in).
    workModeBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      marginTop: 8,
      paddingVertical: 3,
      paddingHorizontal: 10,
      borderRadius: 999,
      backgroundColor: theme.surface,
      borderWidth: 1,
      borderColor: theme.border,
    },
    workModeDot: {
      width: 7,
      height: 7,
      borderRadius: 3.5,
    },
    workModeText: {
      fontSize: 12,
      color: theme.textSecondary,
      fontFamily: theme.fontMedium,
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
    settingRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      paddingHorizontal: 16,
      paddingVertical: 16,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    settingLabel: {
      flex: 1,
      fontSize: 15,
      color: theme.text,
      fontFamily: theme.fontMedium,
    },
  });