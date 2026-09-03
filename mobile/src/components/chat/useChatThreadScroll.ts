import { useCallback, useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import type { FlashListRef } from "@shopify/flash-list";
import type { ChatMessage } from "../../features";

export type PendingTailScroll = {
  animated: boolean;
  requireUntouchedOpen?: boolean;
};

type UseChatThreadScrollOptions = {
  messages: ChatMessage[];
  messagesRef: MutableRefObject<ChatMessage[]>;
  mountedRef: MutableRefObject<boolean>;
  /** False when the open targets a specific message (notification tap). */
  allowInitialTailScroll: boolean;
};

/**
 * Scroll ownership for the thread list: tail-pinning intent, the bounded
 * measurement settle loop used on first layout, at-bottom tracking and the
 * targeted `jumpToMessage`.
 *
 * The refs are returned so the loader / realtime coordinators can record scroll
 * intent (and revoke the "untouched open" privilege) exactly as before.
 */
export default function useChatThreadScroll({
  messages,
  messagesRef,
  mountedRef,
  allowInitialTailScroll,
}: UseChatThreadScrollOptions) {
  const listRef = useRef<FlashListRef<ChatMessage>>(null);
  // Whether the list is currently near the visual bottom (newest message).
  // We only auto-scroll to the newest message on an
  // INCOMING message when the user is already at the bottom — otherwise we keep
  // their scroll position (Signal-style) and let the floating "scroll to latest"
  // pill surface instead of yanking them down mid-read.
  const atBottomRef = useRef(true);
  // A stale warm cache may receive a genuinely newer server tail during the
  // first REST reconcile. Follow that tail only while this remains an untouched
  // normal open; a drag or any targeted jump permanently takes precedence.
  const initialReconcileTailAllowedRef = useRef(allowInitialTailScroll);
  // Tail appends are committed asynchronously. Record scroll intent and execute
  // it after the new last row is in FlashList; calling scrollToEnd immediately
  // after setMessages can only reach the old measured end.
  const pendingTailScrollRef = useRef<PendingTailScroll | null>(null);
  // `initialScrollIndex` is only an estimate until FlashList has measured the
  // variable-height message rows. The measurement-aware correction triggered by
  // FlashList's first `onLoad` runs a short, bounded settle loop (re-pinning to
  // the tail each frame while content height is still growing); these refs hold
  // the pending frame handle and the loop's start timestamp so it can be capped
  // and cancelled on unmount.
  const initialTailScrollFrameRef = useRef<number | null>(null);
  const initialTailSettleStartRef = useRef<number>(0);

  useEffect(
    () => () => {
      if (initialTailScrollFrameRef.current != null) {
        cancelAnimationFrame(initialTailScrollFrameRef.current);
        initialTailScrollFrameRef.current = null;
      }
    },
    [],
  );

  // Scroll to the newest message. FlashList renders the oldest-first data from
  // the bottom and preserves the visible position when history is prepended.
  const scrollToEnd = useCallback((animated = false) => {
    atBottomRef.current = true;
    listRef.current?.scrollToEnd({ animated });
  }, []);

  // FlashList applies `initialScrollIndex` before variable-height bubbles have
  // their final measurements, which can leave a normal chat open ABOVE the true
  // tail (the reported "not at the latest message on open" bug). `onLoad` only
  // fires after the FIRST layout — media / reply / reaction rows below the fold
  // are often still expanding at that point, and this FlashList's `scrollToEnd`
  // is itself async (scrollToIndex → setTimeout → scrollToEnd), so a single
  // correction lands short and nothing re-pins after later growth.
  //
  // Fix: run a short, BOUNDED settle loop. Each animation frame we re-pin to the
  // end and read the last row's measured bottom; while that keeps growing (rows
  // still expanding) we scroll again, stopping as soon as it stabilises or a
  // small cap (~8 frames / ~250ms) is reached. `onPositioned` is invoked only
  // once the position has settled so the caller can reveal the list already at
  // the newest message (no visible jump). Targeted opens (notification / search
  // / pinned / reply) and any user interaction disable this through the same
  // `initialReconcileTailAllowedRef` guard used by the stale-cache reconcile —
  // in those cases we reveal immediately without forcing the tail.
  const onListLoad = useCallback(
    (onPositioned?: () => void) => {
      if (
        !initialReconcileTailAllowedRef.current ||
        messagesRef.current.length === 0
      ) {
        onPositioned?.();
        return;
      }
      if (initialTailScrollFrameRef.current != null) {
        cancelAnimationFrame(initialTailScrollFrameRef.current);
        initialTailScrollFrameRef.current = null;
      }

      const MAX_SETTLE_MS = 250;
      const MAX_SETTLE_FRAMES = 8;
      initialTailSettleStartRef.current = Date.now();

      // Reachable bottom of the last row. Prefer the measured layout; fall back
      // to the child container height when a build doesn't expose getLayout.
      const measureBottom = (): number => {
        const list = listRef.current;
        if (!list) return 0;
        const lastIndex = messagesRef.current.length - 1;
        try {
          const layout = list.getLayout?.(lastIndex);
          if (layout) return layout.y + layout.height;
        } catch {
          /* getLayout can throw before the row is measured — ignore */
        }
        try {
          const dims = (
            list as unknown as {
              getChildContainerDimensions?: () => { height: number };
            }
          ).getChildContainerDimensions?.();
          if (dims) return dims.height;
        } catch {
          /* optional API — ignore */
        }
        return 0;
      };

      // Guarantee the list is revealed exactly once even if the loop is aborted.
      let revealed = false;
      const reveal = () => {
        if (revealed) return;
        revealed = true;
        onPositioned?.();
      };

      let prevBottom = -1;
      let frameCount = 0;

      const step = () => {
        initialTailScrollFrameRef.current = null;
        // Component gone, or a drag / targeted jump took precedence: stop
        // forcing the tail and reveal whatever the user is now looking at.
        if (!mountedRef.current || !initialReconcileTailAllowedRef.current) {
          reveal();
          return;
        }

        scrollToEnd(false);

        const bottom = measureBottom();
        const grew = bottom > prevBottom + 0.5;
        prevBottom = bottom;
        frameCount += 1;

        const elapsed = Date.now() - initialTailSettleStartRef.current;
        const capped =
          frameCount >= MAX_SETTLE_FRAMES || elapsed >= MAX_SETTLE_MS;

        if (grew && !capped) {
          // Rows still expanding — pin again next frame.
          initialTailScrollFrameRef.current = requestAnimationFrame(step);
          return;
        }

        // Height stabilised (or cap hit): one final pin, then reveal.
        scrollToEnd(false);
        reveal();
      };

      initialTailScrollFrameRef.current = requestAnimationFrame(step);
    },
    [mountedRef, messagesRef, scrollToEnd],
  );

  const requestTailScroll = useCallback((animated = true) => {
    pendingTailScrollRef.current = { animated };
  }, []);

  const newestMessageKey =
    messages.length > 0
      ? (messages[messages.length - 1].clientMsgId ??
        String(messages[messages.length - 1].id))
      : null;

  // FlashList's old autoscroll threshold treated `80` as 80 VIEWPORTS, not
  // pixels, and could jump from nearly anywhere on every prepend. Tail scrolling
  // is now explicit and only armed by a genuine append/send.
  useEffect(() => {
    const pending = pendingTailScrollRef.current;
    if (!pending || newestMessageKey == null) return;
    pendingTailScrollRef.current = null;
    const frame = requestAnimationFrame(() => {
      if (!mountedRef.current) return;
      if (
        pending.requireUntouchedOpen &&
        !initialReconcileTailAllowedRef.current
      )
        return;
      scrollToEnd(pending.animated);
      if (pending.requireUntouchedOpen) {
        initialReconcileTailAllowedRef.current = false;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [mountedRef, newestMessageKey, scrollToEnd]);

  // Track whether the list is near the visual bottom. The chat screen forwards
  // the already-computed distance from the bottom here. This
  // gates the incoming-message auto-scroll so a new message never yanks the
  // user down while they're reading history (Signal keeps the position and
  // surfaces the "scroll to latest" pill instead).
  const onListScroll = useCallback((distanceFromBottom: number) => {
    atBottomRef.current = distanceFromBottom <= 80;
  }, []);

  const onListInteraction = useCallback(() => {
    initialReconcileTailAllowedRef.current = false;
  }, []);

  function jumpToMessage(messageId: number) {
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return;
    initialReconcileTailAllowedRef.current = false;
    try {
      void listRef.current?.scrollToIndex({
        index: idx,
        animated: true,
        viewPosition: 0.3,
      });
    } catch {
      /* ignore */
    }
  }

  return {
    listRef,
    atBottomRef,
    initialReconcileTailAllowedRef,
    pendingTailScrollRef,
    scrollToEnd,
    onListLoad,
    requestTailScroll,
    onListScroll,
    onListInteraction,
    jumpToMessage,
  };
}
