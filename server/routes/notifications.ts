import express from "express";
import type { Request, Response } from "express";
const auth = require("../middleware/auth");
const { loadUserContext } = require("../middleware/rbac");
const { logger } = require("../utils/logger");

const router = express.Router();
const { requireTenant } = require("../middleware/tenant");
router.use(auth, loadUserContext, requireTenant);

type NotificationMetricEventInput = {
    clientEventId: string;
    timestamp: number;
    level: string;
    event: string;
    dedupeKey?: string;
    conversationId?: string;
    messageId?: string;
    notificationType?: string;
    state?: string;
    durationMs?: number;
    source?: string;
    errorHash?: string;
    metadata?: Record<string, unknown>;
};

function optionalString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeMetricEvent(raw: unknown): NotificationMetricEventInput | null {
    if (!raw || typeof raw !== "object") return null;
    const item = raw as Record<string, unknown>;
    const clientEventId = optionalString(item.clientEventId);
    const event = optionalString(item.event);
    const timestamp = optionalNumber(item.timestamp);
    if (!clientEventId || !event || timestamp === undefined) return null;
    return {
        clientEventId,
        timestamp,
        level: optionalString(item.level) || "INFO",
        event,
        dedupeKey: optionalString(item.dedupeKey),
        conversationId: optionalString(item.conversationId),
        messageId: optionalString(item.messageId),
        notificationType: optionalString(item.notificationType),
        state: optionalString(item.state),
        durationMs: optionalNumber(item.durationMs),
        source: optionalString(item.source),
        errorHash: optionalString(item.errorHash),
        metadata: item.metadata && typeof item.metadata === "object"
            ? item.metadata as Record<string, unknown>
            : {},
    };
}

function parseWindowHours(value: unknown): number {
    const parsed = Math.trunc(Number(value));
    if (!Number.isFinite(parsed)) return 24;
    return Math.min(Math.max(parsed, 1), 24 * 7);
}

router.get("/", async (req: Request, res: Response) => {
    try {
        const page = Math.max(parseInt(String(req.query.page)) || 1, 1);
        const perPage = Math.min(Math.max(parseInt(String(req.query.per_page)) || 50, 1), 100);
        const offset = (page - 1) * perPage;

        const totalRes = await req.db!.query("SELECT COUNT(*) AS count FROM notifications WHERE user_id = $1", [req.userId]);
        const total = parseInt(totalRes.rows[0].count, 10);

        const rows = (await req.db!.query(`
            SELECT n.*, t.title AS task_title
            FROM notifications n
            LEFT JOIN tasks t ON t.id = n.link_task_id
            WHERE n.user_id = $1
            ORDER BY n.created_at DESC
            LIMIT $2 OFFSET $3
        `, [req.userId, perPage, offset])).rows;
        const unread = (await req.db!.query("SELECT COUNT(*) AS count FROM notifications WHERE user_id = $1 AND is_read = FALSE", [req.userId])).rows[0].count;
        res.json({ notifications: rows, unread: parseInt(unread, 10), total, page, perPage });
    } catch (err) {
        req.log.error({ err }, "Error fetching notifications");
        res.status(500).json({ error: "Failed to fetch notifications" });
    }
});

router.post("/metrics/events", async (req: Request, res: Response) => {
    try {
        const rawEvents = req.body?.events;
        if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
            return res.status(400).json({ error: "events must be a non-empty array" });
        }
        if (rawEvents.length > 200) {
            return res.status(400).json({ error: "events array too large (max 200)" });
        }

        const events = rawEvents
            .map(normalizeMetricEvent)
            .filter((item): item is NotificationMetricEventInput => item !== null);

        if (events.length !== rawEvents.length) {
            return res.status(400).json({ error: "one or more events are invalid" });
        }

        let inserted = 0;
        for (const event of events) {
            const result = await req.db!.query(
                `INSERT INTO notification_metric_events (
                    client_event_id, user_id, dedupe_key, conversation_id, message_id,
                    notification_type, level, event, state, source, duration_ms,
                    error_hash, metadata, client_timestamp
                ) VALUES (
                    $1, $2, $3, $4, $5,
                    $6, $7, $8, $9, $10, $11,
                    $12, $13::jsonb, TO_TIMESTAMP($14 / 1000.0)
                )
                ON CONFLICT (client_event_id) DO NOTHING`,
                [
                    event.clientEventId,
                    req.userId,
                    event.dedupeKey || null,
                    event.conversationId || null,
                    event.messageId || null,
                    event.notificationType || null,
                    event.level,
                    event.event,
                    event.state || null,
                    event.source || null,
                    event.durationMs ?? null,
                    event.errorHash || null,
                    JSON.stringify(event.metadata || {}),
                    event.timestamp,
                ],
            );
            inserted += result.rowCount || 0;
        }

        return res.json({
            ok: true,
            accepted: events.length,
            inserted,
            duplicates: events.length - inserted,
        });
    } catch (err) {
        req.log.error({ err }, "Error ingesting notification metric events");
        return res.status(500).json({ error: "Failed to ingest notification metric events" });
    }
});

router.get("/metrics", async (req: Request, res: Response) => {
    try {
        const windowHours = parseWindowHours(req.query.hours);
        const result = await req.db!.query(
            `WITH recent AS (
                SELECT *
                FROM notification_metric_events
                WHERE client_timestamp >= NOW() - make_interval(hours => $1::int)
            )
            SELECT
                COUNT(DISTINCT COALESCE(dedupe_key, client_event_id))::int AS total_notifications,
                COUNT(DISTINCT CASE
                    WHEN state IN ('tapped', 'route_persisted', 'route_consumed', 'navigation_started', 'navigation_completed')
                      OR event = 'notification_tapped'
                    THEN COALESCE(dedupe_key, client_event_id)
                END)::int AS routing_attempts,
                COUNT(DISTINCT CASE
                    WHEN state IN ('route_consumed', 'navigation_completed')
                    THEN COALESCE(dedupe_key, client_event_id)
                END)::int AS successful_routes,
                COUNT(DISTINCT CASE
                    WHEN level = 'ERROR'
                    THEN COALESCE(dedupe_key, client_event_id)
                END)::int AS failed_routes,
                COUNT(*) FILTER (WHERE event = 'message_skipped_duplicate')::int AS deduplicated_count,
                COUNT(*) FILTER (
                    WHERE event IN (
                        'payload_validation_failed_in_handler',
                        'tap_payload_validation_failed',
                        'payload_validation_unexpected_error'
                    )
                )::int AS validation_failures,
                COUNT(*) FILTER (WHERE event = 'delivery_failure')::int AS delivery_failures,
                COUNT(*) FILTER (WHERE state = 'delivered')::int AS delivered_count,
                COUNT(*) FILTER (WHERE state = 'displayed')::int AS displayed_count,
                COUNT(*) FILTER (WHERE state = 'tapped')::int AS tapped_count,
                COUNT(*) FILTER (WHERE state = 'route_persisted')::int AS route_persisted_count,
                COUNT(*) FILTER (WHERE state = 'route_consumed')::int AS route_consumed_count,
                MAX(client_timestamp) AS last_event_at,
                COALESCE((
                    SELECT ROUND(AVG(duration_ms)::numeric, 2)
                    FROM recent
                    WHERE duration_ms IS NOT NULL AND duration_ms > 0
                ), 0) AS average_latency_ms,
                COALESCE((
                    SELECT ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms)::numeric, 2)
                    FROM recent
                    WHERE duration_ms IS NOT NULL AND duration_ms > 0
                ), 0) AS p50_latency_ms,
                COALESCE((
                    SELECT ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)::numeric, 2)
                    FROM recent
                    WHERE duration_ms IS NOT NULL AND duration_ms > 0
                ), 0) AS p95_latency_ms
            FROM recent`,
            [windowHours],
        );

        const row = result.rows[0] || {};
        const routingAttempts = Number(row.routing_attempts || 0);
        const successfulRoutes = Number(row.successful_routes || 0);
        res.json({
            windowHours,
            successRate: routingAttempts > 0
                ? Number(((successfulRoutes / routingAttempts) * 100).toFixed(2))
                : null,
            counts: {
                totalNotifications: Number(row.total_notifications || 0),
                routingAttempts,
                successfulRoutes,
                failedRoutes: Number(row.failed_routes || 0),
                deduplicatedCount: Number(row.deduplicated_count || 0),
                validationFailures: Number(row.validation_failures || 0),
                deliveryFailures: Number(row.delivery_failures || 0),
                deliveredCount: Number(row.delivered_count || 0),
                displayedCount: Number(row.displayed_count || 0),
                tappedCount: Number(row.tapped_count || 0),
                routePersistedCount: Number(row.route_persisted_count || 0),
                routeConsumedCount: Number(row.route_consumed_count || 0),
            },
            latency: {
                averageMs: Number(row.average_latency_ms || 0),
                p50Ms: Number(row.p50_latency_ms || 0),
                p95Ms: Number(row.p95_latency_ms || 0),
            },
            lastEventAt: row.last_event_at || null,
        });
    } catch (err) {
        req.log.error({ err }, "Error fetching notification metrics");
        return res.status(500).json({ error: "Failed to fetch notification metrics" });
    }
});

router.post("/read-all", async (req: Request, res: Response) => {
    try {
        await req.db!.query("UPDATE notifications SET is_read = TRUE WHERE user_id = $1", [req.userId]);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: "Failed to mark notifications read" });
    }
});

router.post("/:id/read", async (req: Request, res: Response) => {
    try {
        const id = parseInt(String(req.params.id), 10);
        if (isNaN(id)) return res.status(400).json({ error: "Invalid notification ID" });
        await req.db!.query("UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2",
            [id, req.userId]);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: "Failed to mark notification read" });
    }
});

router.delete("/:id", async (req: Request, res: Response) => {
    try {
        const id = parseInt(String(req.params.id), 10);
        if (isNaN(id)) return res.status(400).json({ error: "Invalid notification ID" });
        await req.db!.query("DELETE FROM notifications WHERE id = $1 AND user_id = $2",
            [id, req.userId]);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: "Failed to delete notification" });
    }
});

router.get("/announcements", async (req: Request, res: Response) => {
    try {
        const rows = (await req.db!.query(`
            SELECT a.id, a.message, a.type, a.created_at, u.full_name AS author
            FROM announcements a
            LEFT JOIN users u ON u.id = a.created_by
            WHERE a.is_active = TRUE AND (a.org_id IS NULL OR a.org_id = $1)
              AND (a.expires_at IS NULL OR a.expires_at > NOW())
            ORDER BY a.created_at DESC LIMIT 20
        `, [req.userOrgId])).rows;
        res.json({ data: rows });
    } catch (err) {
        req.log.error({ err }, "Error fetching announcements");
        res.status(500).json({ error: "Failed to fetch announcements" });
    }
});

export = router;