import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import {
  BellDot,
  MessageSquare,
  MessagesSquare,
  MoreVertical,
  Phone,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Pin,
  Search,
  Star,
  Trash2,
  Users,
  Video,
  X,
} from "lucide-react-native";
import { theme } from "../../src/theme";
import {
  deleteConversation,
  favouriteConversation,
  getAllCallHistory,
  getChatPresence,
  getConversations,
  pinConversation,
  searchChatUsers,
  startConversation,
  type CallLogEntry,
  type Conversation,
} from "../../src/features";
import { useAuth } from "../../src/auth/AuthContext";
import { socket } from "../../src/realtime/socket";
import ChatAvatar from "../../src/components/ChatAvatar";
import {
  useKeyboardInset,
  scrollFocusedIntoView,
} from "../../src/hooks/useKeyboardInset";

type Tab = "msgs" | "meetings" | "calls" | "unread";

type SearchUser = {
  id: number;
  username: string;
  full_name: string;
  avatar?: string | null;
};

function initials(name?: string | null) {
  if (!name) return "?";
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "?";
}

function timeAgo(iso?: string | null) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (isNaN(then)) return "";
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function callDuration(secs?: number): string | null {
  if (!secs) return null;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m === 0 ? `${s}s` : `${m}m${s > 0 ? ` ${s}s` : ""}`;
}

function convName(c: Conversation) {
  return c.is_group
    ? c.group_name || "Group"
    : c.other_full_name || c.other_username || "User";
}

export default function ChatScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const kbInset = useKeyboardInset();
  const [items, setItems] = useState<Conversation[]>([]);
  const [calls, setCalls] = useState<CallLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<Tab>("msgs");

  // Search (people) — mirrors web ≥2-char threshold.
  const [showSearch, setShowSearch] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchUser[]>([]);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Per-conversation action menu.
  const [menuConv, setMenuConv] = useState<Conversation | null>(null);

  // Live presence map for 1:1 conversation peers (userId → effective status).
  // Mirrors the web `userStatusMap` so chat avatars show a status badge.
  const [userStatusMap, setUserStatusMap] = useState<Record<number, string>>(
    {},
  );

  const loadPresence = useCallback(async (convs: Conversation[]) => {
    const ids = Array.from(
      new Set(
        convs
          .filter((c) => !c.is_group && c.other_user_id)
          .map((c) => c.other_user_id as number),
      ),
    );
    if (ids.length === 0) return;
    try {
      const { data } = await getChatPresence(ids);
      setUserStatusMap((prev) => {
        const nextMap = { ...prev };
        for (const [id, entry] of Object.entries(data || {})) {
          nextMap[Number(id)] = entry.userStatus;
        }
        return nextMap;
      });
    } catch {
      /* ignore */
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const { data } = await getConversations();
      setItems(data || []);
      loadPresence(data || []);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [loadPresence]);

  const loadCalls = useCallback(async () => {
    try {
      const { data } = await getAllCallHistory();
      setCalls(data || []);
    } catch {
      setCalls([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (tab === "calls") loadCalls();
  }, [tab, loadCalls]);

  useFocusEffect(
    useCallback(() => {
      load();
      const off = socket.subscribe((msg) => {
        if (msg.type === "chat_message") load();
        // Keep peer status badges live (mirrors web userStatusMap upkeep).
        if (msg.type === "user_status" && msg.data?.userId) {
          setUserStatusMap((prev) => ({
            ...prev,
            [msg.data.userId]: msg.data.effective,
          }));
        }
      });
      return off;
    }, [load]),
  );

  // Debounced people search.
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimer.current = setTimeout(() => {
      searchChatUsers(q)
        .then((r) => setResults(r.data || []))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [query]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
    if (tab === "calls") loadCalls();
  }, [load, loadCalls, tab]);

  function openConv(c: Conversation) {
    router.push({
      pathname: "/chat/[id]",
      params: {
        id: String(c.id),
        name: convName(c),
        avatar: c.is_group ? "" : c.other_avatar || "",
        peerId: !c.is_group && c.other_user_id ? String(c.other_user_id) : "",
        isGroup: c.is_group ? "1" : "",
      },
    });
  }

  // Call back from a history entry (mirrors the web Calls tab, where rows are
  // actionable). Group calls aren't supported by the 1:1 native call screen,
  // so for group entries we open the conversation's chat instead.
  function callBack(entry: CallLogEntry) {
    const outgoing = entry.caller_id === user?.id;
    const display = entry.is_group
      ? entry.group_name || "Group"
      : outgoing
        ? entry.other_name || "Unknown"
        : entry.caller_name || "Unknown";
    if (entry.is_group) {
      router.push({
        pathname: "/chat/[id]",
        params: {
          id: String(entry.conversation_id),
          name: display,
          isGroup: "1",
        },
      });
      return;
    }
    router.push({
      pathname: "/call/[conversationId]",
      params: {
        conversationId: String(entry.conversation_id),
        mode: "outgoing",
        callType: entry.call_type === "video" ? "video" : "voice",
        peerName: display,
      },
    });
  }

  async function startWithUser(u: SearchUser) {
    try {
      const { data } = await startConversation(u.id);
      // The server returns { conversationId }. Accept the legacy { id } shape
      // too, defensively — reading only `id` here was the bug that made every
      // search-result tap fail with "Could not open this conversation".
      const convId =
        (data as { conversationId?: number; id?: number })?.conversationId ??
        (data as { conversationId?: number; id?: number })?.id;
      if (!convId) {
        Alert.alert("Error", "Could not open this conversation.");
        return;
      }
      // Close the search UI first, then navigate on the next tick. Navigating
      // while the search ScrollView (keyboardShouldPersistTaps) is still
      // mounted could drop the press / race the route push, which is why
      // tapping a search result sometimes did nothing.
      setShowSearch(false);
      setQuery("");
      setResults([]);
      setTimeout(() => {
        router.push({
          pathname: "/chat/[id]",
          params: {
            id: String(convId),
            name: u.full_name || u.username,
            avatar: u.avatar || "",
            peerId: String(u.id),
          },
        });
      }, 0);
    } catch (e: any) {
      Alert.alert(
        "Error",
        e?.response?.data?.error || "Could not open this conversation.",
      );
    }
  }

  function doPin(c: Conversation) {
    setMenuConv(null);
    pinConversation(c.id).then(load).catch(() => {});
  }

  function doFav(c: Conversation) {
    setMenuConv(null);
    favouriteConversation(c.id).then(load).catch(() => {});
  }

  function doDelete(c: Conversation) {
    setMenuConv(null);
    deleteConversation(c.id)
      .then(() => setItems((prev) => prev.filter((x) => x.id !== c.id)))
      .catch(() => {});
  }

  // Derived lists (mirror web ChatSidebar grouping).
  const regular = items.filter((c) => !c.is_meeting_chat);
  const meetingConvs = items.filter((c) => c.is_meeting_chat);
  const unreadConvs = items.filter((c) => (c.unread_count || 0) > 0);
  const pinned = regular.filter((c) => c.is_pinned);
  const favourites = regular.filter((c) => c.is_favourite && !c.is_pinned);
  const others = regular.filter((c) => !c.is_pinned && !c.is_favourite);

  const totalUnread = items.reduce((s, c) => s + (c.unread_count || 0), 0);

  function renderConv(item: Conversation) {
    const name = convName(item);
    const preview = item.last_file_url
      ? "📎 Attachment"
      : item.last_message || "No messages yet";
    return (
      <Pressable
        key={item.id}
        style={styles.row}
        onPress={() => openConv(item)}
        android_ripple={{ color: theme.surfaceHover }}
      >
        <ChatAvatar
          name={name}
          avatar={item.is_group ? null : item.other_avatar}
          size={48}
          userStatus={
            !item.is_group && item.other_user_id
              ? userStatusMap[item.other_user_id]
              : undefined
          }
        />
        <View style={styles.body}>
          <View style={styles.rowTop}>
            <View style={styles.nameWrap}>
              {item.is_pinned ? (
                <Pin size={12} color={theme.textMuted} />
              ) : null}
              {item.is_favourite ? (
                <Star size={12} color={theme.warning} />
              ) : null}
              <Text style={styles.name} numberOfLines={1}>
                {name}
              </Text>
            </View>
            <Text style={styles.time}>{timeAgo(item.last_message_at)}</Text>
          </View>
          <View style={styles.rowBottom}>
            <Text style={styles.preview} numberOfLines={1}>
              {preview}
            </Text>
            {item.unread_count > 0 ? (
              <View style={styles.unread}>
                <Text style={styles.unreadText}>
                  {item.unread_count > 99 ? "99+" : item.unread_count}
                </Text>
              </View>
            ) : null}
          </View>
        </View>
        <Pressable
          style={styles.rowMore}
          hitSlop={8}
          onPress={() => setMenuConv(item)}
        >
          <MoreVertical size={18} color={theme.textMuted} />
        </Pressable>
      </Pressable>
    );
  }

  function renderSection(title: string, icon: React.ReactNode) {
    return (
      <View style={styles.section}>
        {icon}
        <Text style={styles.sectionText}>{title}</Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      {/* Header with search toggle */}
      <View style={styles.header}>
        {showSearch ? (
          <View style={styles.searchBar}>
            <Search size={16} color={theme.textMuted} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search people…"
              placeholderTextColor={theme.textMuted}
              value={query}
              onChangeText={setQuery}
              onFocus={scrollFocusedIntoView}
              autoFocus
              autoCapitalize="none"
            />
            <Pressable
              onPress={() => {
                setShowSearch(false);
                setQuery("");
              }}
              hitSlop={8}
            >
              <X size={18} color={theme.textSecondary} />
            </Pressable>
          </View>
        ) : (
          <>
            <Text style={styles.heading}>Chat</Text>
            <View style={styles.headerBtns}>
              <Pressable
                style={styles.headerIcon}
                onPress={() => setShowSearch(true)}
              >
                <Search size={20} color={theme.textSecondary} />
              </Pressable>
              <Pressable
                style={styles.headerIcon}
                onPress={() => router.push("/chat/new")}
              >
                <Users size={20} color={theme.textSecondary} />
              </Pressable>
            </View>
          </>
        )}
      </View>

      {/* Tabs */}
      {!showSearch ? (
        <View style={styles.tabs}>
          <TabButton
            active={tab === "msgs"}
            label="Messages"
            icon={<MessageSquare size={14} color={tab === "msgs" ? "#fff" : theme.textSecondary} />}
            badge={totalUnread}
            onPress={() => setTab("msgs")}
          />
          <TabButton
            active={tab === "meetings"}
            label="Meetings"
            icon={<Video size={14} color={tab === "meetings" ? "#fff" : theme.textSecondary} />}
            badge={meetingConvs.reduce((s, c) => s + (c.unread_count || 0), 0)}
            onPress={() => setTab("meetings")}
          />
          <TabButton
            active={tab === "calls"}
            label="Calls"
            icon={<Phone size={14} color={tab === "calls" ? "#fff" : theme.textSecondary} />}
            onPress={() => setTab("calls")}
          />
          <TabButton
            active={tab === "unread"}
            label="Unread"
            icon={<BellDot size={14} color={tab === "unread" ? "#fff" : theme.textSecondary} />}
            badge={unreadConvs.length}
            onPress={() => setTab("unread")}
          />
        </View>
      ) : null}

      {/* Search results */}
      {showSearch ? (
        <ScrollView
          contentContainerStyle={[
            styles.list,
            { paddingBottom: 32 + kbInset },
          ]}
          keyboardShouldPersistTaps="handled"
        >
          {query.trim().length < 2 ? (
            <Text style={styles.hint}>Type at least 2 characters to search.</Text>
          ) : searching ? (
            <Text style={styles.hint}>Searching…</Text>
          ) : results.length === 0 ? (
            <Text style={styles.hint}>No users found</Text>
          ) : (
            results.map((u) => (
              <Pressable
                key={u.id}
                style={styles.row}
                onPress={() => startWithUser(u)}
                android_ripple={{ color: theme.surfaceHover }}
              >
                <ChatAvatar
                  name={u.full_name}
                  avatar={u.avatar}
                  size={48}
                  userStatus={userStatusMap[u.id]}
                />
                <View style={styles.body}>
                  <Text style={styles.name} numberOfLines={1}>
                    {u.full_name}
                    {u.id === user?.id ? " (You)" : ""}
                  </Text>
                  <Text style={styles.preview} numberOfLines={1}>
                    @{u.username}
                  </Text>
                </View>
              </Pressable>
            ))
          )}
        </ScrollView>
      ) : tab === "calls" ? (
        <FlatList
          data={calls}
          keyExtractor={(c) => String(c.id)}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={theme.primary}
            />
          }
          renderItem={({ item }) => {
            const outgoing = item.caller_id === user?.id;
            const missed = item.status === "missed" && !outgoing;
            const display = item.is_group
              ? item.group_name || "Group"
              : outgoing
                ? item.other_name || "Unknown"
                : item.caller_name || "Unknown";
            return (
              <Pressable
                style={styles.row}
                onPress={() => callBack(item)}
                android_ripple={{ color: theme.surfaceHover }}
              >
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>{initials(display)}</Text>
                </View>
                <View style={styles.body}>
                  <Text style={styles.name} numberOfLines={1}>
                    {display}
                  </Text>
                  <View style={styles.callMeta}>
                    {missed ? (
                      <PhoneMissed size={13} color={theme.danger} />
                    ) : outgoing ? (
                      <PhoneOutgoing size={13} color={theme.success} />
                    ) : (
                      <PhoneIncoming size={13} color={theme.primary} />
                    )}
                    <Text
                      style={[
                        styles.callMetaText,
                        missed && { color: theme.danger },
                      ]}
                    >
                      {missed ? "Missed" : outgoing ? "Outgoing" : "Incoming"}
                      {item.call_type === "video" ? " video" : ""}
                      {item.duration
                        ? ` · ${callDuration(item.duration)}`
                        : ""}
                    </Text>
                  </View>
                </View>
                <View style={styles.callRight}>
                  <Text style={styles.time}>{timeAgo(item.created_at)}</Text>
                  {item.call_type === "video" ? (
                    <Video size={13} color={theme.textMuted} />
                  ) : (
                    <Phone size={13} color={theme.textMuted} />
                  )}
                </View>
              </Pressable>
            );
          }}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Phone size={40} color={theme.textMuted} />
              <Text style={styles.emptyText}>No calls yet</Text>
            </View>
          }
        />
      ) : (
        <ScrollView
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={theme.primary}
            />
          }
        >
          {tab === "msgs" ? (
            regular.length === 0 ? (
              <View style={styles.empty}>
                <MessagesSquare size={40} color={theme.textMuted} />
                <Text style={styles.emptyText}>No conversations yet</Text>
              </View>
            ) : (
              <>
                {pinned.length > 0 ? (
                  <>
                    {renderSection("Pinned", <Pin size={13} color={theme.textMuted} />)}
                    {pinned.map(renderConv)}
                  </>
                ) : null}
                {favourites.length > 0 ? (
                  <>
                    {renderSection("Favourites", <Star size={13} color={theme.warning} />)}
                    {favourites.map(renderConv)}
                  </>
                ) : null}
                {(pinned.length > 0 || favourites.length > 0) &&
                others.length > 0
                  ? renderSection(
                      "All Messages",
                      <MessageSquare size={13} color={theme.textMuted} />,
                    )
                  : null}
                {others.map(renderConv)}
              </>
            )
          ) : tab === "meetings" ? (
            meetingConvs.length === 0 ? (
              <View style={styles.empty}>
                <Video size={40} color={theme.textMuted} />
                <Text style={styles.emptyText}>No meeting chats yet</Text>
              </View>
            ) : (
              meetingConvs.map(renderConv)
            )
          ) : unreadConvs.length === 0 ? (
            <View style={styles.empty}>
              <BellDot size={40} color={theme.textMuted} />
              <Text style={styles.emptyText}>You&apos;re all caught up!</Text>
            </View>
          ) : (
            unreadConvs.map(renderConv)
          )}
        </ScrollView>
      )}

      {!showSearch ? (
        <Pressable style={styles.fab} onPress={() => router.push("/chat/new")}>
          <MessagesSquare size={22} color="#fff" />
        </Pressable>
      ) : null}

      {/* Per-conversation action menu */}
      <Modal
        visible={!!menuConv}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuConv(null)}
      >
        <Pressable style={styles.menuOverlay} onPress={() => setMenuConv(null)}>
          <View style={styles.menuSheet}>
            <Pressable
              style={styles.menuRow}
              onPress={() => menuConv && doPin(menuConv)}
            >
              <Pin size={18} color={theme.text} />
              <Text style={styles.menuText}>
                {menuConv?.is_pinned ? "Unpin" : "Pin"}
              </Text>
            </Pressable>
            <Pressable
              style={styles.menuRow}
              onPress={() => menuConv && doFav(menuConv)}
            >
              <Star size={18} color={theme.text} />
              <Text style={styles.menuText}>
                {menuConv?.is_favourite ? "Unfavourite" : "Favourite"}
              </Text>
            </Pressable>
            <Pressable
              style={styles.menuRow}
              onPress={() => menuConv && doDelete(menuConv)}
            >
              <Trash2 size={18} color={theme.danger} />
              <Text style={[styles.menuText, { color: theme.danger }]}>
                Delete
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

function TabButton({
  active,
  label,
  icon,
  badge,
  onPress,
}: {
  active: boolean;
  label: string;
  icon: React.ReactNode;
  badge?: number;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={[styles.tabBtn, active && styles.tabBtnActive]}
      onPress={onPress}
    >
      {icon}
      <Text style={[styles.tabText, active && styles.tabTextActive]}>
        {label}
      </Text>
      {badge && badge > 0 ? (
        <View style={styles.tabBadge}>
          <Text style={styles.tabBadgeText}>{badge > 99 ? "99+" : badge}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  center: { alignItems: "center", justifyContent: "center" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    minHeight: 52,
  },
  heading: {
    fontSize: 24,
    fontWeight: "800",
    color: theme.text,
    letterSpacing: -0.5,
  },
  headerBtns: { flexDirection: "row", gap: 6 },
  headerIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  searchBar: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: theme.inputBg,
    borderWidth: 1,
    borderColor: theme.inputBorder,
    borderRadius: theme.radiusFull,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  searchInput: { flex: 1, color: theme.text, fontSize: 15, paddingVertical: 0 },
  tabs: {
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  tabBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 8,
    borderRadius: theme.radiusFull,
    backgroundColor: theme.surface,
  },
  tabBtnActive: { backgroundColor: theme.primary },
  tabText: { fontSize: 12, color: theme.textSecondary, fontWeight: "600" },
  tabTextActive: { color: "#fff" },
  tabBadge: {
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: theme.danger,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  tabBadgeText: { color: "#fff", fontSize: 9, fontWeight: "700" },
  fab: {
    position: "absolute",
    right: 20,
    bottom: 24,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
    elevation: 4,
  },
  list: { paddingHorizontal: 16, paddingBottom: 90, gap: 2 },
  section: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingTop: 14,
    paddingBottom: 4,
  },
  sectionText: {
    fontSize: 12,
    fontWeight: "700",
    color: theme.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 4,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  body: { flex: 1, gap: 3 },
  rowTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  nameWrap: { flex: 1, flexDirection: "row", alignItems: "center", gap: 4 },
  name: { flex: 1, fontSize: 15, fontWeight: "600", color: theme.text },
  time: { fontSize: 11, color: theme.textMuted },
  rowBottom: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  preview: { flex: 1, fontSize: 13, color: theme.textSecondary },
  unread: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: theme.primary,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  unreadText: { color: "#fff", fontSize: 11, fontWeight: "700" },
  rowMore: { padding: 6 },
  callMeta: { flexDirection: "row", alignItems: "center", gap: 5 },
  callMetaText: { fontSize: 13, color: theme.textSecondary },
  callRight: { alignItems: "flex-end", gap: 4 },
  empty: { alignItems: "center", gap: 10, paddingTop: 80 },
  emptyText: { color: theme.textMuted, fontSize: 14 },
  hint: { color: theme.textMuted, fontSize: 13, paddingVertical: 16 },
  menuOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
  menuSheet: {
    backgroundColor: theme.bgElevated,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.glassBorder,
    paddingVertical: 6,
    minWidth: 200,
  },
  menuRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  menuText: { fontSize: 15, color: theme.text, fontWeight: "500" },
});