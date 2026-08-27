/** Phase C role-dispatch safety tests. */
export {};

jest.mock("../roles/all", () => ({ runAllRole: jest.fn(async () => undefined) }));
jest.mock("../roles/web", () => ({ runWebRole: jest.fn(async () => undefined) }));
jest.mock("../roles/realtime", () => ({ runRealtimeRole: jest.fn(async () => undefined) }));
jest.mock("../roles/worker", () => ({ runWorkerRole: jest.fn(async () => undefined) }));

describe("runRole", () => {
    const oldEnv = process.env;

    beforeEach(() => {
        jest.resetModules();
        process.env = { ...oldEnv };
        delete process.env.ROLE;
    });

    afterAll(() => { process.env = oldEnv; });

    it("defaults to the combined all role", async () => {
        const { runRole } = require("../roles");
        const all = require("../roles/all");
        const app = {} as any;
        await runRole(app);
        expect(all.runAllRole).toHaveBeenCalledWith(app);
    });

    it("dispatches ROLE=web without starting realtime or jobs", async () => {
        process.env.ROLE = "web";
        const { runRole } = require("../roles");
        const web = require("../roles/web");
        const app = {} as any;
        await runRole(app);
        expect(web.runWebRole).toHaveBeenCalledWith(app);
    });

    it("dispatches ROLE=realtime", async () => {
        process.env.ROLE = "realtime";
        const { runRole } = require("../roles");
        const realtime = require("../roles/realtime");
        const app = {} as any;
        await runRole(app);
        expect(realtime.runRealtimeRole).toHaveBeenCalledWith(app);
    });

    it("dispatches ROLE=worker without requiring an app", async () => {
        process.env.ROLE = "worker";
        const { runRole } = require("../roles");
        const worker = require("../roles/worker");
        await runRole({} as any);
        expect(worker.runWorkerRole).toHaveBeenCalled();
    });

    it("rejects unknown roles", async () => {
        process.env.ROLE = "banana";
        const { runRole } = require("../roles");
        await expect(runRole({} as any)).rejects.toThrow(/Unknown ROLE/);
    });

});