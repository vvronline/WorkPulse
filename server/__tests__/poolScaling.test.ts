/** Phase E static/runtime guardrails for connection-pool scaling. */
import fs from "fs";
import path from "path";

describe("pool scaling configuration", () => {
    const root = path.join(__dirname, "..");
    const dbSource = fs.readFileSync(path.join(root, "db.ts"), "utf8");
    const tenantSource = fs.readFileSync(path.join(root, "utils/tenantManager.ts"), "utf8");

    it("defaults the master pool to 4 connections", () => {
        expect(dbSource).toMatch(/MASTER_POOL_SIZE[^\n]+\|\| 4/);
        expect(dbSource).toMatch(/max:\s*MASTER_POOL_SIZE/);
    });

    it("defaults tenant pools to 3 and caches up to 100", () => {
        expect(tenantSource).toMatch(/TENANT_MAX_POOLS[^\n]+\|\| 100/);
        expect(tenantSource).toMatch(/TENANT_POOL_SIZE[^\n]+\|\| 3/);
    });

    it("uses bounded tenant fan-out concurrency of 5", () => {
        expect(tenantSource).toMatch(/TENANT_FOREACH_CONCURRENCY[^\n]+\|\| 5/);
        expect(tenantSource).toContain("Promise.all(");
    });

    it("exports pool hit, miss, eviction and waiting metrics", () => {
        for (const key of ["hits", "misses", "evictions", "busyEvictions", "peakPoolCount", "hitRate", "totalWaiting"]) {
            expect(tenantSource).toContain(key);
        }
    });
});