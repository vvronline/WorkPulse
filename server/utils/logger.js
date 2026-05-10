/**
 * Structured logger based on pino.
 *
 * - JSON output in production (machine-parseable, easy to ship to ELK/GCP).
 * - Pretty coloured output in development.
 * - Provides a child-logger factory `createReqLogger(req)` that automatically
 *   attaches requestId, userId, and method/url to every log line.
 */
const pino = require('pino');
const crypto = require('crypto');

const isProduction = process.env.NODE_ENV === 'production';

const logger = pino({
    level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
    ...(isProduction
        ? {} // JSON to stdout — let the log shipper handle formatting
        : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }),
});

/**
 * Express middleware: assigns a unique request ID and attaches a child logger
 * to `req.log`.  Logs request start and finish (with duration).
 */
function requestLogger(req, res, next) {
    req.id = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('x-request-id', req.id);

    req.log = logger.child({ reqId: req.id });

    const start = Date.now();

    // Multi-tenant log enrichment: once tenant resolution / auth middleware
    // populates req.tenant or req.userId, expose a helper that swaps in a
    // richer child logger so subsequent log lines automatically carry
    // tenantId / slug / userId.
    req.enrichLogger = function enrichLogger() {
        const ctx = { reqId: req.id };
        if (req.tenant) {
            ctx.tenantId = req.tenant.id;
            ctx.slug = req.tenant.slug;
        } else if (req.tenantId) {
            ctx.tenantId = req.tenantId;
        } else {
            ctx.tenantId = 'master';
        }
        if (req.userId) ctx.userId = req.userId;
        if (req.userRole) ctx.role = req.userRole;
        req.log = logger.child(ctx);
    };

    res.on('finish', () => {
        const duration = Date.now() - start;
        // Best-effort enrichment if downstream middleware didn't call enrichLogger
        const tenantId = req.tenant?.id ?? req.tenantId ?? 'master';
        const slug = req.tenant?.slug ?? undefined;
        const line = {
            method: req.method,
            url: req.originalUrl,
            status: res.statusCode,
            duration,
            tenantId,
            slug,
            userId: req.userId || undefined,
        };
        if (res.statusCode >= 500) {
            req.log.error(line, 'request error');
        } else if (res.statusCode >= 400) {
            req.log.warn(line, 'request warning');
        } else {
            req.log.info(line, 'request');
        }
    });

    next();
}

module.exports = { logger, requestLogger };
