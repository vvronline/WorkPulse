/**
 * Durable WebRTC signalling store.
 *
 * Redis is the cross-instance source of truth. Each target has one JSON value
 * containing the latest offer and bounded ordered ICE, updated/drained with
 * Lua so offer replacement, ICE append and exactly-once replay are atomic.
 *
 * Keys are tenant-scoped because call/meeting IDs repeat across tenant DBs.
 */
import * as redis from "../redis";

const TTL_SECONDS = 60;
const MAX_ICE = 80;

export interface BufferedSignal {
    fromUserId: number;
    signal: any;
}

interface SignalBatch {
    offer?: BufferedSignal;
    ice: BufferedSignal[];
}

const local = new Map<string, { value: SignalBatch; expiresAt: number }>();

function callKey(tenantId: number | null | undefined, callId: number, targetUserId: number): string {
    return `t:${tenantId || 0}:rt:call:${callId}:target:${targetUserId}`;
}

function meetingKey(
    tenantId: number | null | undefined,
    meetingId: number,
    targetUserId: number,
    fromUserId: number,
): string {
    return `t:${tenantId || 0}:rt:meeting:${meetingId}:target:${targetUserId}:from:${fromUserId}`;
}

const APPEND_LUA = `
local raw = redis.call('GET', KEYS[1])
local data = raw and cjson.decode(raw) or { ice = {} }
local entry = cjson.decode(ARGV[2])
if ARGV[1] == 'offer' then
  data.offer = entry
  data.ice = {}
else
  table.insert(data.ice, entry)
  while #data.ice > tonumber(ARGV[4]) do table.remove(data.ice, 1) end
end
redis.call('SET', KEYS[1], cjson.encode(data), 'EX', tonumber(ARGV[3]))
return 1
`;

const DRAIN_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return nil end
redis.call('DEL', KEYS[1])
return raw
`;

async function append(
    key: string,
    kind: "offer" | "ice",
    entry: BufferedSignal,
): Promise<void> {
    const client = redis.getClient();
    if (redis.isRedisReady() && client) {
        await client.eval(APPEND_LUA, 1, key, kind, JSON.stringify(entry), TTL_SECONDS, MAX_ICE);
        return;
    }
    if (process.env.NODE_ENV === "production") throw new Error("Redis unavailable for signal append");

    const now = Date.now();
    const cached = local.get(key);
    const value = cached && cached.expiresAt > now ? cached.value : { ice: [] };
    if (kind === "offer") {
        value.offer = entry;
        value.ice = [];
    } else {
        value.ice.push(entry);
        if (value.ice.length > MAX_ICE) value.ice.shift();
    }
    local.set(key, { value, expiresAt: now + TTL_SECONDS * 1000 });
}

async function drain(key: string): Promise<SignalBatch | null> {
    const client = redis.getClient();
    if (redis.isRedisReady() && client) {
        const raw = await client.eval(DRAIN_LUA, 1, key) as string | null;
        return raw ? JSON.parse(raw) as SignalBatch : null;
    }
    if (process.env.NODE_ENV === "production") throw new Error("Redis unavailable for signal drain");

    const cached = local.get(key);
    local.delete(key);
    return cached && cached.expiresAt > Date.now() ? cached.value : null;
}

async function delPattern(pattern: string): Promise<void> {
    const client = redis.getClient();
    if (redis.isRedisReady() && client) {
        let cursor = "0";
        do {
            const [next, keys] = await client.scan(cursor, "MATCH", pattern, "COUNT", 100);
            cursor = next;
            if (keys.length) await client.del(...keys);
        } while (cursor !== "0");
        return;
    }
    for (const key of local.keys()) {
        const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
        if (regex.test(key)) local.delete(key);
    }
}

async function bufferCallSignal(
    tenantId: number | null | undefined,
    callId: number,
    fromUserId: number,
    targetUserId: number,
    signal: any,
): Promise<void> {
    if (!callId || !targetUserId || !["offer", "ice-candidate"].includes(signal?.type)) return;
    await append(callKey(tenantId, callId, targetUserId), signal.type === "offer" ? "offer" : "ice", {
        fromUserId,
        signal,
    });
}

async function drainCallSignals(
    tenantId: number | null | undefined,
    callId: number,
    targetUserId: number,
): Promise<BufferedSignal[]> {
    const batch = await drain(callKey(tenantId, callId, targetUserId));
    if (!batch) return [];
    return [...(batch.offer ? [batch.offer] : []), ...(batch.ice || [])];
}

async function clearCallSignals(tenantId: number | null | undefined, callId: number): Promise<void> {
    if (callId) await delPattern(`t:${tenantId || 0}:rt:call:${callId}:*`);
}

async function bufferMeetingSignal(
    tenantId: number | null | undefined,
    meetingId: number,
    fromUserId: number,
    targetUserId: number,
    signal: any,
): Promise<void> {
    if (!meetingId || !fromUserId || !targetUserId || !["offer", "candidate"].includes(signal?.type)) return;
    await append(
        meetingKey(tenantId, meetingId, targetUserId, fromUserId),
        signal.type === "offer" ? "offer" : "ice",
        { fromUserId, signal },
    );
}

async function drainMeetingSignals(
    tenantId: number | null | undefined,
    meetingId: number,
    targetUserId: number,
): Promise<BufferedSignal[]> {
    const pattern = `t:${tenantId || 0}:rt:meeting:${meetingId}:target:${targetUserId}:from:*`;
    const client = redis.getClient();
    const keys: string[] = [];
    if (redis.isRedisReady() && client) {
        let cursor = "0";
        do {
            const [next, found] = await client.scan(cursor, "MATCH", pattern, "COUNT", 100);
            cursor = next;
            keys.push(...found);
        } while (cursor !== "0");
    } else {
        const regex = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`);
        keys.push(...[...local.keys()].filter((k) => regex.test(k)));
    }
    const out: BufferedSignal[] = [];
    for (const key of keys.sort()) {
        const batch = await drain(key);
        if (batch?.offer) out.push(batch.offer);
        out.push(...(batch?.ice || []));
    }
    return out;
}

async function clearMeetingUserSignals(
    tenantId: number | null | undefined,
    meetingId: number,
    userId: number,
): Promise<void> {
    const prefix = `t:${tenantId || 0}:rt:meeting:${meetingId}`;
    await delPattern(`${prefix}:target:${userId}:*`);
    await delPattern(`${prefix}:target:*:from:${userId}`);
}

async function clearMeetingSignals(tenantId: number | null | undefined, meetingId: number): Promise<void> {
    if (meetingId) await delPattern(`t:${tenantId || 0}:rt:meeting:${meetingId}:*`);
}

export {
    bufferCallSignal,
    drainCallSignals,
    clearCallSignals,
    bufferMeetingSignal,
    drainMeetingSignals,
    clearMeetingUserSignals,
    clearMeetingSignals,
};