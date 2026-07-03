import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { FlashList } from "@shopify/flash-list";
import Svg, { Circle as SvgCircle, Path as SvgPath } from "react-native-svg";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import {
  Archive,
  BellDot,
  BellOff,
  Check,
  CheckCircle2,
  Circle,
  FileText,
  Film,
  Image as ImageIcon,
  ListChecks,
  MailOpen,
  MessageSquare,
  MessagesSquare,
  Mic,
  Phone,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Pin,
  Star,
  Trash2,
  Users,
  Video,
  X,
} from "../../src/icons";
import type { Theme } from "../../src/theme";
import { useTheme } from "../../src/theme/ThemeProvider";
import {
  archiveConversation,
  deleteCalls,
  deleteConversation,
  favouriteConversation,
  getAllCallHistory,
  getChatPresence,
  getConversations,
  getMessages,
  markConversationRead,
  markConversationUnread,
  muteConversation,
  pinConversation,
  searchChatUsers,
  startConversation,
  type CallLogEntry,
  type Conversation,
} from "../../src/features";
import { useAuth, userHasFeature } from "../../src/auth/AuthContext";
import { socket } from "../../src/realtime/socket";
import {
  getCachedConversations,
  getCachedMessages,
  setCachedMessages,
  setCachedConversations,
} from "../../src/storage/chatCache";
import ChatAvatar from "../../src/components/ChatAvatar";
import GroupCompositeAvatar from "../../src/components/GroupCompositeAvatar";
import ChatTabSwitcher from "../../src/components/chat/ChatTabSwitcher";
import ConfirmDialog from "../../src/components/ConfirmDialog";

type Tab = "msgs" | "meetings" | "calls";

// A flattened row for the virtualized conversation list. Section headers and
// conversation rows share one array so FlashList can recycle them efficiently
// (FlashList doesn't take a ScrollView's mapped children — it needs flat data).
type ListRow =
  | {
      kind: "section";
      key: string;
      title: string;
      icon: "pin" | "star" | "msg";
    }
  | { kind: "conv"; key: string; conv: Conversation };

type SearchUser = {
  id: number;
  username: string;
  full_name: string;
  email?: string | null;
  avatar?: string | null;
};

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
  const theme = useTheme();
  const styles = useMemo(() => makeStyles(theme), [theme]);
  const router = useRouter();
  const params = useLocalSearchParams<{ openConversationId?: string }>();
  const { user } = useAuth();
  // Meetings chat is gated behind the `meetings` plan feature (mirrors the web
  // ChatSidebar, which only renders the Meetings tab when it's enabled).
  const meetingsEnabled = userHasFeature(user, "meetings");
  // Seed the conversation list from the on-device cache SYNCHRONOUSLY so the
  // list paints instantly (Signal-style) instead of blocking on a spinner.
  // `load()` revalidates in the background. The spinner only shows on a true
  // cold cache (first-ever launch before any list has been fetched).
  const cachedConvs = useMemo(() => getCachedConversations(), []);
  const [items, setItems] = useState<Conversation[]>(() => cachedConvs || []);
  const [calls, setCalls] = useState<CallLogEntry[]>([]);
  const [loading, setLoading] = useState(
    () => !cachedConvs || cachedConvs.length === 0,
  );
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<Tab>("msgs");
  // Coalesce bursts of `chat_message` WS events into a single background
  // refresh (a busy conversation used to trigger a full getConversations()
  // fetch PER message). The ref holds the pending debounce timer.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openedFromLaunchParamRef = useRef<string | null>(null);

  // Signal-style in-place search: the list stays visible while filtering.
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchUser[]>([]);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Per-conversation action menu.
  const [menuConv, setMenuConv] = useState<Conversation | null>(null);

  // Signal-style multi-select. `selectionMode` flips the list into selection
  // behaviour (tap toggles a row instead of opening it) and swaps the header
  // for a selection action bar. `selectedIds` holds the chosen row ids (conv
  // ids for Chat/Meet, call-log ids for Calls). `confirmDelete` gates the
  // themed confirmation dialog before a bulk delete runs.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

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

  // After the list loads, warm the message cache for the few most-recent
  // conversations in the BACKGROUND (Signal prefetches recent threads). Tapping
  // one then paints instantly from disk with no spinner. Bounded + best-effort
  // so it never delays the list or hammers the server. Only fills cold entries.
  const prefetchRecent = useCallback((convs: Conversation[]) => {
    const recent = [...convs]
      .filter((c) => !c.is_meeting_chat)
      .sort(
        (a, b) =>
          new Date(b.last_message_at || 0).getTime() -
          new Date(a.last_message_at || 0).getTime(),
      )
      .slice(0, 5);
    recent.forEach((c) => {
      if (getCachedMessages(c.id)) return; // already warm
      getMessages(c.id)
        .then((r) => setCachedMessages(c.id, r.data || []))
        .catch(() => {});
    });
  }, []);

  const load = useCallback(async () => {
    try {
      const { data } = await getConversations();
      setItems(data || []);
      // Persist so the next launch / tab return paints instantly from disk.
      setCachedConversations(data || []);
      loadPresence(data || []);
      prefetchRecent(data || []);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [loadPresence, prefetchRecent]);

  // Coalesced background refresh — multiple `chat_message` events within a
  // short window collapse into ONE getConversations() call instead of one per
  // message (which previously hammered the server on busy chats).
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) return; // a refresh is already pending
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      load();
    }, 400);
  }, [load]);

  useEffect(
    () => () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    },
    [],
  );

  const loadCalls = useCallback(async () => {
    try {
      const { data } = await getAllCallHistory();
      setCalls(data || []);
    } catch {
      setCalls([]);
    }
  }, []);

  // NOTE: the initial conversation-list fetch is handled by the `useFocusEffect`
  // below (which fires on mount AND every time the tab regains focus). A
  // separate `useEffect(() => load())` here used to ALSO fire on mount, so the
  // list was fetched twice on first paint — removed to halve the cold-open work.
  useEffect(() => {
    if (tab === "calls") loadCalls();
  }, [tab, loadCalls]);

  // If the meetings feature is disabled while the Meetings tab is active, fall
  // back to Messages so the user isn't stranded on a now-hidden tab.
  useEffect(() => {
    if (!meetingsEnabled && tab === "meetings") setTab("msgs");
  }, [meetingsEnabled, tab]);

  useFocusEffect(
    useCallback(() => {
      load();
      const off = socket.subscribe((msg) => {
        // Debounced refresh instead of a full fetch per message.
        if (msg.type === "chat_message") scheduleRefresh();
        // Live read receipt on the conversation LIST (Signal parity): when a
        // peer reads a conversation, flip the row's tick to "read" instantly
        // instead of waiting for the next full list refresh.
        if (msg.type === "chat_read_receipt" && msg.data?.conversationId) {
          const cid = Number(msg.data.conversationId);
          setItems((prev) =>
            prev.map((c) =>
              c.id === cid ? { ...c, last_message_read: true } : c,
            ),
          );
        }
        // Keep peer status badges live (mirrors web userStatusMap upkeep).
        if (msg.type === "user_status" && msg.data?.userId) {
          setUserStatusMap((prev) => ({
            ...prev,
            [msg.data.userId]: msg.data.effective,
          }));
        }
      });
      return off;
    }, [load, scheduleRefresh]),
  );

  // Tenant-wide people search (web parity). Runs in the header search mode but
  // keeps the tab list visible underneath.
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const q = query.trim();
    if (!searchOpen || q.length < 2) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimer.current = setTimeout(() => {
      searchChatUsers(q)
        .then((r) => setSearchResults(r.data || []))
        .catch(() => setSearchResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [query, searchOpen]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
    if (tab === "calls") loadCalls();
  }, [load, loadCalls, tab]);

  function openConv(c: Conversation) {
    // Only pass params that have a real value. Sending empty strings ("") for a
    // missing avatar / peerId / group flag is a foot-gun: any consumer that does
    // `Number(params.peerId)` without a truthy guard would get `0` and resolve
    // the wrong peer. Omitting them keeps the thread's param-resolution logic
    // clean (it already treats absent params as "resolve from cache/network").
    const params: Record<string, string> = {
      id: String(c.id),
      name: convName(c),
    };
    if (!c.is_group && c.other_avatar) params.avatar = c.other_avatar;
    if (!c.is_group && c.other_user_id)
      params.peerId = String(c.other_user_id);
    if (c.is_group) {
      params.isGroup = "1";
      if (c.group_avatar) params.avatar = c.group_avatar;
      if (Array.isArray(c.group_member_avatars) && c.group_member_avatars.length) {
        params.groupMemberAvatars = JSON.stringify(c.group_member_avatars);
      }
    }
    router.push({ pathname: "/chat/[id]", params });
  }

  useEffect(() => {
    const target = String(params.openConversationId || "").trim();
    if (!target || openedFromLaunchParamRef.current === target) return;

    // Latch IMMEDIATELY so this only ever fires once per launch param — and so a
    // re-render caused by `items` hydrating can't re-trigger it (this effect no
    // longer depends on `items`, so it runs exactly when the param arrives).
    openedFromLaunchParamRef.current = target;
    setTab("msgs");
    // Clear the param so a later tab re-focus / re-render never re-opens it.
    router.setParams({ openConversationId: undefined });

    // Resolve full identity (name/avatar/peer) from whatever is available
    // synchronously — the live list OR the on-device cache. This is best-effort
    // ONLY: we must NEVER block opening the thread on the list being hydrated,
    // which was the root cause of "tapping a message lands on the chat list".
    const conv =
      items.find((c) => String(c.id) === target) ||
      (getCachedConversations() || []).find((c) => String(c.id) === target);
    if (conv) {
      openConv(conv);
      return;
    }

    // No cached identity yet (cold notification launch before the list/cache is
    // warm) → open by id IMMEDIATELY. The thread screen resolves name/avatar
    // from cache/network on its own, exactly like Signal's recipient-id based
    // ConversationIntents. The key fix: this push happens unconditionally,
    // independent of `items`, so the correct 1:1 thread always opens.
    router.push({ pathname: "/chat/[id]", params: { id: target } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.openConversationId, router]);

  // Open the Signal-style Call Info screen for a history entry (mirrors
  // Signal-Android's CallInfoFragment). A bare row tap must NEVER blind-dial —
  // it shows the details card with explicit Voice/Video/Message actions. The
  // per-row quick-call icon (right side) still offers one-tap call-back.
  function openCallInfo(entry: CallLogEntry) {
    const outgoing = entry.caller_id === user?.id;
    const display = entry.is_group
      ? entry.group_name || "Group"
      : outgoing
        ? entry.other_name || "Unknown"
        : entry.caller_name || "Unknown";
    const peerAvatar = entry.is_group
      ? ""
      : outgoing
        ? entry.other_avatar || ""
        : entry.caller_avatar || "";
    const params: Record<string, string> = {
      callId: String(entry.id),
      conversationId: String(entry.conversation_id),
      peerName: display,
      callType: entry.call_type === "video" ? "video" : "voice",
      direction: outgoing ? "outgoing" : "incoming",
      status: entry.status || "",
      createdAt: entry.created_at || "",
    };
    if (peerAvatar) params.peerAvatar = peerAvatar;
    if (entry.duration) params.duration = String(entry.duration);
    if (entry.is_group) {
      params.isGroup = "1";
      if (
        Array.isArray(entry.group_member_avatars) &&
        entry.group_member_avatars.length
      ) {
        params.groupMemberAvatars = JSON.stringify(entry.group_member_avatars);
      }
    }
    router.push({ pathname: "/call-info/[callId]", params });
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
    // GUARD: a call-log entry can carry a null/invalid conversation_id (e.g.
    // the conversation was deleted). Pushing that to the call screen produced
    // `String(null)` → "null" → NaN, and the server silently dropped the
    // resulting call_initiate — the caller rang forever while the receiver
    // never rang. Fail fast with a clear message instead.
    const convId = Number(entry.conversation_id);
    if (!Number.isFinite(convId) || convId <= 0) {
      Alert.alert(
        "Cannot call",
        "This call's conversation no longer exists. Start a new chat to call them.",
      );
      return;
    }
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
    const peerAvatar = outgoing
      ? entry.other_avatar || ""
      : entry.caller_avatar || "";
    router.push({
      pathname: "/call/[conversationId]",
      params: {
        conversationId: String(convId),
        mode: "outgoing",
        callType: entry.call_type === "video" ? "video" : "voice",
        peerName: display,
        peerAvatar,
        isGroup: "0",
      },
    });
  }

  async function startWithUser(u: SearchUser) {
    try {
      const { data } = await startConversation(u.id);
      const convId =
        (data as { conversationId?: number; id?: number })?.conversationId ??
        (data as { conversationId?: number; id?: number })?.id;
      if (!convId) {
        Alert.alert("Error", "Could not open this conversation.");
        return;
      }
      setSearchOpen(false);
      setQuery("");
      setSearchResults([]);
      router.push({
        pathname: "/chat/[id]",
        params: {
          id: String(convId),
          name: u.full_name || u.username,
          avatar: u.avatar || "",
          peerId: String(u.id),
        },
      });
    } catch (e: any) {
      Alert.alert(
        "Error",
        e?.response?.data?.error || "Could not open this conversation.",
      );
    }
  }

  function doPin(c: Conversation) {
    setMenuConv(null);
    pinConversation(c.id)
      .then(load)
      .catch(() => {});
  }

  function doFav(c: Conversation) {
    setMenuConv(null);
    favouriteConversation(c.id)
      .then(load)
      .catch(() => {});
  }

  function doDelete(c: Conversation) {
    setMenuConv(null);
    deleteConversation(c.id)
      .then(() => setItems((prev) => prev.filter((x) => x.id !== c.id)))
      .catch(() => {});
  }

  function doMute(c: Conversation) {
    setMenuConv(null);
    muteConversation(c.id)
      .then(load)
      .catch(() => {});
  }

  function doArchive(c: Conversation) {
    setMenuConv(null);
    archiveConversation(c.id)
      .then(() => setItems((prev) => prev.filter((x) => x.id !== c.id)))
      .catch(() => {});
  }

  function doToggleRead(c: Conversation) {
    setMenuConv(null);
    const action =
      (c.unread_count || 0) > 0
        ? markConversationRead(c.id)
        : markConversationUnread(c.id);
    action.then(load).catch(() => {});
  }

  const normalizedQuery = query.trim().toLowerCase();
  const isFiltering = normalizedQuery.length > 0;
  const allMeetingConvs = items.filter((c) => c.is_meeting_chat);
  const matchesConversation = useCallback(
    (c: Conversation) => {
      if (!isFiltering) return true;
      const haystack = [
        convName(c),
        c.other_username || "",
        c.last_message || "",
        c.group_name || "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    },
    [isFiltering, normalizedQuery],
  );

  // Derived lists (mirror web ChatSidebar grouping), filtered in-place.
  const regular = items.filter((c) => !c.is_meeting_chat && matchesConversation(c));
  const meetingConvs = allMeetingConvs.filter(matchesConversation);
  const pinned = regular.filter((c) => c.is_pinned);
  const favourites = regular.filter((c) => c.is_favourite && !c.is_pinned);
  const others = regular.filter((c) => !c.is_pinned && !c.is_favourite);
  const filteredCalls = useMemo(() => {
    if (!isFiltering) return calls;
    return calls.filter((entry) => {
      const outgoing = entry.caller_id === user?.id;
      const display = entry.is_group
        ? entry.group_name || "Group"
        : outgoing
          ? entry.other_name || "Unknown"
          : entry.caller_name || "Unknown";
      const haystack = [
        display,
        entry.status || "",
        entry.call_type || "",
        outgoing ? "outgoing" : "incoming",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [calls, isFiltering, normalizedQuery, user?.id]);

  const totalUnread = items.reduce((s, c) => s + (c.unread_count || 0), 0);
  const meetingUnread = allMeetingConvs.reduce(
    (s, c) => s + (c.unread_count || 0),
    0,
  );

  // ── Signal-style multi-select helpers ──
  const exitSelection = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, []);

  // Enter selection mode pre-selecting `id` (long-press entry point).
  const enterSelection = useCallback((id: number) => {
    setSelectionMode(true);
    setSelectedIds(new Set([id]));
  }, []);

  // Toggle a row's selected state. If the last item is unselected we drop back
  // out of selection mode (Signal parity).
  const toggleSelected = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      if (next.size === 0) setSelectionMode(false);
      return next;
    });
  }, []);

  // The full set of selectable ids for the ACTIVE tab — used by "Select all".
  const selectableIds = useMemo<number[]>(() => {
    if (tab === "calls") return filteredCalls.map((c) => c.id);
    if (tab === "meetings") return meetingConvs.map((c) => c.id);
    return regular.map((c) => c.id);
  }, [tab, filteredCalls, meetingConvs, regular]);

  const allSelected =
    selectableIds.length > 0 && selectedIds.size === selectableIds.length;

  const selectAll = useCallback(() => {
    setSelectedIds((prev) =>
      prev.size === selectableIds.length
        ? new Set()
        : new Set(selectableIds),
    );
  }, [selectableIds]);

  // Bulk delete the selected rows. Calls hit the dedicated bulk endpoint;
  // chat/meeting rows loop deleteConversation (no bulk endpoint needed).
  const performBulkDelete = useCallback(async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) {
      setConfirmDelete(false);
      return;
    }
    setDeleting(true);
    try {
      if (tab === "calls") {
        await deleteCalls(ids);
        setCalls((prev) => prev.filter((c) => !selectedIds.has(c.id)));
      } else {
        await Promise.allSettled(ids.map((id) => deleteConversation(id)));
        setItems((prev) => prev.filter((c) => !selectedIds.has(c.id)));
      }
    } catch {
      /* best-effort; the list refresh below reconciles */
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
      exitSelection();
      if (tab === "calls") loadCalls();
      else load();
    }
  }, [selectedIds, tab, exitSelection, load, loadCalls]);

  // Leaving a tab or changing search mode cancels any in-progress selection so the
  // selection bar never lingers over the wrong list.
  useEffect(() => {
    if (selectionMode) exitSelection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, searchOpen]);

  // Flatten the active tab's grouped conversations into a single typed row
  // array for the virtualized FlashList (section headers + conversation rows).
  const listRows = useMemo<ListRow[]>(() => {
    const rows: ListRow[] = [];
    if (tab === "msgs") {
      if (pinned.length > 0) {
        rows.push({
          kind: "section",
          key: "sec-pin",
          title: "Pinned",
          icon: "pin",
        });
        for (const c of pinned)
          rows.push({ kind: "conv", key: `c-${c.id}`, conv: c });
      }
      if (favourites.length > 0) {
        rows.push({
          kind: "section",
          key: "sec-fav",
          title: "Favourites",
          icon: "star",
        });
        for (const c of favourites)
          rows.push({ kind: "conv", key: `c-${c.id}`, conv: c });
      }
      if ((pinned.length > 0 || favourites.length > 0) && others.length > 0) {
        rows.push({
          kind: "section",
          key: "sec-all",
          title: "All Messages",
          icon: "msg",
        });
      }
      for (const c of others)
        rows.push({ kind: "conv", key: `c-${c.id}`, conv: c });
    } else if (tab === "meetings") {
      for (const c of meetingConvs)
        rows.push({ kind: "conv", key: `c-${c.id}`, conv: c });
    }
    return rows;
  }, [tab, pinned, favourites, others, meetingConvs]);

  function renderSectionIcon(icon: "pin" | "star" | "msg") {
    if (icon === "pin") return <Pin size={13} color={theme.textMuted} />;
    if (icon === "star") return <Star size={13} color={theme.warning} />;
    return <MessageSquare size={13} color={theme.textMuted} />;
  }

  // Avatar for a conversation row. Meeting chats and groups get a recognizable
  // icon avatar (Signal renders a group glyph) instead of blank initials; 1:1
  // chats use the peer's avatar/initials with a live status dot.
  function renderConvAvatar(item: Conversation) {
    if (item.is_meeting_chat) {
      return (
        <View style={styles.iconAvatar}>
          <Video size={22} color={theme.onAccent} />
        </View>
      );
    }
    if (item.is_group) {
      return (
        <GroupCompositeAvatar
          name={convName(item)}
          avatar={item.group_avatar}
          memberAvatars={item.group_member_avatars}
          size={48}
        />
      );
    }
    return (
      <ChatAvatar
        name={convName(item)}
        avatar={item.other_avatar}
        size={48}
        userStatus={
          item.other_user_id ? userStatusMap[item.other_user_id] : undefined
        }
      />
    );
  }

  // Signal-style conversation-list delivery tick for the caller's OWN last
  // message: sent (bare ✓) → delivered (circled ✓) → read (accent filled ✓✓).
  // Mirrors the in-thread MsgTicks glyphs so the two screens read identically.
  function renderListTick(item: Conversation) {
    if (!user || Number(item.last_sender_id) !== Number(user.id)) return null;
    if (item.last_format_type === "system") return null;
    const read = !!item.last_message_read;
    const delivered = !!item.last_message_delivered;
    if (read) {
      return (
        <Svg width={14} height={14} viewBox="0 0 16 16" fill="none">
          <SvgCircle cx={8} cy={8} r={7} stroke={theme.primary} strokeWidth={1.1} />
          <SvgCircle cx={8} cy={8} r={5.2} fill={theme.primary} />
          <SvgPath
            d="M5.4 8.1l1.8 1.8L10.7 6"
            stroke="#fff"
            strokeWidth={1.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      );
    }
    if (delivered) {
      return (
        <Svg width={14} height={14} viewBox="0 0 16 16" fill="none">
          <SvgCircle cx={8} cy={8} r={7} stroke={theme.textMuted} strokeWidth={1.3} />
          <SvgPath
            d="M4.6 8.2l2.2 2.2L11.4 5.6"
            stroke={theme.textMuted}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      );
    }
    return (
      <Svg width={14} height={14} viewBox="0 0 16 16" fill="none">
        <SvgPath
          d="M3.5 8.5l3 3 6-7"
          stroke={theme.textMuted}
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    );
  }

  function renderConv(item: Conversation) {
    const name = convName(item);
    const selected = selectedIds.has(item.id);
    // Signal-style attachment preview: a type-specific icon + label instead of a
    // generic "Attachment". Falls back to the text message / "No messages yet".
    const attachment = item.last_file_url
      ? attachmentPreview(item.last_file_type, item.last_file_name)
      : null;
    // Signal-style call-history preview: when the latest message is a call
    // system row, show a phone/video icon + summary (red for missed) instead
    // of the raw system text.
    const callPreview =
      item.last_format_type === "system" && item.last_metadata?.type === "call"
        ? callPreviewMeta(item.last_metadata)
        : null;
    // Delivery tick for the caller's OWN last message — rendered on the
    // right edge of the bottom row, directly under the timestamp.
    const listTick = callPreview ? null : renderListTick(item);
    return (
      <Pressable
        key={item.id}
        style={({ pressed }) => [
          styles.row,
          selected && styles.rowSelected,
          pressed && styles.rowPressed,
        ]}
        // In selection mode a tap toggles the row; otherwise it opens the chat.
        onPress={() =>
          selectionMode ? toggleSelected(item.id) : openConv(item)
        }
        // Long-press in selection mode toggles; otherwise it opens the
        // single-item action sheet (which itself offers a "Select" entry).
        onLongPress={() =>
          selectionMode ? toggleSelected(item.id) : setMenuConv(item)
        }
        delayLongPress={300}
      >
        {selectionMode ? (
          <View style={styles.selectMark}>
            {selected ? (
              <CheckCircle2 size={22} color={theme.primary} />
            ) : (
              <Circle size={22} color={theme.textMuted} />
            )}
          </View>
        ) : null}
        {renderConvAvatar(item)}
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
            {callPreview ? (
              <View style={styles.previewRow}>
                {callPreview.icon}
                <Text
                  style={[
                    styles.preview,
                    callPreview.missed && { color: theme.danger },
                  ]}
                  numberOfLines={1}
                >
                  {callPreview.label}
                </Text>
              </View>
            ) : attachment ? (
              <View style={styles.previewRow}>
                {attachment.icon}
                <Text style={styles.preview} numberOfLines={1}>
                  {attachment.label}
                </Text>
              </View>
            ) : (
              <View style={styles.previewRow}>
                <Text style={styles.preview} numberOfLines={1}>
                  {item.last_message || "No messages yet"}
                </Text>
              </View>
            )}
            {/* Delivery tick pinned to the row's right edge, directly under the
                timestamp (web parity). */}
            {listTick ? <View style={styles.listTick}>{listTick}</View> : null}
            {item.unread_count > 0 ? (
              <View style={styles.unread}>
                <Text style={styles.unreadText}>
                  {item.unread_count > 99 ? "99+" : item.unread_count}
                </Text>
              </View>
            ) : null}
          </View>
        </View>
      </Pressable>
    );
  }

  // Map an attachment's mime/name to a Signal-style icon + label for the chat
  // list preview line (📷 Photo / 🎥 Video / 🎙️ Voice message / 📄 <name>).
  function attachmentPreview(
    fileType?: string | null,
    fileName?: string | null,
  ): { icon: React.ReactNode; label: string } {
    const t = (fileType || "").toLowerCase();
    const name = (fileName || "").toLowerCase();
    const ext = name.includes(".") ? name.split(".").pop() || "" : "";
    const isImage =
      t.startsWith("image/") ||
      ["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic"].includes(ext);
    const isVideo =
      t.startsWith("video/") || ["mp4", "mov", "webm", "mkv"].includes(ext);
    const isAudio =
      t.startsWith("audio/") ||
      ["m4a", "mp3", "aac", "ogg", "wav"].includes(ext);
    if (t === "image/gif" || ext === "gif") {
      return {
        icon: <ImageIcon size={13} color={theme.textSecondary} />,
        label: "GIF",
      };
    }
    if (isImage) {
      return {
        icon: <ImageIcon size={13} color={theme.textSecondary} />,
        label: "Photo",
      };
    }
    if (isVideo) {
      return {
        icon: <Film size={13} color={theme.textSecondary} />,
        label: "Video",
      };
    }
    if (isAudio) {
      return {
        icon: <Mic size={13} color={theme.textSecondary} />,
        label: "Voice message",
      };
    }
    return {
      icon: <FileText size={13} color={theme.textSecondary} />,
      label: fileName || "Document",
    };
  }

  // Map a call-history system message's metadata to a Signal-style icon +
  // label for the conversation-list preview line.
  function callPreviewMeta(meta: { callType?: string; status?: string }): {
    icon: React.ReactNode;
    label: string;
    missed: boolean;
  } {
    const isVideo = meta.callType === "video";
    const missed = meta.status === "missed";
    if (missed) {
      return {
        icon: <PhoneMissed size={13} color={theme.danger} />,
        label: `Missed ${isVideo ? "video" : "voice"} call`,
        missed: true,
      };
    }
    const label =
      meta.status === "declined"
        ? `${isVideo ? "Video" : "Voice"} call declined`
        : `${isVideo ? "Video" : "Voice"} call`;
    return {
      icon: isVideo ? (
        <Video size={13} color={theme.textSecondary} />
      ) : (
        <Phone size={13} color={theme.textSecondary} />
      ),
      label,
      missed: false,
    };
  }

  function renderSection(title: string, icon: React.ReactNode) {
    return (
      <View style={styles.section}>
        {icon}
        <Text style={styles.sectionText}>{title}</Text>
      </View>
    );
  }

  function renderSearchUsersBlock() {
    if (!searchOpen || query.trim().length < 2) return null;
    return (
      <View style={styles.searchUsersBlock}>
        <View style={styles.searchUsersHeader}>
          <Users size={14} color={theme.textMuted} />
          <Text style={styles.searchUsersTitle}>People</Text>
        </View>
        {searching ? (
          <Text style={styles.searchUsersHint}>Searching…</Text>
        ) : searchResults.length === 0 ? (
          <Text style={styles.searchUsersHint}>No users found</Text>
        ) : (
          searchResults.map((u) => (
            <Pressable
              key={`search-user-${u.id}`}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              onPress={() => startWithUser(u)}
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
                  {u.email ? ` · ${u.email}` : ""}
                </Text>
              </View>
            </Pressable>
          ))
        )}
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
      {/* Header row: Chat/Meet/Calls rail with embedded search trigger and an
          animated in-place search field (Signal-style list retention). */}
      {selectionMode ? (
        // Signal-style selection action bar: close (X) + count on the left,
        // Select-all + Delete actions on the right.
        <View style={styles.selectionBar}>
          <Pressable
            style={styles.selectionAction}
            onPress={exitSelection}
            hitSlop={8}
          >
            <X size={22} color={theme.text} />
          </Pressable>
          <Text style={styles.selectionCount}>{selectedIds.size} selected</Text>
          <Pressable
            style={styles.selectionAction}
            onPress={selectAll}
            hitSlop={8}
          >
            <ListChecks
              size={22}
              color={allSelected ? theme.primary : theme.text}
            />
          </Pressable>
          <Pressable
            style={styles.selectionAction}
            onPress={() => selectedIds.size > 0 && setConfirmDelete(true)}
            hitSlop={8}
          >
            <Trash2
              size={22}
              color={selectedIds.size > 0 ? theme.danger : theme.textMuted}
            />
          </Pressable>
        </View>
      ) : (
        <View style={styles.header}>
          <ChatTabSwitcher
            activeTab={tab}
            meetingsEnabled={meetingsEnabled}
            totalUnread={totalUnread}
            meetingUnread={meetingUnread}
            searchOpen={searchOpen}
            searchQuery={query}
            style={styles.segmentGroup}
            onChange={setTab}
            onSearchQueryChange={setQuery}
            onSearchOpenChange={(open) => {
              setSearchOpen(open);
              if (!open) {
                setQuery("");
                setSearchResults([]);
                setSearching(false);
              }
            }}
          />
        </View>
      )}

      {tab === "calls" ? (
        <FlashList
          data={filteredCalls}
          keyExtractor={(c) => String(c.id)}
          contentContainerStyle={styles.list}
          ListHeaderComponent={renderSearchUsersBlock}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={theme.primary}
            />
          }
          renderItem={({ item }: { item: CallLogEntry }) => {
            const outgoing = item.caller_id === user?.id;
            const missed = item.status === "missed" && !outgoing;
            const display = item.is_group
              ? item.group_name || "Group"
              : outgoing
                ? item.other_name || "Unknown"
                : item.caller_name || "Unknown";
            const selected = selectedIds.has(item.id);
            // The avatar for a call row: the OTHER party's avatar (peer for
            // outgoing, caller for incoming). Group calls fall back to a group
            // icon avatar.
            const callAvatar = item.is_group
              ? null
              : outgoing
                ? item.other_avatar
                : item.caller_avatar;
            return (
              <Pressable
                style={({ pressed }) => [
                  styles.row,
                  selected && styles.rowSelected,
                  pressed && styles.rowPressed,
                ]}
                onPress={() =>
                  selectionMode ? toggleSelected(item.id) : openCallInfo(item)
                }
                onLongPress={() =>
                  selectionMode ? toggleSelected(item.id) : enterSelection(item.id)
                }
                delayLongPress={300}
              >
                {selectionMode ? (
                  <View style={styles.selectMark}>
                    {selected ? (
                      <CheckCircle2 size={22} color={theme.primary} />
                    ) : (
                      <Circle size={22} color={theme.textMuted} />
                    )}
                  </View>
                ) : null}
                {item.is_group ? (
                  <GroupCompositeAvatar
                    name={display}
                    memberAvatars={item.group_member_avatars}
                    size={48}
                  />
                ) : (
                  <ChatAvatar name={display} avatar={callAvatar} size={48} />
                )}
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
                      {item.duration ? ` · ${callDuration(item.duration)}` : ""}
                    </Text>
                  </View>
                </View>
                <View style={styles.callRight}>
                  <Text style={styles.time}>{timeAgo(item.created_at)}</Text>
                  {/* Quick call-back (Signal parity): one intentional tap on
                      the type icon redials; a bare row tap opens Call Info. */}
                  <Pressable
                    style={({ pressed }) => [
                      styles.callBackBtn,
                      pressed && styles.callBackBtnPressed,
                    ]}
                    hitSlop={8}
                    disabled={selectionMode}
                    onPress={() => callBack(item)}
                  >
                    {item.call_type === "video" ? (
                      <Video size={18} color={theme.primary} />
                    ) : (
                      <Phone size={18} color={theme.primary} />
                    )}
                  </Pressable>
                </View>
              </Pressable>
            );
          }}
          ListEmptyComponent={
            <View style={styles.empty}>
              <View style={styles.emptyIconWrap}>
                <Phone size={36} color={theme.textSecondary} />
              </View>
              <Text style={styles.emptyText}>
                {isFiltering ? "No matching calls" : "No calls yet"}
              </Text>
            </View>
          }
        />
      ) : listRows.length === 0 ? (
        // Empty states per tab (no rows to virtualize).
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
          {renderSearchUsersBlock()}
          {tab === "meetings" ? (
            <View style={styles.empty}>
              <View style={styles.emptyIconWrap}>
                <Video size={36} color={theme.textSecondary} />
              </View>
              <Text style={styles.emptyText}>
                {isFiltering ? "No matching meeting chats" : "No meeting chats yet"}
              </Text>
            </View>
          ) : (
            <View style={styles.empty}>
              <View style={styles.emptyIconWrap}>
                <MessagesSquare size={36} color={theme.textSecondary} />
              </View>
              <Text style={styles.emptyText}>
                {isFiltering ? "No matching chats" : "No conversations yet"}
              </Text>
            </View>
          )}
        </ScrollView>
      ) : (
        // Virtualized conversation list (FlashList) — section headers + rows
        // share one recycled cell pool, so long lists scroll smoothly and the
        // tab opens fast (no more mapping every row into a ScrollView).
        <FlashList
          data={listRows}
          keyExtractor={(r) => r.key}
          contentContainerStyle={styles.list}
          ListHeaderComponent={renderSearchUsersBlock}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={theme.primary}
            />
          }
          renderItem={({ item }: { item: ListRow }) =>
            item.kind === "section"
              ? renderSection(item.title, renderSectionIcon(item.icon))
              : renderConv(item.conv)
          }
        />
      )}

      {!searchOpen && !selectionMode ? (
        <Pressable style={styles.fab} onPress={() => router.push("/chat/new")}>
          <MessagesSquare size={22} color="#fff" />
        </Pressable>
      ) : null}

      {/* Per-conversation action sheet — Signal-style: slides up from the
          bottom, headed by the conversation avatar + name, with the full
          action set (Pin, Mark read/unread, Mute, Favourite, Archive,
          Delete). */}
      <Modal
        visible={!!menuConv}
        transparent
        animationType="slide"
        onRequestClose={() => setMenuConv(null)}
      >
        <Pressable
          style={styles.sheetOverlay}
          onPress={() => setMenuConv(null)}
        >
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <View style={styles.sheetHandle} />
            {menuConv ? (
              <View style={styles.sheetHeader}>
                {menuConv.is_group ? (
                  <GroupCompositeAvatar
                    name={convName(menuConv)}
                    avatar={menuConv.group_avatar}
                    memberAvatars={menuConv.group_member_avatars}
                    size={40}
                  />
                ) : (
                  <ChatAvatar
                    name={convName(menuConv)}
                    avatar={menuConv.other_avatar}
                    size={40}
                  />
                )}
                <Text style={styles.sheetTitle} numberOfLines={1}>
                  {convName(menuConv)}
                </Text>
              </View>
            ) : null}

            <Pressable
              style={styles.sheetRow}
              onPress={() => {
                const c = menuConv;
                setMenuConv(null);
                if (c) enterSelection(c.id);
              }}
            >
              <ListChecks size={20} color={theme.text} />
              <Text style={styles.sheetText}>Select</Text>
            </Pressable>
            <Pressable
              style={styles.sheetRow}
              onPress={() => menuConv && doPin(menuConv)}
            >
              <Pin size={20} color={theme.text} />
              <Text style={styles.sheetText}>
                {menuConv?.is_pinned ? "Unpin" : "Pin"}
              </Text>
            </Pressable>
            <Pressable
              style={styles.sheetRow}
              onPress={() => menuConv && doToggleRead(menuConv)}
            >
              {(menuConv?.unread_count || 0) > 0 ? (
                <Check size={20} color={theme.text} />
              ) : (
                <MailOpen size={20} color={theme.text} />
              )}
              <Text style={styles.sheetText}>
                {(menuConv?.unread_count || 0) > 0
                  ? "Mark as read"
                  : "Mark as unread"}
              </Text>
            </Pressable>
            <Pressable
              style={styles.sheetRow}
              onPress={() => menuConv && doMute(menuConv)}
            >
              {menuConv?.is_muted ? (
                <BellDot size={20} color={theme.text} />
              ) : (
                <BellOff size={20} color={theme.text} />
              )}
              <Text style={styles.sheetText}>
                {menuConv?.is_muted ? "Unmute" : "Mute"}
              </Text>
            </Pressable>
            <Pressable
              style={styles.sheetRow}
              onPress={() => menuConv && doFav(menuConv)}
            >
              <Star
                size={20}
                color={menuConv?.is_favourite ? theme.warning : theme.text}
              />
              <Text style={styles.sheetText}>
                {menuConv?.is_favourite ? "Unfavourite" : "Favourite"}
              </Text>
            </Pressable>
            <Pressable
              style={styles.sheetRow}
              onPress={() => menuConv && doArchive(menuConv)}
            >
              <Archive size={20} color={theme.text} />
              <Text style={styles.sheetText}>
                {menuConv?.is_archived ? "Unarchive" : "Archive"}
              </Text>
            </Pressable>
            <Pressable
              style={styles.sheetRow}
              onPress={() => menuConv && doDelete(menuConv)}
            >
              <Trash2 size={20} color={theme.danger} />
              <Text style={[styles.sheetText, { color: theme.danger }]}>
                Delete
              </Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Bulk-delete confirmation (themed, replaces the OS alert). */}
      <ConfirmDialog
        visible={confirmDelete}
        title="Delete selected?"
        message={
          tab === "calls"
            ? `Delete ${selectedIds.size} call${selectedIds.size === 1 ? "" : "s"} from your history?`
            : `Delete ${selectedIds.size} conversation${selectedIds.size === 1 ? "" : "s"}? This cannot be undone.`
        }
        confirmText={deleting ? "Deleting…" : "Delete"}
        isDanger
        onConfirm={performBulkDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </View>
  );
}

const makeStyles = (theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.bg },
    center: { alignItems: "center", justifyContent: "center" },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      paddingTop: 8,
      paddingBottom: 6,
    },
    heading: {
      fontSize: 24,
      fontWeight: "800",
      color: theme.text,
      letterSpacing: -0.5,
    },
    segmentGroup: {
      flex: 1,
    },
    fab: {
      position: "absolute",
      right: 20,
      bottom: 24,
      width: 56,
      height: 56,
      borderRadius: 20,
      backgroundColor: theme.primary,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: theme.chatSegmentActiveBorder,
      shadowColor: theme.primary,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.3,
      shadowRadius: 10,
      elevation: 6,
    },
    list: { paddingHorizontal: 8, paddingBottom: 90 },
    section: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      paddingTop: 12,
      paddingBottom: 4,
      paddingHorizontal: 8,
    },
    sectionText: {
      fontSize: 12,
      fontWeight: "700",
      color: theme.textMuted,
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    searchUsersBlock: { marginBottom: 4 },
    searchUsersHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingTop: 6,
      paddingBottom: 8,
      paddingHorizontal: 4,
    },
    searchUsersTitle: {
      fontSize: 12,
      color: theme.textMuted,
      fontWeight: "700",
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    searchUsersHint: {
      color: theme.textMuted,
      fontSize: 13,
      paddingVertical: 10,
      paddingHorizontal: 4,
    },
    // Flat, borderless Signal-style row: avatar · name+snippet · time/unread.
    // No card border/background — just a full-width row with a subtle press
    // and selected tint, tighter vertical rhythm.
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 9,
      paddingHorizontal: 10,
      borderRadius: 12,
    },
    // Icon avatar for meeting / group rows (Signal-style group glyph).
    iconAvatar: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: theme.primary,
      alignItems: "center",
      justifyContent: "center",
    },
    rowPressed: { backgroundColor: theme.chatRowPressed },
    // Selected-row tint + the leading checkbox column in selection mode.
    rowSelected: {
      backgroundColor: theme.chatRowSelected,
    },
    selectMark: { width: 26, alignItems: "center", justifyContent: "center" },
    // Signal-style selection action bar (replaces the header in selection mode).
    selectionBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 8,
      minHeight: 52,
    },
    selectionCount: {
      flex: 1,
      fontSize: 17,
      fontWeight: "700",
      color: theme.text,
    },
    selectionAction: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
    },
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
    previewRow: { flex: 1, flexDirection: "row", alignItems: "center", gap: 5 },
    // Right-edge slot for the own-message delivery tick so it sits directly
    // under the timestamp in the top row.
    listTick: { marginLeft: 6, flexShrink: 0 },
    preview: { flex: 1, fontSize: 13, color: theme.textSecondary },
    unread: {
      minWidth: 20,
      height: 20,
      borderRadius: 10,
      backgroundColor: theme.chatTabBadgeBg,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 6,
      borderWidth: 1,
      borderColor: theme.chatTabBadgeBorder,
    },
    unreadText: { color: "#fff", fontSize: 11, fontWeight: "700" },
    callMeta: { flexDirection: "row", alignItems: "center", gap: 5 },
    callMetaText: { fontSize: 13, color: theme.textSecondary },
    callRight: { alignItems: "flex-end", gap: 4 },
    callBackBtn: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: "center",
      justifyContent: "center",
    },
    callBackBtnPressed: { backgroundColor: theme.surface },
    empty: { alignItems: "center", gap: 12, paddingTop: 90 },
    emptyIconWrap: {
      width: 74,
      height: 74,
      borderRadius: 22,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.chatEmptySurface,
      borderWidth: 1,
      borderColor: theme.chatRowBorder,
    },
    emptyText: { color: theme.textMuted, fontSize: 14 },
    // Signal-style bottom action sheet.
    sheetOverlay: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.5)",
      justifyContent: "flex-end",
    },
    sheet: {
      backgroundColor: theme.bgElevated,
      borderTopLeftRadius: 18,
      borderTopRightRadius: 18,
      paddingTop: 8,
      paddingBottom: 28,
    },
    sheetHandle: {
      alignSelf: "center",
      width: 38,
      height: 4,
      borderRadius: 2,
      backgroundColor: theme.glassBorder,
      marginBottom: 8,
    },
    sheetHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 20,
      paddingTop: 4,
      paddingBottom: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.glassBorder,
      marginBottom: 6,
    },
    sheetTitle: { flex: 1, fontSize: 16, fontWeight: "700", color: theme.text },
    sheetRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 16,
      paddingHorizontal: 22,
      paddingVertical: 14,
    },
    sheetText: { fontSize: 15, color: theme.text, fontWeight: "500" },
  });
