import { useEffect, useState } from "react";
import { InteractionManager } from "react-native";
import { useDialog } from "../../hooks/useDialog";
import {
  blockUser,
  unblockUser,
  getChatPresence,
  getConversations,
  type Conversation,
} from "../../features";
import { socket } from "../../realtime/socket";
import { getCachedConversations } from "../../storage/chatCache";
import { STATUS_LABEL } from "./chatUtils";

type UseChatPeerIdentityOptions = {
  convId: number;
  paramName?: string;
  paramAvatar?: string;
  paramPeerId?: string;
  paramIsGroup?: string;
  paramGroupMemberAvatars?: string;
  parsedGroupMemberAvatars: string[];
  confirm: ReturnType<typeof useDialog>["confirm"];
};

/**
 * Header identity + live peer presence for a chat thread.
 *
 * Seeded from the route params for the common conversation-list open, and
 * RESOLVED from the cached/remote conversation list when a notification
 * cold-start only supplies the conversation id. Also owns the group metadata
 * (role/description/member avatars) and the 1:1 block state.
 */
export default function useChatPeerIdentity({
  convId,
  paramName,
  paramAvatar,
  paramPeerId,
  paramIsGroup,
  paramGroupMemberAvatars,
  parsedGroupMemberAvatars,
  confirm,
}: UseChatPeerIdentityOptions) {
  // Header identity (name + avatar). Seeded from the route params for the
  // common case (opened from the conversation list, which passes them), but
  // held in STATE so it can be RESOLVED when missing — e.g. a notification tap
  // cold-starts the app and only the conversationId is passed (no name/avatar),
  // which previously left the header showing the generic "Chat" + "?" avatar.
  // We backfill from the cached conversation list (synchronous) and a network
  // refresh below. Mirrors Signal-Android's ConversationIntents, where the
  // thread resolves the recipient from its id when launched from a notification.
  const [name, setName] = useState<string | undefined>(paramName);
  const [headerAvatar, setHeaderAvatar] = useState<string | null>(
    paramAvatar || null,
  );
  // Whether this conversation is a group thread. Group calls now stay on the
  // unified call path (no forced meeting redirect).
  const [isGroupConv, setIsGroupConv] = useState(paramIsGroup === "1");
  const [groupMemberAvatars, setGroupMemberAvatars] = useState<string[]>(
    parsedGroupMemberAvatars,
  );
  // Caller's local group role + the group's description, surfaced to the
  // group-settings screen (Phase 1). Resolved from the conversation row.
  const [myGroupRole, setMyGroupRole] = useState<string>("member");
  const [groupDescription, setGroupDescription] = useState<string>("");
  // Peer (1:1) identity + live status for the header avatar badge.
  const [peerUserId, setPeerUserId] = useState<number | null>(
    paramPeerId ? Number(paramPeerId) : null,
  );
  const [peerStatus, setPeerStatus] = useState<string | null>(null);
  // Whether the peer is currently logged in from the office or working remotely
  // (from today's attendance clock-in). null = logged out / no data. Shown as a
  // badge in the header. Updated on presence fetch only (no live WS event).
  const [peerWorkMode, setPeerWorkMode] = useState<string | null>(null);
  const [participantCount, setParticipantCount] = useState(2);
  // Block state for the 1:1 peer (Signal parity). When blocked, the composer
  // is replaced with an Unblock banner and sends are rejected server-side.
  const [isBlocked, setIsBlocked] = useState(false);

  // Resolve the 1:1 peer's status for the header badge.
  //
  // PERF: this used to fetch the ENTIRE conversation list (`getConversations`)
  // on every chat open just to find this one conversation's peer id / group
  // flag — a wasteful full round-trip on the critical open path. The peer id,
  // name, avatar and group flag are ALREADY passed as route params from the
  // conversation list (see `openConv` in app/(tabs)/chat.tsx), so we use those
  // and only make the cheap presence call for the live status badge. If a peer
  // id wasn't supplied (e.g. deep-link), we fall back to the cached
  // conversation list instead of hitting the network.
  useEffect(() => {
    let active = true;
    const peerFromParam = paramPeerId ? Number(paramPeerId) : null;
    // Whether the route already supplied the header identity (opened from the
    // conversation list). When it did NOT (e.g. a notification tap cold-start),
    // we must RESOLVE name/avatar from the conversation so the header doesn't
    // show the generic "Chat" + "?" avatar.
    const haveIdentity = !!paramName;

    // Apply a resolved conversation's identity (name / avatar / group flag /
    // peer) to the header state. Used both from the synchronous cache lookup
    // and the network fallback below. Only fills fields the route didn't give.
    const applyConv = (conv: Conversation) => {
      if (!active) return;
      if (conv.member_count) setParticipantCount(conv.member_count);
      setIsGroupConv(!!conv.is_group);
      if (conv.is_group) {
        setGroupMemberAvatars(
          Array.isArray(conv.group_member_avatars)
            ? conv.group_member_avatars.filter(
                (v): v is string => typeof v === "string" && v.length > 0,
              )
            : [],
        );
      }
      if (conv.my_role) setMyGroupRole(conv.my_role);
      if (conv.group_description != null)
        setGroupDescription(conv.group_description);
      const resolvedName = conv.is_group
        ? conv.group_name || "Group"
        : conv.other_full_name || conv.other_username || "Chat";
      const resolvedAvatar = conv.is_group
        ? conv.group_avatar || null
        : conv.other_avatar || null;
      if (!paramName && resolvedName) setName(resolvedName);
      if (!paramAvatar && resolvedAvatar) setHeaderAvatar(resolvedAvatar);
      if (typeof conv.is_blocked === "boolean") setIsBlocked(conv.is_blocked);
      if (!conv.is_group && conv.other_user_id) {
        const uid = conv.other_user_id;
        setPeerUserId(uid);
        getChatPresence([uid])
          .then((r) => {
            if (active) {
              setPeerStatus(r.data?.[uid]?.userStatus ?? null);
              setPeerWorkMode(r.data?.[uid]?.workMode ?? null);
            }
          })
          .catch(() => {});
      }
    };

    // Resolve the peer identity/status + block state. The header NAME/AVATAR
    // already paint instantly from the route params (seeded into state above),
    // so none of this is needed for the first frame — it only fills the live
    // status badge, block banner and (on a cold deep-link) the resolved name.
    // Running the presence network call + the cached-conversations scan eagerly
    // on mount added JS-thread work that competed with the open animation, so
    // we DEFER the whole resolution past the slide-in (Signal-Android feel).
    // The badge/block/name simply light up a beat after the chat has opened,
    // with no visible downgrade.
    const task = InteractionManager.runAfterInteractions(() => {
      if (!active) return;

      // Seed the block state from the cached conversation row even when the
      // route already supplied the header identity (list-open path early-returns
      // below and would otherwise skip applyConv → isBlocked stays false).
      const cachedBlockConv = (getCachedConversations() || []).find(
        (c) => c.id === convId,
      );
      if (typeof cachedBlockConv?.is_blocked === "boolean") {
        setIsBlocked(cachedBlockConv.is_blocked);
      }

      if (peerFromParam) {
        setPeerUserId(peerFromParam);
        getChatPresence([peerFromParam])
          .then((r) => {
            if (active) {
              setPeerStatus(r.data?.[peerFromParam]?.userStatus ?? null);
              setPeerWorkMode(r.data?.[peerFromParam]?.workMode ?? null);
            }
          })
          .catch(() => {});
        // The header name/avatar were supplied alongside the peer id — nothing
        // to resolve. (This is the conversation-list open path.)
        if (haveIdentity) return;
      }

      // Resolve identity from the cached conversation list FIRST (synchronous,
      // no network) so deep-links / notification taps light up the header
      // when the cache is warm.
      const cachedConvs = getCachedConversations();
      const conv = (cachedConvs || []).find((c) => c.id === convId);
      if (conv) {
        applyConv(conv);
      }

      // If identity is STILL unresolved (cold cache after a notification cold-
      // start — the #1 case for "tapping a message shows 'Chat' + '?'"), fetch
      // the conversation list from the network and backfill. Mirrors Signal-
      // Android resolving the recipient from its id on a notification launch.
      if (!haveIdentity && !conv) {
        getConversations()
          .then((r) => {
            if (!active) return;
            const fresh = (r.data || []).find((c) => c.id === convId);
            if (fresh) applyConv(fresh);
          })
          .catch(() => {});
      }
    });

    return () => {
      active = false;
      task.cancel();
    };
  }, [
    convId,
    paramPeerId,
    paramName,
    paramAvatar,
    paramGroupMemberAvatars,
  ]);

  // Keep the peer's header status live via the unified `user_status` event.
  useEffect(() => {
    const off = socket.subscribe((msg) => {
      if (msg.type !== "user_status") return;
      if (!peerUserId || msg.data?.userId !== peerUserId) return;
      setPeerStatus(msg.data.effective);
    });
    return off;
  }, [peerUserId]);

  // Block / unblock the 1:1 peer (Signal parity — the peer is never notified).
  function doToggleBlock() {
    if (!peerUserId) return;
    if (isBlocked) {
      unblockUser(peerUserId)
        .then(() => setIsBlocked(false))
        .catch(() => {});
      return;
    }
    confirm({
      title: `Block ${name || "this user"}?`,
      message:
        "Blocked people can't send you messages or call you. They won't be notified.",
      confirmText: "Block",
      isDanger: true,
      onConfirm: () => {
        blockUser(peerUserId)
          .then(() => setIsBlocked(true))
          .catch(() => {});
      },
    });
  }

  // Status line under the chat name (mirrors the web ChatHeader meta line):
  // member count for groups, live effective status for 1:1 chats.
  const headerSubtitle = isGroupConv
    ? participantCount
      ? `${participantCount} members`
      : ""
    : peerStatus
      ? STATUS_LABEL[peerStatus] || peerStatus
      : "";

  return {
    name,
    headerAvatar,
    isGroupConv,
    groupMemberAvatars,
    myGroupRole,
    groupDescription,
    peerUserId,
    peerStatus,
    peerWorkMode,
    participantCount,
    isBlocked,
    headerSubtitle,
    doToggleBlock,
  };
}
