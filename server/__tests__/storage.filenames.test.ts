/**
 * Upload filenames must be unguessable.
 *
 * WHY
 *   The old format was `<userId>_<Date.now()>.<ext>` — both components are
 *   guessable, so a single authorization regression would allow BULK
 *   enumeration of other users' objects rather than exposing one file.
 *   Authorization is still the real control; this is defence in depth, matching
 *   Slack's opaque file IDs (`F012AB3CDE4`).
 */
import { randomFilename, isLegacyGuessableFilename } from "../platform/storage/filenames";

describe("randomFilename", () => {
    it("does not embed a user id or timestamp", () => {
        const name = randomFilename("user", "jpg");
        expect(isLegacyGuessableFilename(name)).toBe(false);
        // A Date.now() value (13 digits) must not appear anywhere.
        expect(name).not.toMatch(/\d{13}/);
    });

    it("is unique across many calls", () => {
        const names = new Set(Array.from({ length: 5000 }, () => randomFilename("chat", "png")));
        expect(names.size).toBe(5000);
    });

    it("carries at least 128 bits of entropy", () => {
        const token = randomFilename("user", "jpg").split("_")[1].split(".")[0];
        expect(token).toHaveLength(32);
        expect(token).toMatch(/^[0-9a-f]{32}$/);
    });

    it("keeps the prefix and extension readable", () => {
        expect(randomFilename("logo", "svg")).toMatch(/^logo_[0-9a-f]{32}\.svg$/);
    });

    // The prefix is cosmetic, but it lands inside an object key, so it must not
    // be able to inject a path separator and escape the tenant/org prefix.
    it.each([
        ["../../etc", "passwd"],
        ["a/b", "p/q"],
        ["a\\b", "x\\y"],
        ["us er", "j pg"],
    ])("sanitises unsafe prefix %j and extension %j", (prefix, ext) => {
        const name = randomFilename(prefix, ext);
        expect(name).not.toMatch(/[/\\.]{2}/);
        expect(name.split("/")).toHaveLength(1);
        expect(name.split("\\")).toHaveLength(1);
        expect(name).toMatch(/^[a-zA-Z0-9_-]+_[0-9a-f]{32}\.[a-zA-Z0-9]+$/);
    });

    it("falls back to safe defaults for empty input", () => {
        expect(randomFilename("", "")).toMatch(/^file_[0-9a-f]{32}\.bin$/);
    });
});

describe("isLegacyGuessableFilename", () => {
    it("recognises the formats we replaced", () => {
        // chat/task-comments: <userId>_<timestamp>.<ext>
        expect(isLegacyGuessableFilename("3_1784374535316.mp4")).toBe(true);
        // avatars: user_<userId>_<timestamp>.<ext>
        expect(isLegacyGuessableFilename("user_1_1787837968191.jpg")).toBe(true);
    });

    it("does not flag the new random format", () => {
        for (const prefix of ["user", "chat", "comment", "logo"]) {
            expect(isLegacyGuessableFilename(randomFilename(prefix, "jpg"))).toBe(false);
        }
    });
});
