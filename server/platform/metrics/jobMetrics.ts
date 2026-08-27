/**
 * Phase H2 — background job duration and outcome.
 *
 * Queue *depth* (collectors.ts) tells you work is piling up; this tells you
 * whether that is because jobs are slow or because they are failing and being
 * retried. Both are needed to act on a backlog alert.
 */
import { Histogram, Counter } from "prom-client";
import { registry } from "./registry";

// Background jobs legitimately run for minutes (tenant sweeps, media
// transcode), so the buckets extend far past the HTTP ones.
const JOB_BUCKETS = [0.1, 0.5, 1, 5, 15, 30, 60, 300, 900];

const jobDuration = new Histogram({
    name: "aino_job_duration_seconds",
    help: "Background job execution time in seconds by queue and outcome.",
    labelNames: ["queue", "outcome"] as const,
    buckets: JOB_BUCKETS,
    registers: [registry],
});

const jobRuns = new Counter({
    name: "aino_job_runs_total",
    help: "Background job executions by queue and outcome.",
    labelNames: ["queue", "outcome"] as const,
    registers: [registry],
});

/**
 * Time one job execution.
 *
 * Rethrows so instrumentation can never swallow a failure that BullMQ needs to
 * see in order to retry.
 */
async function observeJob<T>(queue: string, fn: () => Promise<T>): Promise<T> {
    const start = process.hrtime.bigint();
    let outcome = "success";
    try {
        return await fn();
    } catch (err) {
        outcome = "failure";
        throw err;
    } finally {
        const seconds = Number(process.hrtime.bigint() - start) / 1e9;
        jobDuration.observe({ queue, outcome }, seconds);
        jobRuns.inc({ queue, outcome });
    }
}

export { observeJob, jobDuration, jobRuns };
