"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Suppress pino logs during tests
jest.mock("../utils/logger", () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn(), child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) },
}));
const { clampOffset, getTzModifier, getLocalToday, getLocalYesterday, getLocalDow, getOffsetMin, getLocalDateFromTs } = require("../utils/timezone");
const fakeReq = (offset) => ({ headers: { "x-timezone-offset": String(offset) } });
describe("clampOffset", () => {
    test("returns 0 for NaN", () => {
        expect(clampOffset("abc")).toBe(0);
    });
    test("returns null if out of range", () => {
        expect(clampOffset("800")).toBe(null); // > 720
        expect(clampOffset("-900")).toBe(null); // < -840
    });
    test("accepts valid values", () => {
        expect(clampOffset("-330")).toBe(-330); // IST
        expect(clampOffset("0")).toBe(0); // UTC
        expect(clampOffset("300")).toBe(300); // EST
    });
});
describe("getTzModifier", () => {
    test("returns positive shift for IST (offset=-330)", () => {
        expect(getTzModifier(fakeReq(-330))).toBe("+330 minutes");
    });
    test("returns negative shift for EST (offset=300)", () => {
        expect(getTzModifier(fakeReq(300))).toBe("-300 minutes");
    });
    test("returns +0 for UTC", () => {
        expect(getTzModifier(fakeReq(0))).toBe("+0 minutes");
    });
});
describe("getOffsetMin", () => {
    test("extracts offset from header", () => {
        expect(getOffsetMin(fakeReq(-330))).toBe(-330);
    });
});
describe("getLocalToday", () => {
    test("returns YYYY-MM-DD format", () => {
        const result = getLocalToday(fakeReq(0));
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
});
describe("getLocalDow", () => {
    test("returns 0-6", () => {
        const dow = getLocalDow(fakeReq(0));
        expect(dow).toBeGreaterThanOrEqual(0);
        expect(dow).toBeLessThanOrEqual(6);
    });
});
describe("getLocalYesterday", () => {
    test("returns YYYY-MM-DD format", () => {
        const result = getLocalYesterday(fakeReq(0));
        expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
    test("returns a date before getLocalToday", () => {
        const today = getLocalToday(fakeReq(0));
        const yesterday = getLocalYesterday(fakeReq(0));
        expect(yesterday < today).toBe(true);
    });
});
describe("getLocalDateFromTs", () => {
    test("converts ISO timestamp using UTC offset", () => {
        // 2025-07-01 23:00 UTC with offset=0 → 2025-07-01
        const result = getLocalDateFromTs("2025-07-01T23:00:00Z", fakeReq(0));
        expect(result).toBe("2025-07-01");
    });
    test("handles IST timezone (offset=-330) correctly", () => {
        // 2025-07-01 20:00 UTC with IST (UTC+5:30 → offset=-330) → local is 2025-07-02 01:30
        const result = getLocalDateFromTs("2025-07-01T20:00:00Z", fakeReq(-330));
        expect(result).toBe("2025-07-02");
    });
    test("handles timestamp without Z suffix", () => {
        const result = getLocalDateFromTs("2025-07-01 12:00:00", fakeReq(0));
        expect(result).toBe("2025-07-01");
    });
    test("handles Date object input", () => {
        const date = new Date("2025-07-01T12:00:00Z");
        const result = getLocalDateFromTs(date, fakeReq(0));
        expect(result).toBe("2025-07-01");
    });
});
//# sourceMappingURL=timezone.test.js.map