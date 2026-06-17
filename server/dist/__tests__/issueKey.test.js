"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { extractIssueKeys, formatIssueKey } = require("../routes/tasks/_helpers/issueKey");
describe("issueKey helpers", () => {
    describe("formatIssueKey", () => {
        test("formats key + number into PROJ-N", () => {
            expect(formatIssueKey("PSSPMT", 123)).toBe("PSSPMT-123");
        });
        test("upper-cases project key", () => {
            expect(formatIssueKey("proj", 1)).toBe("PROJ-1");
        });
        test("returns null on missing parts", () => {
            expect(formatIssueKey(null, 1)).toBeNull();
            expect(formatIssueKey("X", null)).toBeNull();
            expect(formatIssueKey("", 1)).toBeNull();
        });
    });
    describe("extractIssueKeys", () => {
        test("finds a single key in a branch name", () => {
            const out = extractIssueKeys("feature/PSSPMT-123-add-login");
            expect(out).toEqual([{ projectKey: "PSSPMT", taskNumber: 123, raw: "PSSPMT-123" }]);
        });
        test("finds multiple distinct keys and dedupes", () => {
            const out = extractIssueKeys("PROJ-1 and PROJ-2 and PROJ-1 again");
            expect(out).toHaveLength(2);
            expect(out.map((r) => r.raw).sort()).toEqual(["PROJ-1", "PROJ-2"]);
        });
        test("finds keys in commit messages with mixed case", () => {
            const out = extractIssueKeys("fix: addressed psspmt-9 review notes");
            expect(out).toEqual([{ projectKey: "PSSPMT", taskNumber: 9, raw: "PSSPMT-9" }]);
        });
        test("accepts lowercase prefixes via case-insensitive match", () => {
            // Our regex uses /i so a lowercase "fix-123" matches and is then
            // upper-cased to FIX-123.
            const out = extractIssueKeys("fix-123 in the readme");
            expect(out).toEqual([{ projectKey: "FIX", taskNumber: 123, raw: "FIX-123" }]);
        });
        test("returns [] on empty / null input", () => {
            expect(extractIssueKeys("")).toEqual([]);
            expect(extractIssueKeys(null)).toEqual([]);
            expect(extractIssueKeys(undefined)).toEqual([]);
        });
        test("does not match keys without the dash", () => {
            expect(extractIssueKeys("PROJ123")).toEqual([]);
        });
        test("does not match keys with single-letter prefixes", () => {
            // Project keys must be 2+ chars (regex: [A-Z][A-Z0-9_]{1,9})
            expect(extractIssueKeys("X-123")).toEqual([]);
        });
        // The regex is intentionally generic — *any* project key the user
        // creates (PSSPMT, WEB, CORE, MARKETING2024, …) is picked up
        // automatically. There's no hardcoded prefix anywhere in the code.
        test("matches an arbitrary user-defined project key", () => {
            // Project keys are 2–10 chars per the DB CHECK constraint
            // `^[A-Z][A-Z0-9_]{1,9}$`, so the regex tops out at 10.
            const samples = [
                { text: "feature/WEB-1-landing", key: "WEB", n: 1 },
                { text: "release/CORE-9999-merge", key: "CORE", n: 9999 },
                { text: "fixes WP_CORE-42 review", key: "WP_CORE", n: 42 },
                { text: "A1-7 spike", key: "A1", n: 7 },
                { text: "see MARKETING-7", key: "MARKETING", n: 7 },
            ];
            for (const s of samples) {
                const out = extractIssueKeys(s.text);
                expect(out.length).toBeGreaterThan(0);
                expect(out[0].raw).toBe(`${s.key}-${s.n}`);
            }
        });
    });
});
//# sourceMappingURL=issueKey.test.js.map