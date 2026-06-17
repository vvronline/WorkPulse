"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cookieOptions = cookieOptions;
const isProduction = process.env.NODE_ENV === "production";
const useSecureCookie = isProduction && process.env.USE_HTTPS === "true";
/**
 * Origins that are allowed to receive a cross-site (`sameSite: 'none'`) auth
 * cookie. This exists solely for the desktop (Electron) app, which loads from a
 * custom-protocol origin and therefore needs a cross-site cookie. The list is
 * an explicit allowlist (overridable via DESKTOP_COOKIE_ORIGINS) rather than a
 * broad `startsWith` so the relaxed cookie can't be coaxed out for unexpected
 * scheme prefixes. Note: the browser sets `Origin`, so a third-party web page
 * cannot spoof this to weaken a victim's cookie — relaxation only affects the
 * caller's own session — but keeping a tight allowlist is good hygiene.
 */
const DESKTOP_COOKIE_ORIGINS = (process.env.DESKTOP_COOKIE_ORIGINS || "workpulse://")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
function isDesktopOrigin(origin) {
    const o = String(origin || "").toLowerCase();
    return DESKTOP_COOKIE_ORIGINS.some(allowed => o === allowed || o.startsWith(allowed));
}
/**
 * Generate cookie options for a request.
 * @param req - Express request object
 * @param maxAge - Cookie max age in ms (default: 8 hours)
 * @returns Cookie options
 */
function cookieOptions(req, maxAge) {
    const defaultMaxAge = maxAge || 8 * 60 * 60 * 1000;
    // Desktop (Electron) app uses a custom protocol origin — needs cross-site cookies.
    // A cross-site cookie must also be Secure per the cookie spec, so only relax
    // when we can actually mark it Secure (always true here for the desktop branch).
    const origin = req?.headers?.origin || "";
    if (isDesktopOrigin(origin)) {
        return { httpOnly: true, secure: true, sameSite: "none", maxAge: defaultMaxAge, path: "/" };
    }
    return {
        httpOnly: true,
        secure: useSecureCookie,
        sameSite: "strict",
        maxAge: defaultMaxAge,
        path: "/",
    };
}
//# sourceMappingURL=cookie.js.map