import path from "path";
import fs from "fs";
import type { Request, Response, NextFunction } from "express";

const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
    require("dotenv").config({ path: envPath });
} else {
    require("dotenv").config();
}

import { logger, requestLogger } from "./utils/logger";
import type { DbContext } from "./types/domain";

if (!process.env.JWT_SECRET) {
    logger.fatal("JWT_SECRET environment variable is not set. Server cannot start.");
    process.exit(1);
}

import express from "express";
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { RedisStore } = require("rate-limit-redis");
const cookieParser = require("cookie-parser");
import { pool, initDB, masterQuery } from "./db";
import * as redis from "./redis";
const { resolveTenant } = require("./middleware/tenant");
import { getTenantPool, destroyAllPools, forEachTenant } from "./utils/tenantManager";
const authRoutes = require("./routes/auth");
const trackerRoutes = require("./routes/tracker");
const leaveRoutes = require("./routes/leaves");
const taskRoutes = require("./routes/tasks");
const profileRoutes = require("./routes/profile");
const organizationRoutes = require("./routes/organization");
const adminRoutes = require("./routes/admin");
const internalRoutes = require("./routes/internal");
const managerRoutes = require("./routes/manager");
const leavePolicyRoutes = require("./routes/leavePolicy");
const sprintsRoutes = require("./routes/sprints");
const agileRoutes = require("./routes/agile");
const notesRoutes = require("./routes/notes");

const calendarRoutes = require("./routes/calendar");
const notificationsRoutes = require("./routes/notifications");
const exportRoutes = require("./routes/export");
const chatRoutes = require("./routes/chat");
const giphyRoutes = require("./routes/giphy");
const statusRoutes = require("./routes/status");
const searchRoutes = require("./routes/search");
const meetingsRoutes = require("./routes/meetings");
const tenantRoutes = require("./routes/tenants");
const platformAccessRoutes = require("./routes/platformAccess");
const serviceDeskRoutes = require("./routes/serviceDesk");
const brandingRoutes = require("./routes/branding");
const customFieldsRoutes = require("./routes/customFields");
const publicRoutes = require("./routes/public");
const compensationRoutes = require("./routes/compensation");
const webhookRoutes = require("./routes/webhooks");
// Stage 3 — Projects (Jira-style PROJ-123) + per-org Git/etc integrations.
const projectsRoutes = require("./routes/projects");
const integrationsRoutes = require("./routes/integrations");
import { setupWebSocket } from "./utils/ws";
import { createCollaborationServer } from "./utils/collaboration";
import { initJobs, shutdownJobs } from "./jobs";

const app = express();
const PORT = process.env.PORT || 5000;

app.set("trust proxy", 1);

const isProduction = process.env.NODE_ENV === "production";

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            // upgrade-insecure-requests omitted: serving over plain HTTP (no TLS)
            "upgrade-insecure-requests": null,
            // Allow embedding the official draw.io editor in an <iframe> so
            // the Notes feature can use it for diagram editing.
            "frame-src": ["'self'", "https://embed.diagrams.net", "https://www.diagrams.net"],
            // Allow `blob:` images — needed for client-side previews that
            // use `URL.createObjectURL()` (e.g. the org logo preview in
            // Admin → Branding before saving). Helmet's default img-src is
            // `'self' data:` and silently blocks blob URLs otherwise.
            //
            // Leaflet (Attendance → Office location picker) loads:
            //   - Map tile PNGs from {a,b,c}.tile.openstreetmap.org
            //   - The default marker/marker-shadow PNGs from unpkg's CDN
            // so we whitelist both origins here.
            "img-src": [
                "'self'", "data:", "blob:",
                "https://*.tile.openstreetmap.org",
                "https://unpkg.com",
                // GIPHY GIF/Sticker thumbnails (chat picker) are served from
                // *.giphy.com (media0-4.giphy.com, i.giphy.com, etc.).
                "https://*.giphy.com",
            ],
            // Allow loading MediaPipe Selfie Segmentation script + WASM from
            // jsdelivr at runtime (used for meeting background blur / virtual
            // backgrounds). Loaded lazily only when the user enables an
            // effect, so default users incur zero cost.
            //
            // 'wasm-unsafe-eval' is REQUIRED — MediaPipe ships its inference
            // engine as WebAssembly and the browser refuses to compile it
            // without this directive (errors look like
            // "CompileError: WebAssembly.instantiate(): Refused to compile
            //  or instantiate WebAssembly module because 'unsafe-eval' is
            //  not an allowed source of script in the following Content
            //  Security Policy directive: \"script-src\"").
            "script-src": ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", "https://cdn.jsdelivr.net"],
            "script-src-elem": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
            "worker-src": ["'self'", "blob:"],
            // MediaPipe also fetches the .wasm binary + .tflite model files
            // from jsdelivr at runtime — `connect-src` covers those XHR/fetches.
            // *.giphy.com is needed because the chat GIF picker fetches the
            // selected GIF's media URL client-side to build a File for upload.
            "connect-src": ["'self'", "https://cdn.jsdelivr.net", "https://nominatim.openstreetmap.org", "https://*.giphy.com", "ws:", "wss:"],
        },
    },
    crossOriginOpenerPolicy: false,
    originAgentCluster: false,
    // Prevent click-jacking
    frameguard: { action: "deny" },
    // Strict transport security for HTTPS deployments
    hsts: isProduction ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
}));

// Helmet 8.x does not support permissionsPolicy — set the header manually
app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self)");
    // Prevent browsers from MIME-sniffing
    res.setHeader("X-Content-Type-Options", "nosniff");
    // Referrer policy to prevent leaking URLs (e.g. password reset tokens)
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
});

// Serve React static files BEFORE cors/auth — assets don't need CORS
const clientDist = path.join(__dirname, "..", "client", "dist");
// Cache-bust: hashed assets get long cache, index.html/sw.js never cached
app.use(express.static(clientDist, {
    setHeaders(res: Response, filePath: string) {
        if (filePath.endsWith(".html") || filePath.endsWith("sw.js")) {
            res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        } else if (/\.(?:js|mjs|css|map|woff2?|ttf|eot|otf|png|jpe?g|gif|svg|webp|ico|avif)$/i.test(filePath)) {
            // Vite emits content-hashed filenames (foo.abc123.js) for all of
            // these — long-cache them aggressively. The earlier regex missed
            // .jpeg, .gif, .ico, .webp, .ttf, and source maps (.map) which
            // meant those assets revalidated on every navigation.
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
    },
}));

app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;

    const isAllowed = (() => {
        if (!origin) return true;

        // Explicitly allowed origins from env (comma-separated)
        if (process.env.CORS_ORIGIN) {
            const allowed = process.env.CORS_ORIGIN.split(",").map((s) => s.trim());
            if (allowed.includes(origin)) return true;
        }

        // Always allow same-origin requests: when the SPA served by this
        // Express server makes API calls, Origin matches the Host header.
        // This works regardless of what domain Railway assigns.
        const host = req.headers.host;
        if (host && (origin === `https://${host}` || origin === `http://${host}`)) {
            return true;
        }

        // Allow Electron desktop app (custom protocol origin)
        if (origin.startsWith("workpulse://")) return true;

        if (process.env.NODE_ENV !== "production") {
            const devOrigins = [
                `http://localhost:${PORT}`, "http://localhost", "https://localhost",
                "http://localhost:3000", "http://localhost:3001", "http://localhost:3002", "http://localhost:5173",
            ];
            if (devOrigins.includes(origin)) return true;
        }

        return false;
    })();

    if (!isAllowed) {
        return res.status(403).json({ error: "Not allowed by CORS" });
    }

    if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, x-timezone-offset");
    }

    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
});
app.use(cookieParser());
app.use("/api/notes", express.json({ limit: "5mb" }));
app.use("/api/profile/avatar", express.json({ limit: "10mb" }));
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ limit: "100kb", extended: true }));

// Structured request logging with request IDs
app.use(requestLogger);

// Tenant resolution — must come before auth and all /api routes
app.use(resolveTenant);

const authMiddleware = require("./middleware/auth");
// Per-tenant uploads enforcement.
//
// Canonical layout (written by server/utils/uploadPath.js):
//   /uploads/tenant_<tenantId>/org_<orgId>/<kind>/<file>
//
// Rules:
//   1. Path must stay inside the uploads root (no traversal).
//   2. If the path has a `tenant_<id>` segment, it MUST equal req.tenantId.
//   3. If the path has an `org_<id>` segment, it MUST equal the user's org.
//   4. Legacy paths without a tenant prefix (e.g. /uploads/org_X/avatars/...
//      or the very old /uploads/chat/...) are still served, but only with
//      the org check above. New uploads always carry the tenant prefix.
app.use("/uploads", authMiddleware, async (req: any, res: Response, next: NextFunction) => {
    const resolved = path.resolve(__dirname, "uploads", req.path.replace(/^\//, ""));
    if (!resolved.startsWith(path.resolve(__dirname, "uploads"))) {
        return res.status(403).json({ error: "Forbidden" });
    }

    // Enforce tenant isolation when the URL is tenant-prefixed.
    const tenantMatch = req.path.match(/^\/tenant_(\d+)\//);
    if (tenantMatch) {
        const pathTenantId = parseInt(tenantMatch[1], 10);
        if (!req.tenantId || req.tenantId !== pathTenantId) {
            return res.status(403).json({ error: "Forbidden" });
        }
    } else if (req.tenantId) {
        // The user is in a tenant context but the requested file lives at a
        // legacy non-tenant path. Only allow if no other tenant could have
        // written there — i.e. it's an org-scoped legacy path. Reject any
        // request that has neither a tenant_ nor org_ segment, because
        // those files (e.g. /uploads/chat/foo) are not safe to share
        // across tenants.
        const hasOrgSegment = /\/org_(\d+)\//.test(req.path);
        if (!hasOrgSegment) {
            return res.status(403).json({ error: "Forbidden" });
        }
    }

    // Enforce org isolation whenever the URL contains an `org_<id>` segment.
    const orgMatch = req.path.match(/\/org_(\d+)\//);
    if (orgMatch) {
        const pathOrgId = parseInt(orgMatch[1], 10);
        const user = (await req.db.query("SELECT org_id FROM users WHERE id = $1", [req.userId])).rows[0];
        if (!user || user.org_id !== pathOrgId) {
            return res.status(403).json({ error: "Forbidden" });
        }
    }
    // Uploaded files may include user-supplied SVGs (avatars, chat files,
    // logos) which the browser executes as an active document if opened
    // directly — a stored-XSS vector. Forbid MIME sniffing and sandbox the
    // response so embedded script can't run. (Does not affect <img> embedding.)
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    next();
}, express.static(path.join(__dirname, "uploads")));

// Webhooks must be mounted BEFORE CSRF middleware (external services can't send X-Requested-With)
app.use("/api/webhooks", webhookRoutes);

app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const xrw = req.headers["x-requested-with"];
    if (xrw === "WorkPulse") return next();
    return res.status(403).json({ error: "Missing CSRF header" });
});

// Build a Redis-backed store factory; falls back to in-memory when Redis is unavailable
function makeStore(prefix: string) {
    const redisClient = redis.getClient();
    if (redisClient) {
        return new RedisStore({ sendCommand: (...args: unknown[]) => (redisClient as any).call(...args), prefix: `rl:${prefix}:` });
    }
    return undefined; // express-rate-limit uses MemoryStore by default
}

// Per-tenant rate limiting: include tenantId in the key so tenants can't exhaust each other's quotas
const tenantKeyGen = (req: any) => `${req.tenantId || "master"}:${req.ip}`;
const rlOpts = (prefix: string, max: number) => ({ windowMs: 15 * 60 * 1000, max, store: makeStore(prefix), keyGenerator: tenantKeyGen, validate: { keyGeneratorIpFallback: false } });
const authLimiter = rateLimit({ ...rlOpts("auth", 15), message: { error: "Too many attempts. Please try again later." } });
const registerLimiter = rateLimit({ ...rlOpts("reg", 10), message: { error: "Too many registration attempts. Please try again later." } });
const forgotPasswordLimiter = rateLimit({ ...rlOpts("fp", 5), message: { error: "Too many password reset attempts. Please try again later." } });
const passwordLimiter = rateLimit({ ...rlOpts("pw", 10), message: { error: "Too many password attempts. Please try again later." } });
const apiLimiter = rateLimit({ ...rlOpts("api", 5000), message: { error: "Too many requests. Please try again later." } });

// Audit every action during impersonation sessions
const impersonationAudit = require("./middleware/impersonationAudit");
app.use("/api", impersonationAudit);

// Maintenance mode — returns 503 for non-platform-admin users when active
const { maintenanceModeMiddleware } = require("./middleware/maintenanceMode");
app.use("/api", maintenanceModeMiddleware);

app.use("/api/auth/register", registerLimiter);
app.use("/api/auth/forgot-password", forgotPasswordLimiter);
// Biometric login is a PUBLIC credential-exchange endpoint (device secret →
// session). Rate-limit it on its own bucket so brute-forcing a stolen
// credentialId can't ride the broader /api/auth quota.
app.use("/api/auth/biometric/login", authLimiter);
app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/tracker", apiLimiter, trackerRoutes);
app.use("/api/leaves", apiLimiter, leaveRoutes);
app.use("/api/tasks", apiLimiter, taskRoutes);
app.use("/api/sprints", apiLimiter, sprintsRoutes);
app.use("/api/agile", apiLimiter, agileRoutes);
app.use("/api/profile/password", passwordLimiter);
app.use("/api/profile", apiLimiter, profileRoutes);
app.use("/api/org", apiLimiter, organizationRoutes);
app.use("/api/admin", apiLimiter, adminRoutes);
app.use("/api/admin/tenants", apiLimiter, tenantRoutes);
// Tenant-side endpoints for the Just-In-Time platform-access consent flow.
// Used by tenant super_admins to approve/deny/revoke platform-admin
// impersonation requests. Lives at /api/platform-access so it's clearly
// separated from the platform-side /api/admin/tenants/access-requests
// endpoints (which run under the platform_admin guard).
app.use("/api/platform-access", apiLimiter, platformAccessRoutes);
// Phase 6 — Internal observability endpoints (platform_admin only).
// Currently just /api/internal/ws-stats; future db-pool / redis stats
// will mount under the same router.
app.use("/api/internal", apiLimiter, internalRoutes);
app.use("/api/manager", apiLimiter, managerRoutes);
app.use("/api/leave-policy", apiLimiter, leavePolicyRoutes);
app.use("/api/notes", apiLimiter, notesRoutes);
app.use("/api/calendar", apiLimiter, calendarRoutes);
app.use("/api/meetings", apiLimiter, meetingsRoutes);
app.use("/api/notifications", apiLimiter, notificationsRoutes);
app.use("/api/export", apiLimiter, exportRoutes);
app.use("/api/chat", apiLimiter, chatRoutes);
app.use("/api/giphy", apiLimiter, giphyRoutes);
app.use("/api/me/status", apiLimiter, statusRoutes);
app.use("/api/search", apiLimiter, searchRoutes);
app.use("/api/service-desk", apiLimiter, serviceDeskRoutes);
app.use("/api/branding", apiLimiter, brandingRoutes);
app.use("/api/custom-fields", apiLimiter, customFieldsRoutes);
app.use("/api/compensation", apiLimiter, compensationRoutes);
// Stage 3 routers
app.use("/api/projects", apiLimiter, projectsRoutes);
app.use("/api/integrations", apiLimiter, integrationsRoutes);
// Public (unauthenticated) endpoints — share links, etc. Mounted with the
// standard apiLimiter only (no auth, no tenant middleware). The route file
// itself enforces token validity.
app.use("/api/public", apiLimiter, publicRoutes);

app.get("/api/health", async (req: Request, res: Response) => {
    try {
        await masterQuery("SELECT 1");
        const detail = req.query.detail === "true";
        if (detail) {
            const { expectedMigrationCount } = require("./utils/migrationRunner");
            const migResult = await masterQuery("SELECT COUNT(*)::int AS count FROM _migrations");
            const appliedCount = migResult.rows[0]?.count || 0;
            const migrationsOk = appliedCount >= expectedMigrationCount;
            return res.status(migrationsOk ? 200 : 503).json({
                status: migrationsOk ? "ok" : "degraded",
                time: new Date().toISOString(),
                migrations: { applied: appliedCount, expected: expectedMigrationCount },
            });
        }
        res.json({ status: "ok", time: new Date().toISOString() });
    } catch (err: unknown) {
        logger.error({ err }, "Health check DB ping failed");
        res.status(503).json({ status: "error", time: new Date().toISOString(), error: "Database unreachable" });
    }
});

// ============= AUTO CLOCK-OUT (multi-tenant) =============
async function autoClockOut(): Promise<void> {
    const result = await forEachTenant(
        async (db: DbContext) => { await autoClockOutForDb(db); },
        { label: "autoClockOut" },
    );
    if (result.failed > 0) {
        logger.warn({ ok: result.ok, failed: result.failed }, "autoClockOut completed with failures");
    }
}

async function autoClockOutForDb(db: DbContext): Promise<void> {
    const activeUsers = (await db.query<{ id: number; timezone_offset?: number }>(`
        SELECT u.id, u.timezone_offset
        FROM users u
        INNER JOIN LATERAL (
            SELECT entry_type FROM time_entries t
            WHERE t.user_id = u.id
            ORDER BY t.timestamp DESC
            LIMIT 1
        ) latest ON latest.entry_type != 'clock_out'
    `)).rows;

    if (activeUsers.length === 0) return;

    // Process in batches to avoid overwhelming the connection pool
    const BATCH = 50;
    for (let i = 0; i < activeUsers.length; i += BATCH) {
        const batch = activeUsers.slice(i, i + BATCH);
        await Promise.allSettled(batch.map((user) =>
            autoClockOutUser(db, user).catch((e) =>
                logger.error({ userId: user.id, err: e }, "Auto clock-out failed"),
            ),
        ));
    }
}

async function autoClockOutUser(db: DbContext, user: { id: number; timezone_offset?: number }): Promise<void> {
    const rawOffset = user.timezone_offset || 0;
    // Clamp to valid timezone range: UTC-12 (720) to UTC+14 (-840)
    const offsetMin = (typeof rawOffset === "number" && rawOffset >= -840 && rawOffset <= 720) ? rawOffset : 0;

    await db.transaction!(async (client: any) => {
        // Find the user's single most-recent live entry across ALL dates. A
        // session is "open" when this latest entry is not a clock_out. Working
        // from the actual open entry (rather than a recomputed "yesterday")
        // makes the boundary robust even when `users.timezone_offset` is stale
        // or 0 — the previous version recomputed "yesterday" from that offset,
        // so a wrong offset stamped the clock_out into the wrong local day,
        // which the non-live attendance reader then couldn't pair → the day was
        // truncated and wrongly marked Absent (e.g. an 8h overnight shift that
        // showed as 4.06h). We anchor the end-of-day boundary on the OPEN
        // session's own clock-in day instead.
        const lastEntryRow = (await client.query(`
            SELECT id, entry_type, timestamp FROM time_entries
            WHERE user_id = $1 AND is_manual IS NOT TRUE
            ORDER BY timestamp DESC, id DESC LIMIT 1
        `, [user.id])).rows[0];

        if (!lastEntryRow || lastEntryRow.entry_type === "clock_out") return;

        // Parse the open entry's timestamp to epoch ms (DB stores UTC; the value
        // may or may not carry a trailing 'Z').
        const lastTsRaw = lastEntryRow.timestamp instanceof Date
            ? lastEntryRow.timestamp.toISOString()
            : String(lastEntryRow.timestamp).replace(" ", "T");
        const lastMs = new Date(/[Zz]$/.test(lastTsRaw) ? lastTsRaw : lastTsRaw + "Z").getTime();

        // Only auto-close sessions that are no longer "today" in the user's
        // local timezone — i.e. the session has rolled past local midnight.
        // A still-current-day open session is left alone (the user may still be
        // working; the /tracker/status target-met path handles same-day close).
        const nowMs = Date.now();
        const localToday = new Date(nowMs - offsetMin * 60000).toISOString().slice(0, 10);
        const sessionLocalDay = new Date(lastMs - offsetMin * 60000).toISOString().slice(0, 10);
        if (sessionLocalDay >= localToday) return;

        // End-of-day (23:59:59 local) of the OPEN session's own local day,
        // expressed back in UTC. Guard against ever stamping a clock_out that
        // precedes the open entry (clock skew / bad offset) by falling back to
        // lastMs + 1s in that pathological case.
        const [y, m, d] = sessionLocalDay.split("-").map(Number);
        let boundaryMs = Date.UTC(y, m - 1, d, 23, 59, 59) + offsetMin * 60000;
        if (boundaryMs <= lastMs) boundaryMs = lastMs + 1000;
        const autoTs = new Date(boundaryMs).toISOString().slice(0, 19).replace("T", " ");

        if (lastEntryRow.entry_type === "break_start") {
            await client.query("INSERT INTO time_entries (user_id, entry_type, timestamp) VALUES ($1, $2, $3)",
                [user.id, "break_end", autoTs]);
        }
        await client.query("INSERT INTO time_entries (user_id, entry_type, timestamp) VALUES ($1, $2, $3)",
            [user.id, "clock_out", autoTs]);
        logger.info({ userId: user.id, date: sessionLocalDay, offsetMin }, "Auto clock-out applied");
    });
}

// Cleanup expired/used password reset tokens every hour (multi-tenant)
async function cleanupTokens(): Promise<void> {
    const result = await forEachTenant(
        async (db: DbContext) => {
            await db.query("DELETE FROM password_reset_tokens WHERE used = TRUE OR expires_at < NOW()");
        },
        { label: "cleanupTokens" },
    );
    if (result.failed > 0) {
        logger.warn({ ok: result.ok, failed: result.failed }, "cleanupTokens completed with failures");
    }
}

// SPA fallback: only serve index.html for navigation requests, not file/asset requests
app.get(/^[^.]*$/, (req: Request, res: Response, next: NextFunction) => {
    res.sendFile(path.join(clientDist, "index.html"), (err) => {
        if (err) next(err);
    });
});

app.use((err: any, req: any, res: Response, _next: NextFunction) => {
    (req.log || logger).error({ err }, "Unhandled error");
    res.status(500).json({ error: "Internal server error" });
});

// Export app for testing (supertest)
export { app };

/**
 * Bootstrap the database schema + run pending migrations.
 *
 * Why a dedicated function: the original code did this inside the
 * `require.main === module` block so it would run only when `node index.js`
 * was invoked directly. That broke production deployments on Railway (and
 * other PaaS) whose container runtime imports the module via a wrapper
 * (e.g. `node -e "require('./server/index.js')"`, pm2, Nixpacks, etc.),
 * leaving the DB stuck on whatever schema it had at the original deploy.
 *
 * The new behaviour:
 *   - In test mode (NODE_ENV === 'test'): skip bootstrap so supertest is fast
 *     and isolated.
 *   - Otherwise: always bootstrap, regardless of how the module was loaded.
 *     We use a guard flag so concurrent imports don't run it twice.
 */
let bootstrapPromise: Promise<void> | null = null;
async function bootstrap(): Promise<void> {
    if (bootstrapPromise) return bootstrapPromise;
    bootstrapPromise = (async () => {
        await initDB();
        redis.initRedis();
        try {
            const { sweepAllTenants } = require("./utils/migrationRunner");
            await sweepAllTenants();
            logger.info("Migration sweep complete on bootstrap");
        } catch (err: unknown) {
            logger.error({ err: (err as Error).message }, "Migration sweep FAILED on bootstrap — schema may be incomplete");
        }
        // Data scrub: remove platform-admin memberships that a historical
        // login bug seeded into customer (non-default) tenants. Idempotent —
        // a no-op once every tenant is clean. See
        // scrubPlatformAdminsFromCustomerTenants() for details.
        try {
            const { scrubPlatformAdminsFromCustomerTenants } = require("./utils/migrationRunner");
            await scrubPlatformAdminsFromCustomerTenants();
        } catch (err: unknown) {
            logger.error({ err: (err as Error).message }, "Platform-admin tenant scrub FAILED on bootstrap (non-fatal)");
        }
    })();
    return bootstrapPromise;
}

// Auto-bootstrap when imported by something other than a test runner.
// `require.main === module` (the direct-invocation path below) also calls
// bootstrap(); the memoised promise means we never run twice.
if (process.env.NODE_ENV !== "test") {
    bootstrap().catch((err) => {
        logger.error({ err }, "Bootstrap failed at module load — server may run with stale schema");
    });
}

// Only start the HTTP server when run directly (not when imported for tests
// or by environments that just want the express app instance).
if (require.main === module) {
    const http = require("http");
    (async () => {
        await bootstrap();
        const httpServer = http.createServer(app);
        setupWebSocket(httpServer);

        // Collaboration WebSocket server (Yjs/Hocuspocus) on /collab path
        await createCollaborationServer(httpServer);

        httpServer.listen(PORT, () => {
            logger.info({ port: PORT }, "Server running");
        });

        initJobs({ autoClockOut, cleanupTokens });

        async function shutdown() {
            logger.info("Shutting down gracefully...");
            httpServer.close(async () => {
                await shutdownJobs();
                await redis.shutdown();
                await destroyAllPools();
                await pool.end();
                process.exit(0);
            });
            setTimeout(async () => { await shutdownJobs(); await redis.shutdown(); await destroyAllPools(); await pool.end(); process.exit(1); }, 5000);
        }
        process.on("SIGTERM", shutdown);
        process.on("SIGINT", shutdown);
    })();
}