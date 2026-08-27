/**
 * Phase H2 — runtime gauges sampled at scrape time.
 *
 * These are all *current state*, not events, so they are implemented as
 * prom-client `collect()` callbacks: the value is read when Prometheus
 * scrapes rather than on a timer we would have to shut down cleanly.
 *
 * Deliberate constraint: this module opens **no new connections**. BullMQ
 * queue depth is read from the shared Redis client using BullMQ's own key
 * layout, because instantiating seven extra `Queue` objects purely to observe
 * them would undo the connection frugality Phase E just bought.
 */
import { Gauge } from "prom-client";
import { registry } from "./registry";
import { getPoolStats } from "../../utils/tenantManager";
import * as redis from "../../redis";

/** Queue names created in `jobs.ts`. Kept in sync by a test. */
const QUEUE_NAMES = [
    "auto-clock-out",
    "token-cleanup",
    "inspector-prune",
    "retention-cleanup",
    "stale-call-sweep",
    "sprint-lifecycle",
    "chat-media-pipeline",
] as const;

// ── Database pool gauges ─────────────────────────────────────────────────────

const poolConnections = new Gauge({
    name: "aino_db_pool_connections",
    help: "Tenant pool connections by state (total, idle, waiting).",
    labelNames: ["state"] as const,
    registers: [registry],
    collect() {
        const stats = getPoolStats();
        let total = 0;
        let idle = 0;
        let waiting = 0;
        for (const entry of Object.values(stats.pools) as Array<Record<string, number>>) {
            total += entry.total || 0;
            idle += entry.idle || 0;
            waiting += entry.waiting || 0;
        }
        this.set({ state: "total" }, total);
        this.set({ state: "idle" }, idle);
        this.set({ state: "waiting" }, waiting);
    },
});

const poolCount = new Gauge({
    name: "aino_db_tenant_pools",
    help: "Cached tenant pools versus the configured ceiling.",
    labelNames: ["kind"] as const,
    registers: [registry],
    collect() {
        const stats = getPoolStats();
        this.set({ kind: "open" }, stats.poolCount);
        this.set({ kind: "max" }, stats.maxPools);
    },
});

const poolEvictions = new Gauge({
    name: "aino_db_pool_evictions_total",
    help: "Tenant pool evictions. Sustained growth here is LRU thrash (Phase E2).",
    labelNames: ["kind"] as const,
    registers: [registry],
    collect() {
        const m = getPoolStats().metrics as Record<string, number>;
        this.set({ kind: "lru" }, m.evictions || 0);
        this.set({ kind: "busy" }, m.busyEvictions || 0);
    },
});

const poolHitRate = new Gauge({
    name: "aino_db_pool_hit_rate",
    help: "Tenant pool cache hit rate (1 = every lookup reused a pool).",
    registers: [registry],
    collect() {
        const m = getPoolStats().metrics as Record<string, number>;
        this.set(typeof m.hitRate === "number" ? m.hitRate : 1);
    },
});

// ── BullMQ queue gauges ──────────────────────────────────────────────────────

/**
 * Read queue depth straight from BullMQ's Redis keys.
 *
 * `wait`/`active` are lists; `delayed`/`failed` are sorted sets. One pipeline
 * keeps all seven queues to a single round trip.
 */
async function readQueueDepths(): Promise<Record<string, Record<string, number>>> {
    const client = redis.getClient();
    if (!client || !redis.isRedisReady()) return {};

    const pipeline = client.pipeline();
    for (const name of QUEUE_NAMES) {
        pipeline.llen(`bull:${name}:wait`);
        pipeline.llen(`bull:${name}:active`);
        pipeline.zcard(`bull:${name}:delayed`);
        pipeline.zcard(`bull:${name}:failed`);
    }

    const results = await pipeline.exec();
    if (!results) return {};

    const out: Record<string, Record<string, number>> = {};
    QUEUE_NAMES.forEach((name, index) => {
        const base = index * 4;
        const read = (offset: number): number => {
            const entry = results[base + offset];
            // ioredis pipeline entries are [error, value].
            if (!entry || entry[0]) return 0;
            const value = Number(entry[1]);
            return Number.isFinite(value) ? value : 0;
        };
        out[name] = {
            waiting: read(0),
            active: read(1),
            delayed: read(2),
            failed: read(3),
        };
    });
    return out;
}

const queueDepth = new Gauge({
    name: "aino_queue_depth",
    help: "BullMQ jobs by queue and state. Scale workers on this, not CPU.",
    labelNames: ["queue", "state"] as const,
    registers: [registry],
    async collect() {
        const depths = await readQueueDepths().catch(() => ({}));
        for (const [queue, states] of Object.entries(depths)) {
            for (const [state, value] of Object.entries(states)) {
                this.set({ queue, state }, value);
            }
        }
    },
});

// ── WebSocket gauges ─────────────────────────────────────────────────────────

interface WebSocketServerLike {
    clients: { size: number };
}

let wsServer: WebSocketServerLike | null = null;

/**
 * Register the live WebSocket server.
 *
 * Called by the realtime/all role rather than by `ws.ts`, so the transport
 * module keeps no dependency on metrics and the process role stays the single
 * place that wires infrastructure together.
 */
function setWebSocketServer(server: WebSocketServerLike | null): void {
    wsServer = server;
}

const wsConnections = new Gauge({
    name: "aino_ws_connections",
    help: "Open WebSocket connections on this instance (cap ~5k per pod).",
    registers: [registry],
    collect() {
        this.set(wsServer?.clients?.size ?? 0);
    },
});

// ── Redis gauges ─────────────────────────────────────────────────────────────

const redisUp = new Gauge({
    name: "aino_redis_up",
    help: "Redis connection health by connection kind (1 = ready).",
    labelNames: ["connection"] as const,
    registers: [registry],
    collect() {
        this.set({ connection: "command" }, redis.isRedisReady() ? 1 : 0);
        this.set({ connection: "subscriber" }, redis.isSubscriberReady() ? 1 : 0);
    },
});

const redisKeyspace = new Gauge({
    name: "aino_redis_keyspace_hit_rate",
    help: "Server-wide Redis keyspace hit rate from INFO stats (1 = all hits).",
    registers: [registry],
    async collect() {
        const client = redis.getClient();
        if (!client || !redis.isRedisReady()) return;
        try {
            const info = await client.info("stats");
            const hits = Number(/keyspace_hits:(\d+)/.exec(info)?.[1] || 0);
            const misses = Number(/keyspace_misses:(\d+)/.exec(info)?.[1] || 0);
            const lookups = hits + misses;
            this.set(lookups === 0 ? 1 : hits / lookups);
        } catch {
            /* a metrics failure must never break a scrape */
        }
    },
});

export {
    QUEUE_NAMES,
    readQueueDepths,
    setWebSocketServer,
    poolConnections,
    poolCount,
    poolEvictions,
    poolHitRate,
    queueDepth,
    wsConnections,
    redisUp,
    redisKeyspace,
};
