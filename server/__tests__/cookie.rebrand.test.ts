export {};

/**
 * REBRAND (WorkPulse -> AINO) — desktop cross-site cookie regression tests.
 *
 * The Electron app loads from a custom-protocol origin, so its auth cookie must
 * be `SameSite=None; Secure`. `cookieOptions()` only relaxes SameSite for
 * origins on the DESKTOP_COOKIE_ORIGINS allowlist.
 *
 * This is the subtlest failure mode in the whole rename: if a desktop origin
 * drops off the allowlist, the cookie silently falls back to `SameSite=Strict`,
 * which a custom-protocol origin cannot send back. Login then *appears* to
 * succeed and the very next request is unauthenticated — an infinite login
 * loop, with no error anywhere in the logs. These tests pin both schemes.
 */

describe("cookieOptions — desktop origin allowlist", () => {
    const loadCookieOptions = () => {
        let mod: { cookieOptions: (req: any, maxAge?: number) => any };
        jest.isolateModules(() => {
            mod = require("../utils/cookie");
        });
        return mod!.cookieOptions;
    };

    const withOrigin = (origin: string) => ({ headers: { origin } });

    afterEach(() => {
        delete process.env.DESKTOP_COOKIE_ORIGINS;
        jest.resetModules();
    });

    test.each([
        ["legacy desktop scheme", "workpulse://app"],
        ["rebranded desktop scheme", "aino://app"],
    ])("%s gets a cross-site cookie", (_label, origin) => {
        const cookieOptions = loadCookieOptions();
        const opts = cookieOptions(withOrigin(origin));

        // SameSite=None is only legal alongside Secure, so both must be set.
        expect(opts.sameSite).toBe("none");
        expect(opts.secure).toBe(true);
        expect(opts.httpOnly).toBe(true);
    });

    test("a normal web origin keeps the strict same-site cookie", () => {
        const cookieOptions = loadCookieOptions();
        const opts = cookieOptions(withOrigin("https://aino.org.in"));

        // Browser origins must NOT be relaxed — that would widen CSRF exposure.
        expect(opts.sameSite).toBe("strict");
    });

    test("an unrelated custom scheme is not treated as desktop", () => {
        const cookieOptions = loadCookieOptions();
        const opts = cookieOptions(withOrigin("evil://app"));

        expect(opts.sameSite).toBe("strict");
    });

    test("DESKTOP_COOKIE_ORIGINS override still parses a comma list", () => {
        process.env.DESKTOP_COOKIE_ORIGINS = "aino://,custom://";
        const cookieOptions = loadCookieOptions();

        expect(cookieOptions(withOrigin("custom://app")).sameSite).toBe("none");
        expect(cookieOptions(withOrigin("aino://app")).sameSite).toBe("none");
        // Explicitly overriding the list drops the built-in legacy default.
        expect(cookieOptions(withOrigin("workpulse://app")).sameSite).toBe("strict");
    });
});
