/**
 * Storage adapter behaviour + the production safety guard.
 *
 * The guard is the important part: STORAGE_DRIVER=local in production silently
 * reintroduces the single-replica constraint that A3 exists to remove, and any
 * file written by one instance would be invisible to the others. It must be a
 * startup failure, not a runtime surprise.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { LocalAdapter } from "../platform/storage/localAdapter";

describe("LocalAdapter", () => {
    let root: string;
    let adapter: LocalAdapter;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "aino-storage-"));
        adapter = new LocalAdapter(root);
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it("round-trips an object", async () => {
        await adapter.put("tenant_1/org_1/chat/a.txt", Buffer.from("hello"));
        expect((await adapter.get("tenant_1/org_1/chat/a.txt"))?.toString()).toBe("hello");
    });

    it("creates intermediate directories", async () => {
        await adapter.put("tenant_9/org_9/avatars/deep.png", Buffer.from("x"));
        expect(await adapter.exists("tenant_9/org_9/avatars/deep.png")).toBe(true);
    });

    it("returns null for a missing key rather than throwing", async () => {
        expect(await adapter.get("tenant_1/org_1/chat/nope.txt")).toBeNull();
        expect(await adapter.stat("tenant_1/org_1/chat/nope.txt")).toBeNull();
        expect(await adapter.exists("tenant_1/org_1/chat/nope.txt")).toBe(false);
    });

    it("treats deleting a missing key as a no-op", async () => {
        await expect(adapter.delete("tenant_1/org_1/chat/nope.txt")).resolves.toBeUndefined();
    });

    it("overwrites an existing key", async () => {
        await adapter.put("k/a.txt", Buffer.from("one"));
        await adapter.put("k/a.txt", Buffer.from("two"));
        expect((await adapter.get("k/a.txt"))?.toString()).toBe("two");
    });

    it("deletes a whole prefix and reports the count", async () => {
        await adapter.put("tenant_1/org_1/chat/a.txt", Buffer.from("a"));
        await adapter.put("tenant_1/org_1/avatars/b.txt", Buffer.from("b"));
        await adapter.put("tenant_2/org_1/chat/c.txt", Buffer.from("c"));

        expect(await adapter.deletePrefix("tenant_1/")).toBe(2);
        expect(await adapter.exists("tenant_1/org_1/chat/a.txt")).toBe(false);
        // A different tenant must be untouched.
        expect(await adapter.exists("tenant_2/org_1/chat/c.txt")).toBe(true);
    });

    it("reports size via stat", async () => {
        await adapter.put("k/a.txt", Buffer.from("12345"));
        expect((await adapter.stat("k/a.txt"))?.size).toBe(5);
    });

    it("cannot presign (signals the caller to stream instead)", async () => {
        expect(await adapter.getSignedUrl("k/a.txt")).toBeNull();
    });

    it.each(["../escape.txt", "tenant_1/../../escape.txt"])(
        "refuses key %j that escapes the root",
        async (key) => {
            await expect(adapter.put(key, Buffer.from("x"))).rejects.toThrow();
        },
    );
});

describe("driver selection", () => {
    const OLD_ENV = process.env;

    beforeEach(() => {
        jest.resetModules();
        process.env = { ...OLD_ENV };
    });

    afterAll(() => {
        process.env = OLD_ENV;
    });

    it("uses local outside production", () => {
        process.env.NODE_ENV = "test";
        delete process.env.STORAGE_DRIVER;
        const { getStorage } = require("../platform/storage");
        expect(getStorage().name).toBe("local");
    });

    it("builds the R2 adapter when configured", () => {
        process.env.NODE_ENV = "test";
        process.env.STORAGE_DRIVER = "r2";
        process.env.R2_ACCOUNT_ID = "acct";
        process.env.R2_ACCESS_KEY_ID = "key";
        process.env.R2_SECRET_ACCESS_KEY = "secret";
        const { getStorage } = require("../platform/storage");
        expect(getStorage().name).toBe("r2");
    });

    it("fails loudly when r2 is selected without credentials", () => {
        process.env.NODE_ENV = "test";
        process.env.STORAGE_DRIVER = "r2";
        delete process.env.R2_ACCOUNT_ID;
        delete process.env.R2_ACCESS_KEY_ID;
        delete process.env.R2_SECRET_ACCESS_KEY;
        const { getStorage } = require("../platform/storage");
        expect(() => getStorage()).toThrow(/R2_ACCOUNT_ID/);
    });
});

describe("assertProductionStorage", () => {
    const OLD_ENV = process.env;

    beforeEach(() => {
        jest.resetModules();
        process.env = { ...OLD_ENV };
    });

    afterAll(() => {
        process.env = OLD_ENV;
    });

    it("REJECTS local disk in production", () => {
        // The guard that keeps A3 from silently regressing: a local directory
        // cannot be shared between replicas.
        process.env.NODE_ENV = "production";
        process.env.STORAGE_DRIVER = "local";
        const { assertProductionStorage } = require("../platform/storage");
        expect(() => assertProductionStorage()).toThrow(/not supported in production/);
    });

    it("allows local disk outside production", () => {
        process.env.NODE_ENV = "development";
        process.env.STORAGE_DRIVER = "local";
        const { assertProductionStorage } = require("../platform/storage");
        expect(() => assertProductionStorage()).not.toThrow();
    });

    it("accepts a fully configured r2 in production", () => {
        process.env.NODE_ENV = "production";
        process.env.STORAGE_DRIVER = "r2";
        process.env.R2_ACCOUNT_ID = "acct";
        process.env.R2_ACCESS_KEY_ID = "key";
        process.env.R2_SECRET_ACCESS_KEY = "secret";
        const { assertProductionStorage } = require("../platform/storage");
        expect(() => assertProductionStorage()).not.toThrow();
    });

    it("fails at boot when r2 credentials are missing in production", () => {
        process.env.NODE_ENV = "production";
        process.env.STORAGE_DRIVER = "r2";
        delete process.env.R2_ACCOUNT_ID;
        const { assertProductionStorage } = require("../platform/storage");
        expect(() => assertProductionStorage()).toThrow(/R2_ACCOUNT_ID/);
    });
});
