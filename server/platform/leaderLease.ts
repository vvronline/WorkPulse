/** Token-owned Redis lease for singleton background scheduling. */
import { randomUUID } from "crypto";
import * as redis from "../redis";

interface LeaderLease {
    key: string;
    token: string;
    renewTimer: NodeJS.Timeout;
    release: () => Promise<void>;
}

const RENEW_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

async function acquireLeaderLease(
    name: string,
    ttlMs = 30_000,
): Promise<LeaderLease | null> {
    const client = redis.getClient();
    if (!redis.isRedisReady() || !client) return null;

    const key = `leader:${name}`;
    const token = randomUUID();
    const acquired = await client.set(key, token, "PX", ttlMs, "NX");
    if (acquired !== "OK") return null;

    const renewTimer = setInterval(async () => {
        try {
            const renewed = await client.eval(RENEW_LUA, 1, key, token, ttlMs);
            if (Number(renewed) !== 1) clearInterval(renewTimer);
        } catch {
            clearInterval(renewTimer);
        }
    }, Math.floor(ttlMs / 3));
    renewTimer.unref?.();

    return {
        key,
        token,
        renewTimer,
        release: async () => {
            clearInterval(renewTimer);
            try { await client.eval(RELEASE_LUA, 1, key, token); } catch { /* best-effort */ }
        },
    };
}

export { acquireLeaderLease };
export type { LeaderLease };