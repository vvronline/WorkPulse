import { useMemo } from "react";
import { useAuth } from "../../auth/AuthContext";
import type { ChatMessage } from "../../features";
import { isSameDay } from "./chatUtils";
import type { MessageDeliveryPhase } from "./MsgTicks";

type ThreadUser = ReturnType<typeof useAuth>["user"];

type UseChatListPresentationOptions = {
  visibleMessages: ChatMessage[];
  readReceipts: Record<number, string>;
  participantCount: number;
  user: ThreadUser;
  starredIds: Set<number>;
  selectedIds: Set<number>;
  highlightedId: number | null;
  selectionMode: boolean;
};

/**
 * Signal-Android-style precomputed row bind metadata for the message list.
 *
 * Signal's ConversationAdapter resolves per-row presentation ONCE when a page is
 * built, not on every RecyclerView bind. These memos do the same: grouping / day
 * dividers, pre-parsed receipt timestamps, the compact per-row delivery phase,
 * and the small `extraData` object the list re-binds on.
 */
export default function useChatListPresentation({
  visibleMessages,
  readReceipts,
  participantCount,
  user,
  starredIds,
  selectedIds,
  highlightedId,
  selectionMode,
}: UseChatListPresentationOptions) {
  // Signal-Android-style precomputed row bind metadata. Signal's
  // ConversationAdapter resolves per-row presentation (grouping, day dividers)
  // ONCE when a page is built, not on every RecyclerView bind. Here the FlatList
  // `renderItem` previously recomputed consecutive-grouping + day-divider for
  // EVERY visible row on EVERY render — each row parsing two `new Date(...)`
  // timestamps. On a busy thread that is hundreds of Date parses per render pass
  // (scroll, typing pulse, receipt update…), all on the JS thread. We compute it
  // ONCE per `visibleMessages` change and let `renderItem` do an O(1) lookup,
  // keyed by the same stable id the list keys by (clientMsgId ?? id). Because
  // the memoized MessageBubble's inputs are unchanged, this also stops rows from
  // re-binding when unrelated state changes.
  const rowMeta = useMemo(() => {
    const GROUP_WINDOW_MS = 300000; // 5 min — same-sender consecutive grouping
    const within = (a?: ChatMessage, b?: ChatMessage) => {
      if (!a || !b) return false;
      if (a.sender_id !== b.sender_id) return false;
      const ta = new Date(a.created_at).getTime();
      const tb = new Date(b.created_at).getTime();
      return Math.abs(tb - ta) <= GROUP_WINDOW_MS;
    };
    const map = new Map<
      string,
      { firstInGroup: boolean; lastInGroup: boolean; showDaySeparator: boolean }
    >();
    for (let index = 0; index < visibleMessages.length; index++) {
      const item = visibleMessages[index];
      const prev = visibleMessages[index - 1]; // older, above
      const next = visibleMessages[index + 1]; // newer, below
      const key = item.clientMsgId ?? String(item.id);
      map.set(key, {
        firstInGroup: !within(prev, item),
        lastInGroup: !within(item, next),
        showDaySeparator: !prev || !isSameDay(prev.created_at, item.created_at),
      });
    }
    return map;
  }, [visibleMessages]);

  // Pre-parse read receipt timestamps ONCE per receipt-map change. Previously
  // every own visible MsgTicks row did `Object.entries(readReceipts)` plus
  // `new Date(readAt)` parsing during render. On text-only threads with many
  // own messages, that became repeated O(visibleRows × participants) JS work on
  // every open/reconcile. Signal computes delivery state from a cached receipt
  // model; this gives each row a tiny numeric array instead of reparsing dates.
  const readReceiptTimes = useMemo(
    () =>
      Object.entries(readReceipts)
        .map(
          ([uid, readAt]) => [Number(uid), new Date(readAt).getTime()] as const,
        )
        .filter(([, ts]) => Number.isFinite(ts)),
    [readReceipts],
  );

  // Signal's adapter binds a compact delivery payload, not the complete receipt
  // model, to every row. Build the same primitive phase once per receipt/message
  // update. Reader timestamps are sorted once and binary-searched, avoiding the
  // old Array.filter() in every mounted MsgTicks render.
  const deliveryPhaseByKey = useMemo(() => {
    const otherReadTimes = readReceiptTimes
      .filter(([uid]) => uid !== user?.id)
      .map(([, timestamp]) => timestamp)
      .sort((a, b) => a - b);
    const others = (participantCount || 2) - 1;
    const phases = new Map<string, MessageDeliveryPhase>();

    const readersAtOrAfter = (timestamp: number) => {
      let low = 0;
      let high = otherReadTimes.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (otherReadTimes[mid] < timestamp) low = mid + 1;
        else high = mid;
      }
      return otherReadTimes.length - low;
    };

    for (const message of visibleMessages) {
      const key = message.clientMsgId ?? String(message.id);
      let phase: MessageDeliveryPhase;
      if (message._pending || message.id < 0) {
        phase = "sending";
      } else if (others <= 0) {
        phase = "hidden";
      } else {
        const deliveredCount = message.delivered_to?.length ?? 0;
        const messageTime = new Date(message.created_at).getTime();
        const readerCount = Number.isFinite(messageTime)
          ? readersAtOrAfter(messageTime)
          : 0;
        if (
          readerCount >= others ||
          (readerCount > 0 && deliveredCount >= others)
        ) {
          phase = "read";
        } else if (deliveredCount > 0) {
          phase = "delivered";
        } else {
          phase = "sent";
        }
      }
      phases.set(key, phase);
    }
    return phases;
  }, [visibleMessages, participantCount, readReceiptTimes, user?.id]);

  // FlatList extraData. Keep this Signal-style targeted and O(1): message
  // content/reaction/pin/delete changes already arrive through immutable
  // `messages` updates (the FlatList `data` prop). extraData is only for
  // row-affecting state that lives outside the message object. The old
  // implementation built a giant string by scanning every message/reaction on
  // every recompute; opening a long chat could freeze the JS thread.
  const listExtraData = useMemo(
    () => ({
      starredIds,
      selectedIds,
      highlightedId,
      deliveryPhaseByKey,
      selectionMode,
      userId: user?.id,
    }),
    [
      starredIds,
      selectedIds,
      highlightedId,
      deliveryPhaseByKey,
      selectionMode,
      user?.id,
    ],
  );

  return { rowMeta, readReceiptTimes, deliveryPhaseByKey, listExtraData };
}
