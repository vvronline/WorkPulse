/**
 * Generalised WebSocket-handler idempotency wrapper.
 *
 * Why
 * ───
 * The meeting-chat handler already uses a `clientMsgId` round-trip + a
 * unique DB index for at-least-once delivery (see ADR-002). The same
 * pattern is useful for several other handlers that a flaky network /
 * auto-reconnecting client can hit twice:
 *
 *   - `meeting_raise_hand`         — toggling hand on a slow link
 *   - `meeting_mute_participant`   — host clicks twice during a glitch
 *   - `meeting_add_participant`    — invite-during-reconnect double-fire
 *   - `meeting_track_state`        — track-state burst during media swap
 *
 * Today each handler is "naturally" idempotent at the DB layer because
 * the underlying UPDATE/INSERT is targeted at a single row keyed by
 * (meeting_id, user_id). But we still pay the cost of running the SQL +
 * fanning out the broadcast on every retry. With a cache layer in
 * front, retries become a constant-time hash lookup.
 *
 * Design
 * ──────
 * In-process LRU keyed by `(tenantId, senderId, type, clientMsgId)`.
 * The value stored is whatever the wrapped handler resolves to (we
 * generally don't return anything from WS handlers, so the typical
 * stored value is `undefined`, but the cache still serves to suppress
 * the second run).
 *
 * - **Size-bounded**: 5_000 entries (≈ 50 KB at average sizes). Stale
 *   entries are evicted on LRU touch.
 * - **TTL-bounded**: 5 minutes. Long enough to cover the
 *   MEETING_DISCONNECT_GRACE_MS window + a slow WS reconnect. Short
 *   enough that we don't suppress a legitimate "same clientMsgId, hours
 *   later" retry from a buggy client.
 * - **In-process only**: matches the existing chat-dedupe behaviour
 *   (the DB unique index is the authoritative cross-instance dedup; the
 *   cache is just a fast-path). Promoting to Redis is intentionally
 *   deferred — it would add a network round-trip to every WS message
 *   for benefit only on multi-instance setups (which we don't yet run
 *   for the WS server).
 *
 * Backwards compatibility
 * ───────────────────────
 * The wrapper is a NO-OP for any call without a `clientMsgId` (the
 * majority of today's WS handlers). Adoption is opt-in per handler:
 * the handler just declares it via `withIdempotency(...)` and starts
 * trusting clients to mint ids.
 */

const MAX_ENTRIES = 5_000;
const TTL_MS = 5 * 60 * 1000;
const IDLE_SWEEP_INTERVAL_MS = 60 * 1000;

interface CacheEntry {
    value: unknown;
    expiresAt: number;
}

interface CacheStats {
    hits: number;
    misses: number;
    evictions: number;
}

interface CacheSnapshot {
    size: number;
    maxEntries: number;
    ttlMs: number;
    hits: number;
    misses: number;
    evictions: number;
    hitRate: number;
}

interface CacheOptions {
    maxEntries?: number;
    ttlMs?: number;
}

interface KeyParts {
    tenantId?: number | string | null;
    senderId: number | string;
    type: string;
    clientMsgId?: string;
}

interface IdempotencyParams extends KeyParts {
    cache?: IdempotencyCache;
}

interface CallActionParams {
    tenantId?: number | string | null;
    senderId: number | string;
    callId: number | string;
    action: "answer" | "reject" | "end";
    clientMsgId?: string;
    cache?: IdempotencyCache;
}

/**
 * Pure-JS LRU with TTL. We deliberately reuse `Map` so iteration order
 * gives us the LRU dimension for free (every `set` after `delete` moves
 * the key to the tail).
 */
class IdempotencyCache {
    maxEntries: number;
    ttlMs: number;
    entries: Map<string, CacheEntry>;
    _stats: CacheStats;

    constructor({ maxEntries = MAX_ENTRIES, ttlMs = TTL_MS }: CacheOptions = {}) {
        this.maxEntries = maxEntries;
        this.ttlMs = ttlMs;
        // key → { value, expiresAt }
        this.entries = new Map();
        this._stats = { hits: 0, misses: 0, evictions: 0 };
    }

    get(key: string): unknown {
        const e = this.entries.get(key);
        if (!e) { this._stats.misses++; return undefined; }
        if (e.expiresAt < Date.now()) {
            this.entries.delete(key);
            this._stats.misses++;
            return undefined;
        }
        // Touch — move to LRU tail.
        this.entries.delete(key);
        this.entries.set(key, e);
        this._stats.hits++;
        return e.value;
    }

    set(key: string, value: unknown): void {
        if (this.entries.has(key)) this.entries.delete(key);
        this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
        // Evict from the head (oldest) if we're over.
        while (this.entries.size > this.maxEntries) {
            const first = this.entries.keys().next().value;
            if (first === undefined) break;
            this.entries.delete(first);
            this._stats.evictions++;
        }
    }

    /** Drop everything that has expired. Called by the background sweep. */
    sweepExpired(now = Date.now()): number {
        let dropped = 0;
        for (const [k, e] of this.entries) {
            if (e.expiresAt < now) { this.entries.delete(k); dropped++; }
        }
        return dropped;
    }

    /** Snapshot for tests + the eventual /api/internal/idempotency-stats. */
    snapshot(): CacheSnapshot {
        const total = this._stats.hits + this._stats.misses;
        return {
            size: this.entries.size,
            maxEntries: this.maxEntries,
            ttlMs: this.ttlMs,
            hits: this._stats.hits,
            misses: this._stats.misses,
            evictions: this._stats.evictions,
            hitRate: total === 0 ? 0 : +(this._stats.hits / total).toFixed(4),
        };
    }

    /** Test-only — drop every entry + zero the stats. */
    _resetForTests(): void {
        this.entries.clear();
        this._stats = { hits: 0, misses: 0, evictions: 0 };
    }
}

/** The default singleton — shared across all wrapped handlers. */
const defaultCache = new IdempotencyCache();

/**
 * Background sweep so an idle process eventually reclaims expired
 * entries even if no `get()` ever runs. Bound to `unref()` so it never
 * keeps the event loop alive on its own.
 */
const sweepHandle = setInterval(() => defaultCache.sweepExpired(), IDLE_SWEEP_INTERVAL_MS);
if (sweepHandle && typeof sweepHandle.unref === "function") sweepHandle.unref();

/**
 * Build the cache key. We include `type` so the same clientMsgId can
 * coexist across different message types (collision-paranoia + makes
 * future tracing trivial).
 */
function buildKey({ tenantId, senderId, type, clientMsgId }: KeyParts): string {
    return `${tenantId || 0}:${senderId}:${type}:${clientMsgId}`;
}

/**
 * Wrap a handler so retries with the same `clientMsgId` are deduped.
 *
 * Usage:
 *   await withIdempotency({
 *     tenantId, senderId, type: 'meeting_raise_hand', clientMsgId,
 *   }, async () => { ... actual handler ... });
 *
 * If `clientMsgId` is missing / falsy → handler runs every time (legacy
 * behaviour). If a previous call with the same key resolved within the
 * TTL → its return value is replayed and the handler is NOT re-run.
 * If a previous call THREW → we don't cache the rejection (next retry
 * gets to try again with a fresh world state, e.g. after the DB hiccup
 * has cleared).
 */
async function withIdempotency(
    { tenantId, senderId, type, clientMsgId, cache = defaultCache }: IdempotencyParams,
    fn: () => unknown | Promise<unknown>,
): Promise<unknown> {
    if (typeof fn !== "function") throw new TypeError("withIdempotency: fn must be a function");
    if (!clientMsgId || typeof clientMsgId !== "string" || clientMsgId.length === 0 || clientMsgId.length > 64) {
        // No id → no dedup. Run the handler as-is.
        return fn();
    }

    const key = buildKey({ tenantId, senderId, type, clientMsgId });
    const prior = cache.get(key);
    if (prior !== undefined) {
        // Cached hit — return the same envelope. We DON'T re-broadcast
        // because the side-effects already happened on the first run.
        return prior;
    }
    const result = await fn();
    // Cache `undefined` results as a sentinel so subsequent retries
    // still get a hit (and skip re-running the handler).
    cache.set(key, result === undefined ? null : result);
    return result;
}

async function withIdempotentCallAction(
    { tenantId, senderId, callId, action, clientMsgId, cache = defaultCache }: CallActionParams,
    fn: () => unknown | Promise<unknown>,
): Promise<unknown> {
    // Include callId in the dedupe token even when clientMsgId is provided so
    // retries from different calls cannot collide.
    const actionClientId = clientMsgId
        ? `${callId}:${clientMsgId}`
        : `${callId}:${senderId}:${action}`;
    return withIdempotency(
        {
            tenantId,
            senderId,
            type: `call_action_${action}`,
            clientMsgId: actionClientId,
            cache,
        },
        fn,
    );
}

export {
    withIdempotency,
    IdempotencyCache,
    defaultCache,
    withIdempotentCallAction,
    MAX_ENTRIES as _MAX_ENTRIES,
    TTL_MS as _TTL_MS,
};