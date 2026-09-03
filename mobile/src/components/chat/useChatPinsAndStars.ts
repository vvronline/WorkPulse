import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useDialog } from "../../hooks/useDialog";
import {
  getPinnedMessages,
  pinMessage,
  starMessage,
  type ChatMessage,
  type PinnedMessage,
} from "../../features";

type UseChatPinsAndStarsOptions = {
  convId: number;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setActionTarget: Dispatch<SetStateAction<ChatMessage | null>>;
  selectedMessages: ChatMessage[];
  clearSelection: () => void;
  alert: ReturnType<typeof useDialog>["alert"];
};

/**
 * Pinned-banner state and the pin / save (star) actions, for both the
 * single-message long-press path and the multi-select header actions.
 *
 * `loadPinned` is shared with the thread loader and the realtime `chat_pin`
 * handler, so it stays a stable callback keyed only by the conversation.
 */
export default function useChatPinsAndStars({
  convId,
  setMessages,
  setActionTarget,
  selectedMessages,
  clearSelection,
  alert,
}: UseChatPinsAndStarsOptions) {
  // Pinned messages (banner at the top of the chat).
  const [pinnedMsgs, setPinnedMsgs] = useState<PinnedMessage[]>([]);
  // Locally-tracked starred message ids (server list doesn't return per-message
  // starred state, so we reflect it optimistically after the action).
  const [starredIds, setStarredIds] = useState<Set<number>>(new Set());

  const loadPinned = useCallback(() => {
    getPinnedMessages(convId)
      .then((r) => setPinnedMsgs(r.data || []))
      .catch(() => {});
  }, [convId]);

  function doPin(message: ChatMessage) {
    setActionTarget(null);
    pinMessage(message.id)
      .then(({ data }) => {
        const pinned = !!(data as { pinned?: boolean })?.pinned;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === message.id
              ? { ...m, pinned_at: pinned ? new Date().toISOString() : null }
              : m,
          ),
        );
        loadPinned();
        alert(
          pinned ? "Pinned" : "Unpinned",
          pinned ? "Message pinned to this chat." : "Message unpinned.",
        );
      })
      .catch(() => alert("Error", "Could not pin message."));
  }

  function doStar(message: ChatMessage) {
    setActionTarget(null);
    starMessage(message.id)
      .then(({ data }) => {
        const starred = !!(data as { starred?: boolean })?.starred;
        setStarredIds((prev) => {
          const next = new Set(prev);
          if (starred) next.add(message.id);
          else next.delete(message.id);
          return next;
        });
        alert(
          starred ? "Saved" : "Removed",
          starred ? "Message added to saved." : "Removed from saved.",
        );
      })
      .catch(() => alert("Error", "Could not save message."));
  }

  function unpinFromBanner(messageId: number) {
    pinMessage(messageId)
      .then(() => {
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, pinned_at: null } : m)),
        );
        loadPinned();
      })
      .catch(() => {});
  }

  // ── Multi-select (Signal-style) ───────────────────────────────────────────
  // Pin / unpin every selected message (header pin icon). Pin toggles per
  // message; we simply call the pin endpoint for each and refresh the banner.
  function pinSelected() {
    const targets = [...selectedMessages];
    clearSelection();
    Promise.all(
      targets.map((m) =>
        pinMessage(m.id)
          .then(({ data }) => {
            const pinned = !!(data as { pinned?: boolean })?.pinned;
            setMessages((prev) =>
              prev.map((x) =>
                x.id === m.id
                  ? {
                      ...x,
                      pinned_at: pinned ? new Date().toISOString() : null,
                    }
                  : x,
              ),
            );
          })
          .catch(() => {}),
      ),
    ).finally(() => loadPinned());
  }

  // Save (star) every selected message (header save icon).
  function saveSelected() {
    const targets = [...selectedMessages];
    clearSelection();
    Promise.all(
      targets.map((m) =>
        starMessage(m.id)
          .then(({ data }) => {
            const starred = !!(data as { starred?: boolean })?.starred;
            setStarredIds((prev) => {
              const next = new Set(prev);
              if (starred) next.add(m.id);
              else next.delete(m.id);
              return next;
            });
          })
          .catch(() => {}),
      ),
    ).then(() => {
      setTimeout(() => alert("Saved", "Messages added to saved."), 200);
    });
  }

  const latestPin = pinnedMsgs[0];

  return {
    pinnedMsgs,
    setPinnedMsgs,
    latestPin,
    starredIds,
    setStarredIds,
    loadPinned,
    doPin,
    doStar,
    unpinFromBanner,
    pinSelected,
    saveSelected,
  };
}
