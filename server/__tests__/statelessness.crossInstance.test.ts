/**
 * GR5 (dynamic half) — cross-instance behaviour.
 *
 * The failure this prevents is silent and expensive: a caller on replica A and
 * a callee on replica B never connect, because the buffered SDP offer lives in
 * a `Map` only A can see. Nothing throws; the call just hangs.
 *
 * Simulation strategy: `jest.isolateModules` gives each "replica" its own
 * module registry, so their module-level Maps are genuinely separate objects —
 * exactly like two Node processes. They share only one fake Redis, standing in
 * for the real shared Redis. Therefore:
 *
 *   - state in Redis  → visible across instances → passes
 *   - state in a Map  → invisible across instances → FAILS
 *
 * That is exactly the regression GR5 exists to catch, and it needs no Docker,
 * no real Redis and no network in CI.
 */
export {};

// ── Shared fake Redis (the only thing both "replicas" can see) ──────────────

const store = new Map<string, string>();

function scanKeys(pattern: string): string[] {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return [...store.keys()].filter((k) => new RegExp(`^${escaped}$`).test(k));
}

/** Minimal ioredis surface used by the realtime stores. */
const sharedRedisClient = {
    async set(key: string, value: string) { store.set(key, value); return "OK"; },
    async get(key: string) { return store.get(key) ?? null; },
    async del(...keys: string[]) {
        let n = 0;
        for (const k of keys) if (store.delete(k)) n++;
        return n;
    },
    async scan(_cursor: string, _m: string, pattern: string) {
        return ["0", scanKeys(pattern)] as [string, string[]];
    },
    /**
     * Executes the Lua scripts the realtime stores use. Implemented in JS
     * because what is under test is "is this state shared", not "is the Lua
     * atomic" — signalStore.test.ts already covers atomicity.
     */
    async eval(script: string, _numKeys: number, key: string, ...args: any[]) {
        if (script.includes("cjson.decode")) {
            const raw = store.get(key);
            const data = raw ? JSON.parse(raw) : { ice: [] };
            const [kind, entryJson, , maxIce] = args;
            const entry = JSON.parse(entryJson);
            if (kind === "offer") {
                data.offer = entry;
                data.ice = [];
            } else {
                data.ice = data.ice || [];
                data.ice.push(entry);
                while (data.ice.length > Number(maxIce)) data.ice.shift();
            }
            store.set(key, JSON.stringify(data));
            return 1;
        }
        if (script.includes("GET") && args.length > 0) {
            // Token-owned claim (meeting-leave lease).
            if (store.get(key) !== args[0]) return 0;
            store.delete(key);
            return 1;
        }
        // DRAIN_LUA — read and delete atomically.
        const raw = store.get(key);
        if (raw === undefined) return null;
        store.delete(key);
        return raw;
    },
};

const redisMock = {
    getClient: () => sharedRedisClient,
    isRedisReady: () => true,
    isSubscriberReady: () => true,
    async get(key: string) {
        const raw = store.get(`json:${key}`);
        return raw ? JSON.parse(raw) : null;
    },
    async set(key: string, value: unknown) {
        store.set(`json:${key}`, JSON.stringify(value));
    },
};

/**
 * Load a module inside its own registry — a stand-in for a separate process.
 * Each call yields fresh module-level state.
 */
function onReplica<T>(modulePath: string, fn: (mod: any) => Promise<T>): Promise<T> {
    let out!: Promise<T>;
    jest.isolateModules(() => {
        jest.doMock("../redis", () => redisMock);
        out = fn(require(modulePath));
    });
    return out;
}

const TENANT = 7;

describe("GR5: realtime state survives a replica boundary", () => {
    beforeEach(() => store.clear());

    it("replays a call offer buffered on instance A to a callee on instance B", async () => {
        const offer = { type: "offer", sdp: "v=0 fake-offer" };

        // Instance A: the caller's offer arrives before the callee has a socket.
        await onReplica("../realtime/signalStore", async (m) => {
            await m.bufferCallSignal(TENANT, 100, 1, 2, offer);
        });

        // Instance B: the callee connects here — a DIFFERENT module registry.
        const drained = await onReplica("../realtime/signalStore", async (m) =>
            m.drainCallSignals(TENANT, 100, 2),
        );

        // Were the buffer an in-process Map this would be empty, and the call
        // would hang forever with no error logged anywhere.
        expect(drained).toHaveLength(1);
        expect(drained[0]).toMatchObject({ fromUserId: 1, signal: offer });
    });

    it("delivers ICE candidates across instances in order, exactly once", async () => {
        await onReplica("../realtime/signalStore", async (m) => {
            await m.bufferCallSignal(TENANT, 101, 1, 2, { type: "offer", sdp: "o" });
            for (const c of ["c1", "c2", "c3"]) {
                await m.bufferCallSignal(TENANT, 101, 1, 2, { type: "ice-candidate", candidate: c });
            }
        });

        const first = await onReplica("../realtime/signalStore", async (m) =>
            m.drainCallSignals(TENANT, 101, 2),
        );
        expect(first.map((s: any) => s.signal.candidate ?? "offer")).toEqual([
            "offer", "c1", "c2", "c3",
        ]);

        // Exactly-once: a third instance must not replay the same signals.
        const second = await onReplica("../realtime/signalStore", async (m) =>
            m.drainCallSignals(TENANT, 101, 2),
        );
        expect(second).toEqual([]);
    });

    it("keeps meeting mesh offers separated per sender across instances", async () => {
        await onReplica("../realtime/signalStore", async (m) => {
            await m.bufferMeetingSignal(TENANT, 55, 1, 9, { type: "offer", sdp: "from-1" });
        });
        await onReplica("../realtime/signalStore", async (m) => {
            await m.bufferMeetingSignal(TENANT, 55, 2, 9, { type: "offer", sdp: "from-2" });
        });

        const drained = await onReplica("../realtime/signalStore", async (m) =>
            m.drainMeetingSignals(TENANT, 55, 9),
        );
        expect(drained.map((s: any) => s.fromUserId).sort()).toEqual([1, 2]);
    });

    it("never leaks signals between tenants sharing a call id", async () => {
        await onReplica("../realtime/signalStore", async (m) => {
            await m.bufferCallSignal(1, 500, 1, 2, { type: "offer", sdp: "tenant-1" });
            await m.bufferCallSignal(2, 500, 1, 2, { type: "offer", sdp: "tenant-2" });
        });

        const t1 = await onReplica("../realtime/signalStore", async (m) =>
            m.drainCallSignals(1, 500, 2),
        );
        expect(t1).toHaveLength(1);
        expect(t1[0].signal.sdp).toBe("tenant-1");
    });

    it("cancels on instance B a meeting-leave scheduled on instance A", async () => {
        // A: the user's socket drops, so cleanup is scheduled.
        const token = await onReplica("../realtime/meetingLeaveStore", async (m) =>
            m.createMeetingLeaveLease(TENANT, 42, 77),
        );

        // B: the user reconnects here, within the grace window.
        const cancelled = await onReplica("../realtime/meetingLeaveStore", async (m) =>
            m.cancelMeetingLeaveLease(TENANT, 42, 77),
        );
        expect(cancelled).toBe(true);

        // A's timer finally fires — it must NOT report the user as left.
        const claimed = await onReplica("../realtime/meetingLeaveStore", async (m) =>
            m.claimMeetingLeaveLease(TENANT, 42, 77, token),
        );
        expect(claimed).toBe(false);
    });

    it("shares a membership decision made on one instance with another", async () => {
        await onReplica("../realtime/membershipCache", async (m) =>
            m.setMembership(TENANT, "conversation", 12, 34, true),
        );
        const seen = await onReplica("../realtime/membershipCache", async (m) =>
            m.getMembership(TENANT, "conversation", 12, 34),
        );
        expect(seen).toBe(true);
    });
});

describe("GR5: uploads are shared storage, not per-instance disk", () => {
    it("reads on instance B an object written on instance A", async () => {
        // The CI equivalent of D5.2 "upload on A, download from B". With the
        // local driver both instances share the same directory; with r2 both
        // share the same bucket. Either way the adapter contract is the thing
        // being asserted, and a per-instance cache would break it.
        process.env.STORAGE_DRIVER = "local";
        const key = "tenant_1/org_1/avatar/gr5-probe.png";

        await onReplica("../platform/storage", async (m) => {
            m.__resetStorageForTests();
            await m.getStorage().put(key, Buffer.from("cross-instance-bytes"), "image/png");
        });

        const fetched = await onReplica("../platform/storage", async (m) => {
            m.__resetStorageForTests();
            return m.getStorage().get(key);
        });

        expect(fetched).not.toBeNull();
        expect(Buffer.from(fetched).toString()).toBe("cross-instance-bytes");

        await onReplica("../platform/storage", async (m) => {
            m.__resetStorageForTests();
            await m.getStorage().delete(key);
        });
    });

    it("refuses to boot a production replica on local disk", async () => {
        // A3.11: this is what stops someone "fixing" a broken deploy by
        // setting STORAGE_DRIVER=local, which would silently repin the app to
        // a single replica.
        const previousEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = "production";
        process.env.STORAGE_DRIVER = "local";
        try {
            await onReplica("../platform/storage", async (m) => {
                m.__resetStorageForTests();
                expect(() => m.assertProductionStorage()).toThrow(/cannot be shared between replicas/);
            });
        } finally {
            process.env.NODE_ENV = previousEnv;
            process.env.STORAGE_DRIVER = "local";
        }
    });
});
