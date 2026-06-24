export {};

const { tsToMs, endOfLocalDayMs, computeFloorMs, computeBreakMs, computeDaySummary, computeStatus } = require("../utils/timeCalc");

// Helper: create a fake entry
const entry = (type: string, ts: string, mode?: string) => ({
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

    test("open session (no clock_out) counts as 0 when not live", () => {
        // Regression guard for the "8h on the timer but 0/Absent in attendance"
        // bug: a never-clocked-out session must NOT silently count as 0 in the
        // historical (capped) read path — see the capMs tests below.
        const entries = [entry("clock_in", "2025-01-15T09:00:00Z")];
        expect(computeFloorMs(entries)).toBe(0);
    });

    test("open session is credited up to capMs (end-of-local-day)", () => {
        // 3:30 PM IST clock-in, never clocked out. IST offset = -330.
        // 09:30:00Z is 15:00 IST… use 10:00:00Z = 15:30 IST.
        const entries = [entry("clock_in", "2025-01-15T10:00:00Z")];
        const capMs = endOfLocalDayMs("2025-01-15", -330); // end of IST day
        const floorMs = computeFloorMs(entries, true, capMs);
        // From 15:30 IST to 23:59:59.999 IST ≈ 8h29m30s.
        const hours = floorMs / 3_600_000;
        expect(hours).toBeGreaterThan(8);
        expect(hours).toBeLessThan(8.6);
    });

    test("capMs never counts backwards if it precedes the open clock-in", () => {
        const entries = [entry("clock_in", "2025-01-15T10:00:00Z")];
        // Cap before the clock-in (pathological bad-offset / clock-skew case).
        const capMs = new Date("2025-01-15T08:00:00Z").getTime();
        expect(computeFloorMs(entries, true, capMs)).toBe(0);
    });
});

describe("endOfLocalDayMs", () => {
    test("returns 23:59:59.999 local expressed as UTC for IST", () => {
        // IST = UTC+5:30 → offsetMin = -330. End of 2025-01-15 IST =
        // 2025-01-15T23:59:59.999+05:30 = 2025-01-15T18:29:59.999Z.
        const ms = endOfLocalDayMs("2025-01-15", -330);
        expect(new Date(ms).toISOString()).toBe("2025-01-15T18:29:59.999Z");
    });

    test("returns 23:59:59.999 UTC for offset 0", () => {
        const ms = endOfLocalDayMs("2025-01-15", 0);
        expect(new Date(ms).toISOString()).toBe("2025-01-15T23:59:59.999Z");
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