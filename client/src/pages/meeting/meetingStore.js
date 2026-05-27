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
 *
 *   const useMeetingStore = createMeetingStore(initialState);
 *
 *   // Subscribe to one field — re-renders only when that field changes.
 *   const muted = useMeetingStore(s => s.muted);
 *
 *   // Read once (e.g. inside an event handler) — no subscription.
 *   const { muted, participants } = useMeetingStore.getState();
 *
 *   // Mutate — partial state merge (same semantics as setState({...})).
 *   useMeetingStore.setState({ muted: true });
 *   useMeetingStore.setState(prev => ({ count: prev.count + 1 }));
 *
 *   // Subscribe imperatively (no React) — useful for refs / effects.
 *   const unsub = useMeetingStore.subscribe(state => { ... });
 */
import { useSyncExternalStore } from 'react';

/**
 * Build a store with the same surface as a Zustand store.
 * Returns a `useStore` hook + bare `getState` / `setState` / `subscribe`.
 */
export function createMeetingStore(initialState) {
    let state = initialState;
    const listeners = new Set();

    const getState = () => state;

    const setState = (partialOrFn) => {
        const next = typeof partialOrFn === 'function' ? partialOrFn(state) : partialOrFn;
        if (next == null) return;
        // Shallow merge — same as React's setState. We DO NOT do a deep
        // compare here; selectors handle render-skipping themselves.
        const merged = { ...state, ...next };
        if (merged === state) return;
        state = merged;
        for (const l of listeners) l(state);
    };

    const subscribe = (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
    };

    /**
     * React hook. Accepts an optional selector + optional equality fn.
     *   useStore()                            → whole state
     *   useStore(s => s.muted)                → just the muted field
     *   useStore(s => s.participants, shallow) → shallow-compare so a new
     *                                            but equivalent Map ref
     *                                            doesn't re-render.
     *
     * Implementation uses `useSyncExternalStore` to be Concurrent-safe
     * and to avoid the classic "store update during render" tearing
     * problem.
     */
    function useStore(selector = identity, equalityFn = Object.is) {
        // We have to memoise the snapshot per-render so identical
        // selector outputs return the same ref. useSyncExternalStore
        // will call this on every store change and shallow-compare with
        // the previous snapshot via `equalityFn` (well, `Object.is` —
        // we handle equalityFn ourselves below).
        let lastValue;
        let hasLast = false;
        const getSelectedSnapshot = () => {
            const next = selector(state);
            if (hasLast && equalityFn(lastValue, next)) return lastValue;
            lastValue = next;
            hasLast = true;
            return lastValue;
        };
        return useSyncExternalStore(subscribe, getSelectedSnapshot, getSelectedSnapshot);
    }

    useStore.getState = getState;
    useStore.setState = setState;
    useStore.subscribe = subscribe;
    /** Test-only: wipe + re-seed. */
    useStore._resetForTests = (next) => { state = next; for (const l of listeners) l(state); };

    return useStore;
}

const identity = (x) => x;

/**
 * Shallow equality helper. Use as the second arg to a selector when you
 * pluck an object or array — saves a re-render when the new ref is
 * structurally identical to the previous.
 *   const visible = useStore(s => s.tiles.filter(visiblePred), shallowEqual);
 */
export function shallowEqual(a, b) {
    if (Object.is(a, b)) return true;
    if (typeof a !== 'object' || a === null) return false;
    if (typeof b !== 'object' || b === null) return false;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
        if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
        if (!Object.is(a[k], b[k])) return false;
    }
    return true;
}

/**
 * The initial shape mirrors the public surface of `useMeetingState`'s
 * return value, so a future swap-in is a textual replacement at the
 * call site. Callbacks/refs are NOT included — they stay in the hook,
 * the store is for *state*.
 *
 * Adopting this incrementally: components can start subscribing to
 * `useMeetingStore` for one slice at a time while the rest still flow
 * through the original hook. The hook can keep `useMeetingStore.setState`
 * in sync — see ADR-008 for the migration plan.
 */
export const DEFAULT_MEETING_STATE = Object.freeze({
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
    status: 'joining',
    fsmState: 'idle',
    connectionBanner: { label: '', severity: 'info', showBanner: false },
    connectionQualities: new Map(),
    // UI
    activePanel: null,
    raisedHand: false,
    // Chat (the Phase 0.5 module-cache becomes redundant once this is
    // adopted; both are kept in sync during the migration window so
    // remounts continue to seed instantly).
    messages: [],
});