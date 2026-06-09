export {};

jest.mock("../utils/platformConfig", () => ({
    getPasswordPolicy: jest.fn().mockResolvedValue({
        minLength: 8, requireUppercase: true, requireNumber: true, requireSpecial: true,
    }),
    isMaintenanceMode: jest.fn().mockResolvedValue(false),
    getMaintenanceMessage: jest.fn().mockResolvedValue(""),
}));

const { validatePassword, validateUsername } = require("../utils/password");

describe("validatePassword", () => {
    test("rejects empty password", async () => {
        expect(await validatePassword("")).toBe("Password is required");
        expect(await validatePassword(null)).toBe("Password is required");
    });

    test("rejects short password", async () => {
        expect(await validatePassword("Ab1!xyz")).toMatch(/at least 8/);
    });

    test("rejects password over 72 bytes", async () => {
        const long = "Aa1!" + "x".repeat(69);
        expect(await validatePassword(long)).toMatch(/72 bytes/);
    });

    test("rejects password without lowercase", async () => {
        expect(await validatePassword("ABCDEFG1!")).toMatch(/lowercase/);
    });

    test("rejects password without uppercase", async () => {
        expect(await validatePassword("abcdefg1!")).toMatch(/uppercase/);
    });

    test("rejects password without digit", async () => {
        expect(await validatePassword("Abcdefgh!")).toMatch(/digit/);
    });

    test("rejects password without special char", async () => {
        expect(await validatePassword("Abcdefg1")).toMatch(/special/);
    });

    test("accepts valid password", async () => {
        expect(await validatePassword("StrongP@ss1")).toBeNull();
    });
});

describe("validateUsername", () => {
    test("rejects empty username", () => {
        expect(validateUsername("")).toBe("Username is required");
    });

    test("rejects too short", () => {
        expect(validateUsername("ab")).toMatch(/3-50/);
    });

    test("rejects too long", () => {
        expect(validateUsername("a".repeat(51))).toMatch(/3-50/);
    });

    test("rejects spaces", () => {
        expect(validateUsername("user name")).toMatch(/letters, numbers/);
    });

    test("rejects HTML characters", () => {
        expect(validateUsername("user<script>")).toMatch(/letters, numbers/);
    });

    test("accepts valid usernames", () => {
        expect(validateUsername("john_doe")).toBeNull();
        expect(validateUsername("jane-doe.123")).toBeNull();
    });
});