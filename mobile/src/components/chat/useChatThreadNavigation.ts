import { useCallback } from "react";
import { BackHandler } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { useDialog } from "../../hooks/useDialog";
import { createMeeting } from "../../features";

type UseChatThreadNavigationOptions = {
  convId: number;
  name: string;
  headerAvatar: string;
  peerUserId: number | null;
  isGroupConv: boolean;
  groupMemberAvatars: string[];
  peerStatus: string;
  peerWorkMode: string;
  participantCount: number;
  myGroupRole: string;
  groupDescription: string;
  selectionMode: boolean;
  clearSelection: () => void;
  searchMode: boolean;
  closeSearch: () => void;
  alert: ReturnType<typeof useDialog>["alert"];
};

/**
 * Everything that leaves this screen: hardware/header back (which first unwinds
 * selection then search), the Signal-style sub-screens reached from the header /
 * overflow menu, and starting a 1:1 or group call.
 */
export default function useChatThreadNavigation({
  convId,
  name,
  headerAvatar,
  peerUserId,
  isGroupConv,
  groupMemberAvatars,
  peerStatus,
  peerWorkMode,
  participantCount,
  myGroupRole,
  groupDescription,
  selectionMode,
  clearSelection,
  searchMode,
  closeSearch,
  alert,
}: UseChatThreadNavigationOptions) {
  const router = useRouter();

  const goBackToChatList = useCallback(() => {
    // Prefer a real stack pop so the already-painted chat list remains behind
    // the thread during Android/iOS back gestures. If this thread was launched
    // as a root route (cold notification/deep link), fall back to the chat tab.
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace("/(tabs)/chat" as never);
  }, [router]);

  const handleThreadBack = useCallback(() => {
    if (selectionMode) {
      clearSelection();
      return true;
    }
    if (searchMode) {
      closeSearch();
      return true;
    }
    goBackToChatList();
    return true;
  }, [goBackToChatList, searchMode, selectionMode]);

  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener(
        "hardwareBackPress",
        handleThreadBack,
      );
      return () => sub.remove();
    }, [handleThreadBack]),
  );

  // ── Signal-style navigation: header → profile, overflow → sub-screens ──
  const baseParams = {
    id: String(convId),
    name: name || "",
    avatar: headerAvatar || "",
    peerId: peerUserId ? String(peerUserId) : "",
    isGroup: isGroupConv ? "1" : "0",
    groupMemberAvatars: JSON.stringify(groupMemberAvatars),
    peerStatus: peerStatus || "",
    peerWorkMode: peerWorkMode || "",
    memberCount: String(participantCount),
    myRole: myGroupRole,
    description: groupDescription,
  };

  function openInfo() {
    router.push({ pathname: "/chat/info", params: baseParams });
  }

  function openSearchScreen() {
    router.push({
      pathname: "/chat/search",
      params: { id: String(convId), name: name || "" },
    });
  }

  function openSharedMedia(
    tab: "images" | "videos" | "media" | "files" | "links" = "images",
  ) {
    router.push({
      pathname: "/chat/shared",
      params: { id: String(convId), name: name || "", tab },
    });
  }

  function openPinnedScreen() {
    router.push({
      pathname: "/chat/saved",
      params: { id: String(convId), name: name || "", mode: "pinned" },
    });
  }

  function openSavedScreen() {
    router.push({
      pathname: "/chat/saved",
      params: { id: String(convId), name: name || "", mode: "saved" },
    });
  }

  function startCall(type: "voice" | "video") {
    if (isGroupConv) {
      void startGroupCall(type);
      return;
    }
    router.push({
      pathname: "/call/[conversationId]",
      params: {
        conversationId: String(convId),
        mode: "outgoing",
        callType: type,
        peerName: name || "Call",
        peerAvatar: headerAvatar || "",
        isGroup: isGroupConv ? "1" : "0",
      },
    });
  }

  // Start an instant GROUP CALL (huddle). The group stays a pure chat group:
  // the server creates a hidden huddle (no "Meeting:" rename / no meeting card /
  // no calendar artifact) bound to THIS conversation and RINGS every member with
  // `call_incoming` (Signal-style group call). The initiator joins the n-way
  // mesh by navigating to the meeting room with the returned code.
  async function startGroupCall(type: "voice" | "video") {
    try {
      const { data } = await createMeeting({
        title: name || "Group call",
        conversation_id: convId,
        huddle: true,
        settings: { allowScreenShare: true, callType: type },
      });
      const code = data?.meeting_code;
      if (code) {
        // Huddle auto-join (no meeting lobby) + audio-only for a voice call.
        router.push(`/meeting/${code}?huddle=1&callType=${type}` as never);
      } else {
        alert(
          "Call failed",
          "Could not start the group call. Please try again.",
        );
      }
    } catch {
      alert("Call failed", "Could not start the group call. Please try again.");
    }
  }

  return {
    goBackToChatList,
    handleThreadBack,
    openInfo,
    openSearchScreen,
    openSharedMedia,
    openPinnedScreen,
    openSavedScreen,
    startCall,
    startGroupCall,
  };
}
