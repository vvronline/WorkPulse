/** Tenant-scoped relay authorization cache: local L1 + Redis source of truth. */
import * as redis from "../redis";

const TTL_SECONDS = 10;
const L1_MAX = 5000;
const l1 = new Map<string, { ok: boolean; expiresAt: number }>();

function key(
    tenantId: number | null | undefined,
    kind: "conversation" | "meeting",
    roomId: number,
    userId: number,
): string {
    return `t:${tenantId || 0}:rt:membership:${kind}:${roomId}:${userId}`;
}

async function getMembership(
    tenantId: number | null | undefined,
    kind: "conversation" | "meeting",
    roomId: number,
    userId: number,
): Promise<boolean | null> {
    const k = key(tenantId, kind, roomId, userId);
    const cached = l1.get(k);
    if (cached && cached.expiresAt > Date.now()) return cached.ok;

    const shared = typeof (redis as any).get === "function"
        ? await redis.get<{ ok: boolean }>(k)
        : null;
    if (!shared || typeof shared !== "object" || typeof shared.ok !== "boolean") return null;
    setL1(k, shared.ok);
    return shared.ok;
}

async function setMembership(
    tenantId: number | null | undefined,
    kind: "conversation" | "meeting",
    roomId: number,
    userId: number,
    ok: boolean,
): Promise<void> {
    const k = key(tenantId, kind, roomId, userId);
    setL1(k, ok);
    if (typeof (redis as any).set === "function") {
        await redis.set(k, { ok }, TTL_SECONDS);
    }
}

function setL1(k: string, ok: boolean): void {
    l1.set(k, { ok, expiresAt: Date.now() + TTL_SECONDS * 1000 });
    if (l1.size > L1_MAX) {
        const oldest = l1.keys().next().value;
        if (oldest) l1.delete(oldest);
    }
}

export { getMembership, setMembership };