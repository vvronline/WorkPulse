/**
 * Phase H4 — OpenTelemetry tracing.
 *
 * Opt-in by design: tracing starts only when `OTEL_EXPORTER_OTLP_ENDPOINT` is
 * set. A tracing SDK that boots unconditionally would add startup cost and a
 * background exporter to every local `npm test` run for no benefit.
 *
 * Two AINO-specific requirements the default instrumentations do not cover:
 *   1. The existing `x-request-id` (logger.ts) must appear on the span so a
 *      log line can be pivoted to its trace.
 *   2. Every request span must carry `tenant_id`, because in a DB-per-tenant
 *      system "which tenant" is the first question asked about any slow trace.
 */
import type { Request, Response, NextFunction } from "express";
import { logger } from "../../utils/logger";
import { tenantLabel } from "./tenantLabel";

let sdk: { shutdown: () => Promise<void> } | null = null;

/** True when the operator has configured an OTLP collector. */
function isTracingEnabled(): boolean {
    return Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
}

/**
 * Start the SDK. Idempotent and never throws — a telemetry misconfiguration
 * must not stop the server from serving traffic.
 */
function startTracing(): void {
    if (!isTracingEnabled() || sdk) return;
    try {
        const { NodeSDK } = require("@opentelemetry/sdk-node");
        const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
        const { resourceFromAttributes } = require("@opentelemetry/resources");
        const {
            ATTR_SERVICE_NAME,
            ATTR_SERVICE_VERSION,
        } = require("@opentelemetry/semantic-conventions");
        const { HttpInstrumentation } = require("@opentelemetry/instrumentation-http");
        const { ExpressInstrumentation } = require("@opentelemetry/instrumentation-express");
        const { PgInstrumentation } = require("@opentelemetry/instrumentation-pg");
        const { IORedisInstrumentation } = require("@opentelemetry/instrumentation-ioredis");

        const role = (process.env.ROLE || "all").toLowerCase();
        const instance = new NodeSDK({
            resource: resourceFromAttributes({
                [ATTR_SERVICE_NAME]: `aino-${role}`,
                [ATTR_SERVICE_VERSION]: process.env.RAILWAY_GIT_COMMIT_SHA || "dev",
                "deployment.environment": process.env.NODE_ENV || "development",
            }),
            traceExporter: new OTLPTraceExporter(),
            instrumentations: [
                // Health probes fire every few seconds on every replica and
                // would otherwise dominate the trace budget with no signal.
                new HttpInstrumentation({
                    ignoreIncomingRequestHook: (req: { url?: string }) =>
                        ["/healthz", "/readyz", "/metrics"].some((p) => req.url?.startsWith(p)),
                }),
                new ExpressInstrumentation(),
                new PgInstrumentation(),
                new IORedisInstrumentation(),
            ],
        });
        instance.start();
        sdk = instance;
        logger.info({ role }, "OpenTelemetry tracing started");
    } catch (err: unknown) {
        logger.error({ err }, "OpenTelemetry tracing failed to start — continuing without traces");
        sdk = null;
    }
}

/** Flush pending spans during graceful shutdown. */
async function stopTracing(): Promise<void> {
    if (!sdk) return;
    try {
        await sdk.shutdown();
    } catch (err: unknown) {
        logger.warn({ err }, "OpenTelemetry shutdown failed");
    } finally {
        sdk = null;
    }
}

/**
 * Attach `request.id` and a bounded `tenant_id` to the active span.
 *
 * Uses the same top-N bucketing as the metrics labels: a raw tenant id would
 * be a high-cardinality span attribute, which most trace backends bill for.
 */
function tracingContextMiddleware(req: Request, _res: Response, next: NextFunction): void {
    if (!isTracingEnabled()) return next();
    try {
        const { trace } = require("@opentelemetry/api");
        const span = trace.getActiveSpan();
        if (span) {
            if (req.id) span.setAttribute("request.id", String(req.id));
            const tenantId = (req as any).tenant?.id ?? (req as any).tenantId ?? null;
            span.setAttribute("tenant_id", tenantLabel(tenantId));
            if ((req as any).userId) span.setAttribute("enduser.id", String((req as any).userId));
        }
    } catch {
        /* never break a request for telemetry */
    }
    next();
}

export { startTracing, stopTracing, isTracingEnabled, tracingContextMiddleware };
