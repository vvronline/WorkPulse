/**
 * Phase H2 — HTTP request duration by route + status.
 *
 * The route label MUST be the mounted template (`/api/tasks/:id`), never the
 * concrete URL. Labelling with `req.originalUrl` would create one series per
 * task id and is the classic way to melt a Prometheus server.
 */
import type { Express, Request, Response, NextFunction } from "express";
import { Histogram, Counter } from "prom-client";
import { registry } from "./registry";
import { tenantLabel } from "./tenantLabel";

// Buckets tuned for an API that should answer in tens of milliseconds, with
// enough headroom above 1s to see the tail that SLO alerts fire on.
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const httpDuration = new Histogram({
    name: "aino_http_request_duration_seconds",
    help: "HTTP request duration in seconds by route template, method and status.",
    labelNames: ["method", "route", "status", "tenant"] as const,
    buckets: DURATION_BUCKETS,
    registers: [registry],
});

const httpInFlight = new Counter({
    name: "aino_http_requests_total",
    help: "Total HTTP requests by route template, method and status class.",
    labelNames: ["method", "route", "status_class"] as const,
    registers: [registry],
});

/**
 * Resolve the Express route template for a finished request.
 *
 * `req.route` is populated only when a router actually matched, so unmatched
 * requests (404 probes, scanners) collapse to a single `unmatched` series
 * rather than one series per probed path.
 */
function routeTemplate(req: Request): string {
    const route = (req as any).route?.path;
    const base = req.baseUrl || "";
    if (typeof route === "string" && route.length > 0) {
        const joined = `${base}${route === "/" ? "" : route}`;
        return joined.length > 0 ? joined : "/";
    }
    // Mounted middleware without a matched leaf (e.g. a 401 from auth) still
    // knows its mount path, which is the useful aggregate.
    if (base.length > 0) return `${base}/*`;
    return "unmatched";
}

/** Record duration/count for every request once the response is flushed. */
function httpMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
        const seconds = Number(process.hrtime.bigint() - start) / 1e9;
        const route = routeTemplate(req);
        const status = String(res.statusCode);
        const tenant = tenantLabel((req as any).tenant?.id ?? (req as any).tenantId ?? null);
        httpDuration.observe({ method: req.method, route, status, tenant }, seconds);
        httpInFlight.inc({
            method: req.method,
            route,
            status_class: `${status[0]}xx`,
        });
    });
    next();
}

/** Install the collector. Mount before routes so `res.on(finish)` is armed. */
function installHttpMetrics(app: Express): void {
    app.use(httpMetricsMiddleware);
}

export { installHttpMetrics, httpMetricsMiddleware, routeTemplate, httpDuration, httpInFlight };
