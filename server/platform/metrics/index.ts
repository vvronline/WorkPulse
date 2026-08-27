/**
 * Phase H observability surface.
 *
 * Import from here rather than from the individual files so the composition
 * root has one dependency and the internal layout can change freely.
 */
export {
    registry,
    renderMetrics,
    metricsContentType,
    startDefaultMetrics,
    __resetForTests,
} from "./registry";
export { mountMetricsEndpoint } from "./endpoint";
export { installHttpMetrics, httpMetricsMiddleware, routeTemplate } from "./httpMetrics";
export { tenantLabel, promotedTenants } from "./tenantLabel";
export { setWebSocketServer, readQueueDepths, QUEUE_NAMES } from "./collectors";
export { observeJob } from "./jobMetrics";
export {
    startMigrationDriftSampler,
    stopMigrationDriftSampler,
    sampleMigrationDrift,
} from "./migrationMetrics";
export {
    startTracing,
    stopTracing,
    isTracingEnabled,
    tracingContextMiddleware,
} from "./tracing";
