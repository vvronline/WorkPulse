/**
 * Phase H1 — the `/metrics` scrape endpoint, mounted on all three roles.
 *
 * Access control: the exposition format leaks tenant identifiers, route
 * inventory and queue names, so it is NOT public. A scraper must present
 * `Authorization: Bearer $METRICS_TOKEN`.
 *
 * If `METRICS_TOKEN` is unset the endpoint is disabled in production and open
 * in development. Failing *closed* matters: an unauthenticated `/metrics` on
 * a public Railway domain is an information-disclosure bug, and defaulting to
 * "open because someone forgot a variable" is how that ships.
 */
import type { Express, Request, Response } from "express";
import { renderMetrics, metricsContentType, startDefaultMetrics } from "./registry";
import { logger } from "../../utils/logger";

// Importing for side effects: each module registers its collectors with the
// shared registry at load time.
import "./collectors";
import "./jobMetrics";

/** Constant-time compare so the token cannot be recovered by timing. */
function safeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

function isAuthorized(req: Request): boolean {
    const token = process.env.METRICS_TOKEN;
    if (!token) return process.env.NODE_ENV !== "production";
    const header = req.headers.authorization || "";
    const prefix = "Bearer ";
    if (!header.startsWith(prefix)) return false;
    return safeEqual(header.slice(prefix.length), token);
}

/** Mount `GET /metrics`. Safe to call from every role, including worker. */
function mountMetricsEndpoint(app: Express): void {
    startDefaultMetrics();

    if (process.env.NODE_ENV === "production" && !process.env.METRICS_TOKEN) {
        logger.warn(
            "METRICS_TOKEN is not set — /metrics returns 404 in production. " +
            "Set it to enable Prometheus scraping.",
        );
    }

    app.get("/metrics", async (req: Request, res: Response) => {
        if (!isAuthorized(req)) {
            // 404 rather than 401: an unauthenticated caller should not learn
            // that a metrics endpoint exists here at all.
            return res.status(404).json({ error: "Not found" });
        }
        try {
            const body = await renderMetrics();
            res.setHeader("Content-Type", metricsContentType());
            res.setHeader("Cache-Control", "no-store");
            return res.send(body);
        } catch (err: unknown) {
            logger.error({ err }, "Failed to render Prometheus metrics");
            return res.status(500).json({ error: "Metrics collection failed" });
        }
    });
}

export { mountMetricsEndpoint, isAuthorized };
