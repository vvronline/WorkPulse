/**
 * MeetingStore — selector-based, zero-dependency state container.
 *
 * Why
 * ───
 * `useMeetingState` returns ~25 separate React state values + ~15 callbacks.
 * Every consumer that destructures even one of them re-renders on every
 * state change, even unrelated ones (Chat panel re-renders when audio
 * level ticks; participant tile re-renders when chat fires). The hook
 * already does heavy work to avoid that (refs everywhere, single
 * setParticipants Map update for related fields), but the destructure
 * pattern leaks state churn into every leaf component.
 *
 * Phase 4 of the roadmap originally called for Zustand. We use a hand-
 * rolled equivalent here for three reasons:
 *
 *   1. The store is single-meeting scoped (one tab, one meeting) and
 *      lives behind a React-only consumer surface. We don't need
 *      cross-mount persistence, devtools middleware, vanilla store
 *      access, persist plugin, etc.
 *   2. Zero new runtime deps — saves ~3 KB gzip + skips the
 *      `useSyncExternalStore` shim Zustand brings.
 *   3. Drops into ~60 LoC. Easier to read than the Zustand-with-immer
 *      version of the same logic + trivially unit-testable.
 *
 * The contract is intentionally Zustand-shaped so we can swap to it
 * later without changing any call-site.
 */
import { useSyncExternalStore } from "react";

type Listener<S> = (state: S) => void;
type PartialOrFn<S> = Partial<S> | ((state: S) => Partial<S> | null | undefined);
type Selector<S, T> = (state: S) => T;
type EqualityFn<T> = (a: T, b: T) => boolean;

export interface MeetingStore<S> {
    <T = S>(selector?: Selector<S, T>, equalityFn?: EqualityFn<T>): T;
    getState: () => S;
    setState: (partialOrFn: PartialOrFn<S>) => void;
    subscribe: (listener: Listener<S>) => () => void;
    _resetForTests: (next: S) => void;
}

/**
 * Build a store with the same surface as a Zustand store.
 * Returns a `useStore` hook + bare `getState` / `setState` / `subscribe`.
 */
export function createMeetingStore<S extends object>(initialState: S): MeetingStore<S> {
    let state = initialState;
    const listeners = new Set<Listener<S>>();

    const getState = (): S => state;

    const setState = (partialOrFn: PartialOrFn<S>): void => {
        const next = typeof partialOrFn === "function" ? partialOrFn(state) : partialOrFn;
        if (next == null) return;
        // Shallow merge — same as React's setState. We DO NOT do a deep
        // compare here; selectors handle render-skipping themselves.
        const merged = { ...state, ...next };
        if (merged === state) return;
        state = merged;
        for (const l of listeners) l(state);
    };

    const subscribe = (listener: Listener<S>): (() => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    };

    /**
     * React hook. Accepts an optional selector + optional equality fn.
     *
     * Implementation uses `useSyncExternalStore` to be Concurrent-safe
     * and to avoid the classic "store update during render" tearing
     * problem.
     */
    function useStore<T = S>(
        selector: Selector<S, T> = identity as unknown as Selector<S, T>,
        equalityFn: EqualityFn<T> = Object.is,
    ): T {
        let lastValue: T;
        let hasLast = false;
        const getSelectedSnapshot = (): T => {
            const next = selector(state);
            if (hasLast && equalityFn(lastValue, next)) return lastValue;
            lastValue = next;
            hasLast = true;
            return lastValue;
        };
        return useSyncExternalStore(subscribe, getSelectedSnapshot, getSelectedSnapshot);
    }

    const store = useStore as MeetingStore<S>;
    store.getState = getState;
    store.setState = setState;
    store.subscribe = subscribe;
    /** Test-only: wipe + re-seed. */
    store._resetForTests = (next: S) => { state = next; for (const l of listeners) l(state); };

    return store;
}

const identity = <T>(x: T): T => x;

/**
 * Shallow equality helper. Use as the second arg to a selector when you
 * pluck an object or array — saves a re-render when the new ref is
 * structurally identical to the previous.
 */
export function shallowEqual(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (typeof a !== "object" || a === null) return false;
    if (typeof b !== "object" || b === null) return false;
    const aKeys = Object.keys(a as object);
    const bKeys = Object.keys(b as object);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
        if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
        if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
    }
    return true;
}

export interface ConnectionBanner {
    label: string;
    severity: string;
    showBanner: boolean;
}

export interface MeetingStateShape {
    localStream: MediaStream | null;
    screenStream: MediaStream | null;
    muted: boolean;
    videoOff: boolean;
    screenSharing: boolean;
    participants: Map<string | number, unknown>;
    presenterId: string | number | null;
    activeSpeakerId: string | number | null;
    status: string;
    fsmState: string;
    connectionBanner: ConnectionBanner;
    connectionQualities: Map<string | number, unknown>;
    activePanel: string | null;
    raisedHand: boolean;
    messages: unknown[];
}

/**
 * The initial shape mirrors the public surface of `useMeetingState`'s
 * return value, so a future swap-in is a textual replacement at the
 * call site. Callbacks/refs are NOT included — they stay in the hook,
 * the store is for *state*.
 */
export const DEFAULT_MEETING_STATE: MeetingStateShape = Object.freeze({
    // Media
    localStream: null,
    screenStream: null,
    muted: false,
    videoOff: false,
    screenSharing: false,
    // Peers
    participants: new Map(),
    presenterId: null,
    activeSpeakerId: null,
    // Connection
    status: "joining",
    fsmState: "idle",
    connectionBanner: { label: "", severity: "info", showBanner: false },
    connectionQualities: new Map(),
    // UI
    activePanel: null,
    raisedHand: false,
    // Chat
    messages: [],
});