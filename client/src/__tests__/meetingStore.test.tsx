/**
 * Tests for the zero-dependency selector store.
 * Covers both the imperative API (getState / setState / subscribe) and
 * the React hook surface (useStore with selectors + equality fns).
 */
import { describe, it, expect, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { createMeetingStore, shallowEqual, DEFAULT_MEETING_STATE } from "../pages/meeting/meetingStore";

describe("createMeetingStore — imperative API", () => {
    it("seeds with the initial state and returns it from getState()", () => {
        const useStore = createMeetingStore({ a: 1, b: "x" });
        expect(useStore.getState()).toEqual({ a: 1, b: "x" });
    });

    it("setState merges shallowly and notifies subscribers", () => {
        const useStore = createMeetingStore({ a: 1, b: "x" });
        const spy = vi.fn();
        useStore.subscribe(spy);
        useStore.setState({ a: 2 });
        expect(useStore.getState()).toEqual({ a: 2, b: "x" });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenLastCalledWith({ a: 2, b: "x" });
    });

    it("setState(fn) gets the current state and merges the return value", () => {
        const useStore = createMeetingStore({ count: 1 });
        useStore.setState((prev: any) => ({ count: prev.count + 1 }));
        useStore.setState((prev: any) => ({ count: prev.count + 1 }));
        expect(useStore.getState().count).toBe(3);
    });

    it("setState(null) is a safe no-op (no merge, no notify)", () => {
        const useStore = createMeetingStore({ a: 1 });
        const spy = vi.fn();
        useStore.subscribe(spy);
        useStore.setState(null as any);
        useStore.setState(undefined as any);
        expect(useStore.getState()).toEqual({ a: 1 });
        expect(spy).not.toHaveBeenCalled();
    });

    it("subscribe returns an unsubscribe fn", () => {
        const useStore = createMeetingStore({ a: 1 });
        const spy = vi.fn();
        const unsub = useStore.subscribe(spy);
        useStore.setState({ a: 2 });
        expect(spy).toHaveBeenCalledTimes(1);
        unsub();
        useStore.setState({ a: 3 });
        expect(spy).toHaveBeenCalledTimes(1); // not called again
    });
});

describe("useStore (React hook with selectors)", () => {
    function renderWithStore(useStore: any, selector?: any, equalityFn?: any) {
        const renderSpy = vi.fn();
        function Probe() {
            const val = useStore(selector, equalityFn);
            renderSpy(val);
            return null;
        }
        const utils = render(<Probe />);
        return { ...utils, renderSpy };
    }

    it("returns the whole state when no selector passed", () => {
        const useStore = createMeetingStore({ a: 1, b: 2 });
        const { renderSpy } = renderWithStore(useStore);
        expect(renderSpy).toHaveBeenLastCalledWith({ a: 1, b: 2 });
    });

    it("subscribing to a single field only re-renders when that field changes", () => {
        const useStore = createMeetingStore({ muted: false, count: 0 });
        const { renderSpy } = renderWithStore(useStore, (s: any) => s.muted);
        // Change an UNRELATED field → no re-render.
        act(() => useStore.setState({ count: 5 }));
        expect(renderSpy).toHaveBeenCalledTimes(1);
        // Change the watched field → exactly one re-render.
        act(() => useStore.setState({ muted: true }));
        expect(renderSpy).toHaveBeenCalledTimes(2);
        expect(renderSpy).toHaveBeenLastCalledWith(true);
    });

    it("shallowEqual prevents re-render when a derived object is structurally identical", () => {
        const useStore = createMeetingStore({ a: 1, b: 2, c: 3 });
        const { renderSpy } = renderWithStore(useStore, (s: any) => ({ a: s.a, b: s.b }), shallowEqual);
        // Bump an unrelated field → derived object still {a:1,b:2}; no re-render.
        act(() => useStore.setState({ c: 99 }));
        expect(renderSpy).toHaveBeenCalledTimes(1);
        // Bump a watched field → re-render.
        act(() => useStore.setState({ a: 7 }));
        expect(renderSpy).toHaveBeenCalledTimes(2);
        expect(renderSpy).toHaveBeenLastCalledWith({ a: 7, b: 2 });
    });
});

describe("shallowEqual", () => {
    it("returns true for the same reference", () => {
        const o = { a: 1 };
        expect(shallowEqual(o, o)).toBe(true);
        expect(shallowEqual(null, null)).toBe(true);
    });
    it("returns true for structurally identical 1-level objects", () => {
        expect(shallowEqual({ a: 1, b: "x" }, { a: 1, b: "x" })).toBe(true);
    });
    it("returns false when any value differs", () => {
        expect(shallowEqual({ a: 1 }, { a: 2 })).toBe(false);
    });
    it("returns false when key sets differ", () => {
        expect(shallowEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
        expect(shallowEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    });
    it("handles null vs object gracefully", () => {
        expect(shallowEqual(null, { a: 1 })).toBe(false);
        expect(shallowEqual({ a: 1 }, null)).toBe(false);
    });
    it("does NOT recurse — nested object differences are not seen", () => {
        // This is intentional: shallowEqual only compares top-level.
        // Callers that need deep semantics should pluck the leaf in the
        // selector instead.
        expect(shallowEqual({ a: { x: 1 } }, { a: { x: 1 } })).toBe(false);
    });
});

describe("DEFAULT_MEETING_STATE shape contract", () => {
    it("is a frozen object with every public field present", () => {
        // Lock the shape so a future "I added a state field to the hook
        // but forgot to mirror it in the store" doesn't slip in silently.
        expect(Object.isFrozen(DEFAULT_MEETING_STATE)).toBe(true);
        const expectedKeys = [
            "localStream",
            "screenStream",
            "muted",
            "videoOff",
            "screenSharing",
            "participants",
            "presenterId",
            "activeSpeakerId",
            "status",
            "fsmState",
            "connectionBanner",
            "connectionQualities",
            "activePanel",
            "raisedHand",
            "messages",
        ];
        for (const k of expectedKeys) {
            expect(Object.prototype.hasOwnProperty.call(DEFAULT_MEETING_STATE, k)).toBe(true);
        }
    });
});