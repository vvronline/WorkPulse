/**
 * Distributed meeting-disconnect grace leases.
 *
 * The timer remains local, but Redis owns the cancellation token. If a user
 * disconnects on replica A and rejoins on B, B deletes the lease; A's timer
 * sees that its token is gone and does not mark the participant left.
 */
import { randomUUID } from "crypto";
import * as redis from "../redis";

const localTokens = new Map<string, string>();
const TTL_SECONDS = 30;

function key(tenantId: number | null | undefined, userId: number, meetingId: number): string {
    return `t:${tenantId || 0}:rt:meeting-leave:${meetingId}:${userId}`;
}

async function createMeetingLeaveLease(
    tenantId: number | null | undefined,
    userId: number,
    meetingId: number,
): Promise<string> {
    const k = key(tenantId, userId, meetingId);
    const token = randomUUID();
    localTokens.set(k, token);
    const client = redis.getClient();
    if (redis.isRedisReady() && client) {
        await client.set(k, token, "EX", TTL_SECONDS);
    } else if (process.env.NODE_ENV === "production") {
        throw new Error("Redis unavailable for meeting leave lease");
    }
    return token;
}

async function cancelMeetingLeaveLease(
    tenantId: number | null | undefined,
    userId: number,
    meetingId: number,
): Promise<boolean> {
    const k = key(tenantId, userId, meetingId);
    const localHad = localTokens.delete(k);
    const client = redis.getClient();
    if (redis.isRedisReady() && client) {
        return (await client.del(k)) > 0 || localHad;
    }
    return localHad;
}

async function claimMeetingLeaveLease(
    tenantId: number | null | undefined,
    userId: number,
    meetingId: number,
    token: string,
): Promise<boolean> {
    const k = key(tenantId, userId, meetingId);
    localTokens.delete(k);
    const client = redis.getClient();
    if (redis.isRedisReady() && client) {
        const claimed = await client.eval(`
            if redis.call('GET', KEYS[1]) == ARGV[1] then
              redis.call('DEL', KEYS[1])
              return 1
            end
            return 0
        `, 1, k, token);
        return Number(claimed) === 1;
    }
    return process.env.NODE_ENV !== "production";
}

export { createMeetingLeaveLease, cancelMeetingLeaveLease, claimMeetingLeaveLease };