import type { Express, Request, Response, NextFunction } from "express";
const helmet = require("helmet");

/** Register security headers. Keep the directives in sync with client features. */
function installSecurity(app: Express): void {
    const isProduction = process.env.NODE_ENV === "production";
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                ...helmet.contentSecurityPolicy.getDefaultDirectives(),
                "upgrade-insecure-requests": null,
                "frame-src": ["'self'", "https://embed.diagrams.net", "https://www.diagrams.net"],
                "img-src": [
                    "'self'", "data:", "blob:",
                    "https://*.tile.openstreetmap.org",
                    "https://unpkg.com",
                    "https://*.giphy.com",
                ],
                // MediaPipe requires wasm-unsafe-eval for background effects.
                "script-src": ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", "https://cdn.jsdelivr.net"],
                "script-src-elem": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
                "worker-src": ["'self'", "blob:"],
                "connect-src": [
                    "'self'",
                    "https://cdn.jsdelivr.net",
                    "https://nominatim.openstreetmap.org",
                    "https://*.giphy.com",
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