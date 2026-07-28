import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRef } from "react";
import useScrollPin from "../pages/chat/useScrollPin";
import { NEAR_BOTTOM_PX } from "../pages/chat/chatUtils";

/**
 * jsdom has no layout engine: scrollHeight/clientHeight are always 0 and
 * assigning scrollTop is not clamped. We therefore model the message list as a
 * fake scroller whose height we control, which is exactly what these tests
 * need — the bug is about WHEN the pin runs relative to content growth, not
 * about real pixel layout.
 */
function makeScroller(opts: { contentHeight: number; viewport: number }) {
    const el = document.createElement("div");
    let contentHeight = opts.contentHeight;
    let scrollTop = 0;

    Object.defineProperty(el, "scrollHeight", { get: () => contentHeight });
    Object.defineProperty(el, "clientHeight", { get: () => opts.viewport });
    Object.defineProperty(el, "scrollTop", {
        get: () => scrollTop,
        set: (v: number) => {
            // Match browser clamping so an over-large assignment can't hide a bug.
            scrollTop = Math.max(0, Math.min(v, contentHeight - opts.viewport));
            el.dispatchEvent(new Event("scroll"));
        },
    });

    // A child element so the hook has scrollable CONTENT to observe.
    const content = document.createElement("div");
    el.appendChild(content);
    document.body.appendChild(el);

    return {
        el,
        content,
        /** Simulate late-loading media growing the thread. */
        grow(by: number) {
            contentHeight += by;
        },
        get scrollTop() {
            return scrollTop;
        },
        /** Distance from the bottom, i.e. how far off "latest" we are. */
        get distanceFromBottom() {
            return contentHeight - scrollTop - opts.viewport;
        },
    };
}

/** Drive the nested requestAnimationFrame callbacks the hook schedules. */
async function flushFrames(count = 4) {
    for (let i = 0; i < count; i++) {
        await act(async () => {
            vi.advanceTimersByTime(16);
        });
    }
}

function renderPin(
    scroller: ReturnType<typeof makeScroller>,
    opts?: { isEmpty?: boolean },
) {
    return renderHook(() => {
        const containerRef = useRef<HTMLDivElement | null>(scroller.el);
        return useScrollPin({
            containerRef,
            conversationId: 42,
            loading: false,
            isEmpty: opts?.isEmpty ?? false,
        });
    });
}

describe("useScrollPin — opening a chat lands on the latest message", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        // jsdom lacks rAF under fake timers; drive it off the timer queue so
        // advanceTimersByTime flushes the hook's frames deterministically.
        vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
            setTimeout(() => cb(Date.now()), 16) as unknown as number,
        );
        vi.stubGlobal("cancelAnimationFrame", (id: number) =>
            clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
        );
        // jsdom ships no ResizeObserver. The real one cannot fire in a
        // layout-less DOM anyway, so a no-op stub keeps these tests honest:
        // they prove the `load`-capture path alone recovers from late media.
        vi.stubGlobal(
            "ResizeObserver",
            class {
                observe() {}
                unobserve() {}
                disconnect() {}
            },
        );
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
        document.body.innerHTML = "";
    });

    it("pins to the bottom on first paint", async () => {
        const scroller = makeScroller({ contentHeight: 2000, viewport: 500 });
        renderPin(scroller);

        await flushFrames();

        expect(scroller.distanceFromBottom).toBe(0);
    });

    it("re-pins when a late image load grows the thread (the desktop bug)", async () => {
        const scroller = makeScroller({ contentHeight: 2000, viewport: 500 });
        renderPin(scroller);
        await flushFrames();
        expect(scroller.distanceFromBottom).toBe(0);

        // A proxied attachment finally decodes and expands the timeline by
        // ~250px, pushing the newest message below the fold. Before the fix
        // nothing was listening for this: the ResizeObserver watched only the
        // (fixed-height) viewport and `load` never bubbled, so the view stayed
        // parked 250px up and the user had to scroll down by hand.
        await act(async () => {
            scroller.grow(250);
            scroller.content.dispatchEvent(
                new Event("load", { bubbles: false }),
            );
        });
        await flushFrames();

        expect(scroller.distanceFromBottom).toBe(0);
    });

    it("re-pins when an image errors and collapses its reserved box", async () => {
        const scroller = makeScroller({ contentHeight: 2000, viewport: 500 });
        renderPin(scroller);
        await flushFrames();

        await act(async () => {
            scroller.grow(120);
            scroller.content.dispatchEvent(
                new Event("error", { bubbles: false }),
            );
        });
        await flushFrames();

        expect(scroller.distanceFromBottom).toBe(0);
    });

    it("does not treat its own pin as a user scroll", async () => {
        const scroller = makeScroller({ contentHeight: 2000, viewport: 500 });
        const { result } = renderPin(scroller);

        await flushFrames();

        // pin() assigns scrollTop, which fires a `scroll` event. If that were
        // mistaken for user intent the hook would lock itself out of every
        // further re-pin on the very first frame.
        expect(result.current.userScrolledUpRef.current).toBe(false);
    });

    it("stops following once the user scrolls up, and stays put", async () => {
        const scroller = makeScroller({ contentHeight: 2000, viewport: 500 });
        const { result } = renderPin(scroller);
        await flushFrames();

        // User scrolls well clear of the bottom.
        await act(async () => {
            scroller.el.scrollTop = 600;
        });
        await flushFrames();

        expect(result.current.userScrolledUpRef.current).toBe(true);

        const parked = scroller.scrollTop;
        await act(async () => {
            scroller.grow(300);
            scroller.content.dispatchEvent(
                new Event("load", { bubbles: false }),
            );
        });
        await flushFrames();

        // Reading history must not be interrupted by late media.
        expect(scroller.scrollTop).toBe(parked);
    });

    it("resumes following when the user scrolls back to the bottom", async () => {
        const scroller = makeScroller({ contentHeight: 2000, viewport: 500 });
        const { result } = renderPin(scroller);
        await flushFrames();

        await act(async () => {
            scroller.el.scrollTop = 600;
        });
        expect(result.current.userScrolledUpRef.current).toBe(true);

        // Scroll back to just inside the "at latest" band.
        await act(async () => {
            scroller.el.scrollTop = 1500 - (NEAR_BOTTOM_PX - 10);
        });

        expect(result.current.userScrolledUpRef.current).toBe(false);
    });

    it("still pins a conversation that finished loading empty", async () => {
        const scroller = makeScroller({ contentHeight: 2000, viewport: 500 });
        // isEmpty=true previously hit an early return that, with a dep array
        // ignoring the message count, could never re-run.
        renderPin(scroller, { isEmpty: true });

        await flushFrames();

        expect(scroller.distanceFromBottom).toBe(0);
    });
});
