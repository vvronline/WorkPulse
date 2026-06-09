/**
 * Per-meeting chat message cache (module-scope).
 *
 * Why this exists
 * ───────────────
 * In-meeting chat messages were "disappearing" for users on flaky networks.
 * The root cause was that `messages` lived only inside React state of
 * `useMeetingState`. Anything that remounted `MeetingRoom.jsx` (PiP swap-
 * back, navigation, Strict Mode double-invoke, theme switch, etc.) created
 * a fresh hook instance with an empty `messages` array. The history
 * re-hydration HTTP fetch then took ~200-800ms during which the panel
 * looked empty — users perceived this as data loss.
 *
 * This module survives across remounts by living at module scope. The hook
 * seeds its initial state from here and writes back on every change, so a
 * remount instantly shows the previous messages with zero flicker.
 *
 * Phase 4 of the broader meeting reliability plan replaces this cache with
 * a proper Zustand store; until then, this is the smallest possible fix
 * that closes the bug.
 *
 * The cache is intentionally NOT persisted to localStorage:
 *   • Chat history is already persisted server-side (GET /meetings/:code/messages)
 *   • Cross-tab leakage would be a privacy issue
 *   • Memory churn is bounded — entries are cleared on `clearMessagesCache`
 */

/** A meeting chat message. Permissive — the in-meeting chat shape is wide. */
export interface MeetingMessage {
    id?: number | string;
    clientMsgId?: string;
    sender_id?: number;
    text?: string;
    _optimistic?: boolean;
    _failed?: boolean;
    [key: string]: unknown;
}

type CacheKey = string | number;

/** keyed by meeting code (or id) */
const cache = new Map<string, MeetingMessage[]>();

/**
 * Read the cached messages for a meeting. Returns a shallow copy so React's
 * referential-equality checks fire on the first state update.
 */
export function getCachedMessages(code: CacheKey): MeetingMessage[] {
    if (!code) return [];
    const list = cache.get(String(code));
    return list ? list.slice() : [];
}

/**
 * Replace the cache for a meeting wholesale. Pass an empty array to clear
 * without removing the key.
 */
export function setCachedMessages(code: CacheKey, messages: MeetingMessage[]): void {
    if (!code) return;
    cache.set(String(code), Array.isArray(messages) ? messages.slice() : []);
}

/**
 * Idempotently merge a single message into the cache, with the same dedup
 * rules used inside the hook. Returns the new array (a copy).
 *
 * Dedup priorities, in order:
 *   1. By `id` — the server's persisted id wins; later writes never
 *      overwrite an established row.
 *   2. By `clientMsgId` — collapses the optimistic local bubble with the
 *      server echo without depending on text/file equality.
 *   3. By the legacy (sender_id + text) shape for messages that pre-date
 *      `clientMsgId` (post-fix messages always carry one).
 */
export function upsertCachedMessage(code: CacheKey, incoming: MeetingMessage): MeetingMessage[] {
    if (!code || !incoming) return getCachedMessages(code);
    const key = String(code);
    const prev = cache.get(key) || [];

    // 1. Dedup by persisted id.
    if (incoming.id != null) {
        const idx = prev.findIndex(m => m.id === incoming.id);
        if (idx >= 0) {
            const next = prev.slice();
            next[idx] = { ...next[idx], ...incoming };
            cache.set(key, next);
            return next.slice();
        }
    }

    // 2. Dedup by clientMsgId (collapses optimistic bubbles).
    if (incoming.clientMsgId) {
        const idx = prev.findIndex(m => m.clientMsgId === incoming.clientMsgId);
        if (idx >= 0) {
            const next = prev.slice();
            // Preserve any field the optimistic row had that the server echo
            // didn't include (e.g. local previewUrl on file uploads).
            next[idx] = { ...next[idx], ...incoming, _optimistic: false, _failed: false };
            cache.set(key, next);
            return next.slice();
        }
    }

    // 3. Legacy shape fallback — only relevant for messages created before
    // this fix shipped. New messages always carry a clientMsgId.
    if (incoming._optimistic !== true && incoming.text) {
        const idx = prev.findIndex(m =>
            m._optimistic
            && m.sender_id === incoming.sender_id
            && m.text === incoming.text
            && !m.clientMsgId,
        );
        if (idx >= 0) {
            const next = prev.slice();
            next[idx] = { ...next[idx], ...incoming, _optimistic: false, _failed: false };
            cache.set(key, next);
            return next.slice();
        }
    }

    const next = [...prev, incoming];
    cache.set(key, next);
    return next.slice();
}

type MessagesUpdater = MeetingMessage[] | ((prev: MeetingMessage[]) => MeetingMessage[]);

/**
 * Apply a (prev → next) reducer over the cached array. Useful when the hook
 * has already computed the new array and just needs to mirror it.
 */
export function applyCachedMessages(code: CacheKey, updater: MessagesUpdater): void {
    if (!code) return;
    const key = String(code);
    const prev = cache.get(key) || [];
    const next = typeof updater === "function" ? updater(prev.slice()) : updater;
    cache.set(key, Array.isArray(next) ? next : []);
}

/**
 * Remove every cached message for a meeting. Call this when the user
 * deliberately leaves a meeting that they don't intend to rejoin (so memory
 * doesn't grow without bound across many short meetings in one session).
 */
export function clearMessagesCache(code: CacheKey): void {
    if (!code) return;
    cache.delete(String(code));
}

/**
 * Test-only: wipe the entire cache. Not exported from the package barrel.
 */
export function __resetMessagesCacheForTests(): void {
    cache.clear();
}