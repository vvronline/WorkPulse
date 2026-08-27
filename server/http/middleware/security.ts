import type { Express, Request, Response, NextFunction } from "express";
const helmet = require("helmet");

/**
 * Origin that serves user uploads.
 *
 * A3 moved uploads to Cloudflare R2: `/uploads/...` now authorizes the request
 * and then 302-redirects to a short-lived presigned URL on
 * `<bucket>.<accountId>.r2.cloudflarestorage.com`. The browser follows that
 * redirect, so the FINAL origin is what CSP evaluates — not `'self'`.
 *
 * Without this every avatar, chat image, attachment preview and org logo is
 * blocked by CSP even though the request itself succeeded. It fails as a
 * console error and a broken image, with a 200 in the server logs.
 *
 * Scoped to the account subdomain rather than a bare `https:` wildcard so a
 * compromised page still cannot pull media from arbitrary hosts.
 */
function r2UploadOrigins(): string[] {
    const accountId = (process.env.R2_ACCOUNT_ID || "").trim();
    if (!accountId) return [];
    // Virtual-hosted style (`<bucket>.<account>.r2.cloudflarestorage.com`) and
    // path style (`<account>.r2.cloudflarestorage.com/<bucket>`) are both
    // emitted by the SDK depending on bucket name and options.
    return [
        `https://${accountId}.r2.cloudflarestorage.com`,
        `https://*.${accountId}.r2.cloudflarestorage.com`,
    ];
}

/** Register security headers. Keep the directives in sync with client features. */
function installSecurity(app: Express): void {
    const isProduction = process.env.NODE_ENV === "production";
    const uploadOrigins = r2UploadOrigins();
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                ...helmet.contentSecurityPolicy.getDefaultDirectives(),
                "upgrade-insecure-requests": null,
                // PDFs/attachments render in an iframe, which also follows the
                // /uploads -> R2 redirect.
                "frame-src": [
                    "'self'", "https://embed.diagrams.net", "https://www.diagrams.net",
                    ...uploadOrigins,
                ],
                "img-src": [
                    "'self'", "data:", "blob:",
                    "https://*.tile.openstreetmap.org",
                    "https://unpkg.com",
                    "https://*.giphy.com",
                    // Avatars, chat images, org logos (A3: served from R2).
                    ...uploadOrigins,
                ],
                // <audio>/<video> chat attachments stream straight from R2.
                "media-src": ["'self'", "data:", "blob:", ...uploadOrigins],
                // MediaPipe requires wasm-unsafe-eval for background effects.
                //
                // static.cloudflareinsights.com: Cloudflare Web Analytics INJECTS
                // this beacon into the HTML at the edge — it is not in our
                // index.html, so it appears only in production behind Cloudflare
                // and shows up as a CSP violation in every user's console.
                // Allow it here, or turn Web Analytics off in the Cloudflare
                // dashboard; leaving it blocked just means noisy consoles and no
                // analytics.
                "script-src": [
                    "'self'", "'unsafe-inline'", "'wasm-unsafe-eval'",
                    "https://cdn.jsdelivr.net",
                    "https://static.cloudflareinsights.com",
                ],
                "script-src-elem": [
                    "'self'", "'unsafe-inline'",
                    "https://cdn.jsdelivr.net",
                    "https://static.cloudflareinsights.com",
                ],
                "worker-src": ["'self'", "blob:"],
                "connect-src": [
                    "'self'",
                    "https://cdn.jsdelivr.net",
                    "https://nominatim.openstreetmap.org",
                    "https://*.giphy.com",
                    // fetch()/XHR against an upload (download buttons, media
                    // pipeline) follows the same redirect to R2.
                    ...uploadOrigins,
                    // The injected beacon POSTs its payload back to Cloudflare.
                    "https://cloudflareinsights.com",
                    "https://static.cloudflareinsights.com",
                    "ws:", "wss:",
                ],
            },
        },
        crossOriginOpenerPolicy: false,
        originAgentCluster: false,
        frameguard: { action: "deny" },
        hsts: isProduction
            ? { maxAge: 31536000, includeSubDomains: true, preload: true }
            : false,
    }));

    // Helmet 8 does not expose permissionsPolicy.
    app.use((_req: Request, res: Response, next: NextFunction) => {
        res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self)");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
        next();
    });
}

export { installSecurity };