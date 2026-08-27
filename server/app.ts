/**
 * Express application composition.
 *
 * Middleware order is a security and behavior contract: static assets precede
 * CORS/auth; webhook routes precede CSRF; specialized body limits precede the
 * global parser; tenant resolution precedes auth; SPA/error handlers are last.
 */
import express from "express";
import type { Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import { requestLogger } from "./utils/logger";
import { resolveTenant } from "./middleware/tenant";
import { createRateLimiters } from "./http/middleware/rateLimits";
import { mountWebhookRoutes, mountApiRoutes } from "./http/routes";
import { mountHealthRoutes } from "./http/health";
import { installSecurity } from "./http/middleware/security";
import { installCors } from "./http/middleware/cors";
import { installStaticSpa, installSpaFallback } from "./http/middleware/staticSpa";
import { installUploadServing } from "./http/middleware/uploads";
import { installErrorHandler } from "./http/middleware/errors";
import {
    installHttpMetrics,
    mountMetricsEndpoint,
    tracingContextMiddleware,
} from "./platform/metrics";

function buildApp() {
    const app = express();

    // Cloudflare edge + Railway proxy = two trusted hops. Using 1 makes
    // express-rate-limit key on Railway's proxy rather than the real client.
    app.set("trust proxy", 2);

    installSecurity(app);
    const serveSpa = process.env.SERVE_SPA !== "false";
    const clientDist = serveSpa ? installStaticSpa(app, __dirname) : null;
    installCors(app);

    app.use(cookieParser());
    app.use("/api/notes", express.json({ limit: "5mb" }));
    app.use("/api/profile/avatar", express.json({ limit: "10mb" }));
    app.use(express.json({ limit: "100kb" }));
    app.use(express.urlencoded({ limit: "100kb", extended: true }));
    app.use(requestLogger);
    // After requestLogger so `req.id` exists; the duration is measured on
    // `finish`, by which point resolveTenant has populated the tenant label.
    installHttpMetrics(app);

    app.use(resolveTenant);
    // H4: enrich the active span once tenant/user context is resolvable.
    app.use(tracingContextMiddleware);
    installUploadServing(app, __dirname);

    // External webhook senders cannot supply the browser CSRF header.
    mountWebhookRoutes(app);
    app.use("/api", (req: Request, res: Response, next: NextFunction) => {
        if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
        const xrw = req.headers["x-requested-with"];
        if (xrw === "WorkPulse" || xrw === "AINO") return next();
        return res.status(403).json({ error: "Missing CSRF header" });
    });

    mountApiRoutes(app, createRateLimiters());
    mountHealthRoutes(app);
    // Token-guarded and outside /api, so it is never subject to the CSRF
    // header check or the SPA fallback.
    mountMetricsEndpoint(app);

    if (clientDist) installSpaFallback(app, clientDist);
    installErrorHandler(app);
    return app;
}

// Compatibility singleton for Supertest and the current combined process.
const app = buildApp();

export { app, buildApp };