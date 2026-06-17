"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { tsToMs, computeFloorMs, computeBreakMs, computeDaySummary, computeStatus } = require("../utils/timeCalc");
// Helper: create a fake entry
const entry = (type, ts, mode) => ({
    entry_type: type,
    timestamp: ts,
    work_mode: mode || "office",
});
describe("tsToMs", () => {
    test("converts ISO string", () => {
        expect(tsToMs("2025-01-15T09:00:00Z")).toBe(new Date("2025-01-15T09:00:00Z").getTime());
    });
    test("converts Date object", () => {
        const d = new Date("2025-01-15T09:00:00Z");
        expect(tsToMs(d)).toBe(d.getTime());
    });
    test("handles space-separated timestamp", () => {
        expect(tsToMs("2025-01-15 09:00:00")).toBe(new Date("2025-01-15T09:00:00Z").getTime());
    });
});
describe("computeFloorMs", () => {
    test("returns 0 for empty entries", () => {
        expect(computeFloorMs([])).toBe(0);
    });
    test("computes simple clock-in/out session", () => {
        const entries = [
            entry("clock_in", "2025-01-15T09:00:00Z"),
            entry("clock_out", "2025-01-15T17:00:00Z"),
        ];
        expect(computeFloorMs(entries)).toBe(8 * 3600 * 1000);
    });
    test("subtracts break time", () => {
        const entries = [
            entry("clock_in", "2025-01-15T09:00:00Z"),
            entry("break_start", "2025-01-15T12:00:00Z"),
            entry("break_end", "2025-01-15T13:00:00Z"),
            entry("clock_out", "2025-01-15T17:00:00Z"),
        ];
        // 3h work + 4h work = 7h (break excluded)
        expect(computeFloorMs(entries)).toBe(7 * 3600 * 1000);
    });
});
describe("computeBreakMs", () => {
    test("returns 0 with no breaks", () => {
        const entries = [
            entry("clock_in", "2025-01-15T09:00:00Z"),
            entry("clock_out", "2025-01-15T17:00:00Z"),
        ];
        expect(computeBreakMs(entries)).toBe(0);
    });
    test("computes break duration", () => {
        const entries = [
            entry("clock_in", "2025-01-15T09:00:00Z"),
            entry("break_start", "2025-01-15T12:00:00Z"),
            entry("break_end", "2025-01-15T12:30:00Z"),
            entry("clock_out", "2025-01-15T17:00:00Z"),
        ];
        expect(computeBreakMs(entries)).toBe(30 * 60 * 1000);
    });
});
describe("computeDaySummary", () => {
    test("returns full summary", () => {
        const entries = [
            entry("clock_in", "2025-01-15T09:00:00Z", "remote"),
            entry("break_start", "2025-01-15T12:00:00Z"),
            entry("break_end", "2025-01-15T12:30:00Z"),
            entry("clock_out", "2025-01-15T17:30:00Z"),
        ];
        const summary = computeDaySummary(entries);
        expect(summary.floorMinutes).toBe(480); // 8h
        expect(summary.breakMinutes).toBe(30);
        expect(summary.totalMinutes).toBe(510); // 8h30
        expect(summary.workMode).toBe("remote");
    });
});
describe("computeStatus", () => {
    test("logged_out for empty entries", () => {
        const s = computeStatus([]);
        expect(s.state).toBe("logged_out");
        expect(s.floorMinutes).toBe(0);
    });
    test("on_floor after clock_in", () => {
        const entries = [entry("clock_in", "2025-01-15T09:00:00Z")];
        expect(computeStatus(entries).state).toBe("on_floor");
    });
    test("on_break after break_start", () => {
        const entries = [
            entry("clock_in", "2025-01-15T09:00:00Z"),
            entry("break_start", "2025-01-15T12:00:00Z"),
        ];
        expect(computeStatus(entries).state).toBe("on_break");
    });
    test("logged_out after clock_out", () => {
        const entries = [
            entry("clock_in", "2025-01-15T09:00:00Z"),
            entry("clock_out", "2025-01-15T17:00:00Z"),
        ];
        expect(computeStatus(entries).state).toBe("logged_out");
    });
});
//# sourceMappingURL=timeCalc.test.js.map