/**
 * Phase H1 — the single Prometheus registry for this process.
 *
 * Everything that records a metric imports from here. Creating a second
 * registry would silently split the scrape output, so the module is a
 * deliberate singleton with a test-only reset.
 *
 * Default Node/process collectors are enabled once, guarded so repeated
 * imports (jest module resets, role dispatch) cannot register duplicates —
 * prom-client throws on a duplicate metric name.
 */
import { Registry, collectDefaultMetrics } from "prom-client";

const registry = new Registry();

/** Every series carries the role + instance so a scrape can be attributed. */
function baseLabels(): Record<string, string> {
    return {
        role: (process.env.ROLE || "all").toLowerCase(),
        instance_id: process.env.RAILWAY_REPLICA_ID || `${process.pid}`,
    };
}

registry.setDefaultLabels(baseLabels());

let defaultsStarted = false;

/** Enable process/heap/GC collectors exactly once. */
function startDefaultMetrics(): void {
    if (defaultsStarted) return;
    defaultsStarted = true;
    collectDefaultMetrics({ register: registry, prefix: "aino_" });
}

/** Render the scrape body. */
async function renderMetrics(): Promise<string> {
    return registry.metrics();
}

/** The exposition Content-Type prom-client expects scrapers to receive. */
function metricsContentType(): string {
    return registry.contentType;
}

/** Test-only: drop every series so suites cannot leak into each other. */
function __resetForTests(): void {
    registry.resetMetrics();
}

export {
    registry,
    baseLabels,
    startDefaultMetrics,
    renderMetrics,
    metricsContentType,
    __resetForTests,
};
