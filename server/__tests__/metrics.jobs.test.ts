/** Phase H2 — job duration/outcome and BullMQ queue-depth collection. */
export {};

jest.mock("../utils/logger", () => ({
    logger: {
        info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(), debug: jest.fn(),
        child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
    },
    requestLogger: (_req: any, _res: any, next: any) => next(),
}));

jest.mock("../utils/tenantManager", () => ({
    getPoolStats: () => ({
        poolCount: 0, maxPools: 100, poolSize: 3,
        metrics: { hits: 0, misses: 0, hitRate: 1, evictions: 0, busyEvictions: 0, totalWaiting: 0 },
        pools: {},
    }),
}));

let redisReady = true;
const pipelineCalls: string[] = [];
let pipelineResult: any = null;

jest.mock("../redis", () => ({
    isRedisReady: () => redisReady,
    isSubscriberReady: () => true,
    getClient: () => (redisReady
        ? {
            pipeline: () => {
                const chain: any = {
                    llen: (k: string) => { pipelineCalls.push(`llen:${k}`); return chain; },
                    zcard: (k: string) => { pipelineCalls.push(`zcard:${k}`); return chain; },
                    exec: async () => pipelineResult,
                };
                return chain;
            },
        }
        : null),
}));

const fs = require("fs");
const path = require("path");
const { observeJob, jobDuration, jobRuns } = require("../platform/metrics/jobMetrics");
const { readQueueDepths, QUEUE_NAMES } = require("../platform/metrics/collectors");
const { __resetForTests } = require("../platform/metrics/registry");

describe("job metrics", () => {
    beforeEach(() => __resetForTests());

    it("records a successful run", async () => {
        const result = await observeJob("auto-clock-out", async () => "done");
        expect(result).toBe("done");

        const runs = (await jobRuns.get()).values;
        expect(runs).toHaveLength(1);
        expect(runs[0].labels).toMatchObject({ queue: "auto-clock-out", outcome: "success" });
    });

    it("records a failure AND rethrows so BullMQ still retries", async () => {
        // Swallowing here would silently disable every retry policy.
        await expect(
            observeJob("token-cleanup", async () => { throw new Error("boom"); }),
        ).rejects.toThrow("boom");

        const runs = (await jobRuns.get()).values;
        expect(runs[0].labels).toMatchObject({ queue: "token-cleanup", outcome: "failure" });
    });

    it("observes duration into the histogram", async () => {
        await observeJob("sprint-lifecycle", async () => { });
        const counts = (await jobDuration.get()).values
            .filter((v: any) => v.metricName === "aino_job_duration_seconds_count");
        expect(counts[0].value).toBe(1);
    });
});

describe("queue depth collection", () => {
    beforeEach(() => {
        redisReady = true;
        pipelineCalls.length = 0;
        pipelineResult = QUEUE_NAMES.flatMap(() => [
            [null, 3], [null, 1], [null, 2], [null, 0],
        ]);
    });

    it("reads all queues in ONE pipeline and opens no new connections", async () => {
        const depths = await readQueueDepths();
        // 4 reads per queue, all batched into a single round trip.
        expect(pipelineCalls).toHaveLength(QUEUE_NAMES.length * 4);
        expect(Object.keys(depths)).toEqual([...QUEUE_NAMES]);
        expect(depths["auto-clock-out"]).toEqual({
            waiting: 3, active: 1, delayed: 2, failed: 0,
        });
    });

    it("returns empty rather than throwing when Redis is unavailable", async () => {
        redisReady = false;
        await expect(readQueueDepths()).resolves.toEqual({});
    });

    it("treats a per-command pipeline error as zero, not NaN", async () => {
        pipelineResult = QUEUE_NAMES.flatMap(() => [
            [new Error("WRONGTYPE"), null], [null, 1], [null, "x"], [null, 0],
        ]);
        const depths = await readQueueDepths();
        expect(depths["auto-clock-out"].waiting).toBe(0);
        // A non-numeric reply must not leak NaN into the exposition format.
        expect(depths["auto-clock-out"].delayed).toBe(0);
    });

    it("stays in sync with the queues jobs.ts actually creates", async () => {
        // A queue added to jobs.ts but not here is invisible to the backlog
        // alert, which is exactly when you need it.
        const source = fs.readFileSync(path.join(__dirname, "..", "jobs.ts"), "utf8");
        const declared = [...source.matchAll(/new Queue\(\s*"([^"]+)"/g)].map((m: any) => m[1]);
        expect(new Set(declared)).toEqual(new Set(QUEUE_NAMES));
    });
});
