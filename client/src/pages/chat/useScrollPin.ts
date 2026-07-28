import { useEffect, useRef } from "react";
import { NEAR_BOTTOM_PX, PIN_SETTLE_MS } from "./chatUtils";

interface ScrollPinOptions {
    /** Scrollable message list element. */
    containerRef: React.RefObject<HTMLDivElement | null>;
    /** Active conversation id — a change restarts the pin. */
    conversationId: string | number | null | undefined;
    /** True while the thread's history request is still in flight. */
    loading: boolean;
    /** True when the thread currently has no rows. */
    isEmpty: boolean;
}

interface ScrollPin {
    /**
     * True once the user has deliberately scrolled away from the newest
     * message. Consumers use it to stop auto-following, and reset it when the
     * user sends a message of their own.
     */
    userScrolledUpRef: React.MutableRefObject<boolean>;
}

/**
 * Keeps a freshly-opened conversation pinned to its newest message.
 *
 * Opening a conversation MUST land at the newest message. The incremental
 * auto-scroll in useChatState cannot do this on its own: it fires the instant
 * `setMessages` commits, at which point the skeleton block is still mounted,
 * images/avatars have not laid out, and the container height is about to
 * change completely.
 *
 * So we wait until loading finishes (skeleton unmounted, real rows committed),
 * hard-set `scrollTop` — instant, with no smooth animation to be stranded by a
 * competing scroll — and then re-pin as late-expanding content (attachments,
 * link previews) changes the scroll height, until the user scrolls up.
 */
export default function useScrollPin({
    containerRef,
    conversationId,
    loading,
    isEmpty,
}: ScrollPinOptions): ScrollPin {
    const userScrolledUpRef = useRef(false);
    // True while `pin()` is writing scrollTop, so the scroll listener can tell
    // our own programmatic jumps apart from a real user scroll.
    const programmaticScrollRef = useRef(false);

    useEffect(() => {
        userScrolledUpRef.current = false;
    }, [conversationId]);

    useEffect(() => {
        const container = containerRef.current;
        if (!conversationId || loading || !container) return;
        // NOTE: deliberately no bail-out on an empty thread. Combining that
        // early return with a dep array that ignored the message count used to
        // permanently skip the pin for a conversation that finished loading
        // empty — every later realtime message then had no owner for the
        // initial scroll. `isEmpty` is a dependency instead, so the pin starts
        // as soon as the first rows land.

        const pin = () => {
            const el = containerRef.current;
            if (!el || userScrolledUpRef.current) return;
            programmaticScrollRef.current = true;
            el.scrollTop = el.scrollHeight;
            // Released on the next frame: the `scroll` event this write queues
            // is delivered asynchronously, so clearing the flag synchronously
            // would let our own jump be misread as a user scroll.
            requestAnimationFrame(() => {
                programmaticScrollRef.current = false;
            });
        };

        // First paint of the real rows.
        const raf = requestAnimationFrame(() => {
            pin();
            // Second frame: catches rows whose height settled after the first.
            requestAnimationFrame(pin);
        });

        // The container is `flex: 1; overflow-y: auto` inside a chain of
        // fixed-height parents, so its BORDER BOX never changes when content
        // grows. Observing only the container (as the original fix did) fired
        // once on registration and then never again, making the whole re-pin
        // mechanism dead code. Observing the scrollable CONTENT is what
        // actually reports growth; the container is still observed so window /
        // composer resizes re-pin too.
        const observer = new ResizeObserver(() => pin());
        observer.observe(container);
        for (const child of Array.from(container.children)) {
            observer.observe(child);
        }

        // `load` does not bubble, so it must be captured. This catches every
        // attachment, avatar and link-preview thumbnail finishing — the events
        // that actually change the thread height on desktop, where each image
        // is proxied to a remote origin and lands long after the rAF pins.
        const onMediaSettled = () => pin();
        container.addEventListener("load", onMediaSettled, true);
        container.addEventListener("error", onMediaSettled, true);

        const release = () => {
            observer.disconnect();
            container.removeEventListener("load", onMediaSettled, true);
            container.removeEventListener("error", onMediaSettled, true);
        };
        const stopObserving = setTimeout(release, PIN_SETTLE_MS);

        const onUserScroll = () => {
            const el = containerRef.current;
            if (!el) return;
            // Ignore the scroll events generated by our own pin().
            if (programmaticScrollRef.current) return;
            const distanceFromBottom =
                el.scrollHeight - el.scrollTop - el.clientHeight;
            userScrolledUpRef.current = distanceFromBottom > NEAR_BOTTOM_PX;
        };
        // A plain `scroll` listener covers wheel, touch, keyboard (PageDown),
        // scrollbar drags and momentum alike — the previous wheel/touchmove
        // pair missed keyboard and scrollbar interaction entirely.
        container.addEventListener("scroll", onUserScroll, { passive: true });

        return () => {
            cancelAnimationFrame(raf);
            clearTimeout(stopObserving);
            release();
            container.removeEventListener("scroll", onUserScroll);
        };
    }, [containerRef, conversationId, loading, isEmpty]);

    return { userScrolledUpRef };
}
