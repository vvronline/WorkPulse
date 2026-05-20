/**
 * Status routes — v2 public surface (presence + manual status + activity).
 *
 * INVARIANTS:
 *   • All reads and writes go through `services/status` — never touch
 *     `users.user_status` / `users.user_status_text` from here.
 *   • Endpoints are mounted under `/api/me/status` for the v2 client.
 *   • Legacy endpoints (`GET/PUT /api/chat/status`) are migrated separately
 *     in routes/chat.js to also go through StatusService, so REST and WS
 *     produce identical effective state regardless of which path is used.
 */

const express = require('express');
const auth = require('../middleware/auth');
const { requireTenant } = require('../middleware/tenant');
const statusService = require('../services/status');
const { MANUAL_STATUSES, PRESENCE_PREFERENCES } = require('../services/status/constants');

const router = express.Router();
router.use(requireTenant);

function asCtx(req) {
    return {
        db: req.db,
        tenantId: req.tenantId || null,
        actorUserId: req.userId,
        logger: req.log,
    };
}

// ─── GET /api/me/status ──────────────────────────────────────────────────────
// Returns the freshly-resolved effective state. Used by the client on boot
// (and any time it needs to recompute outside of WS events).
router.get('/', auth, async (req, res) => {
    try {
        const payload = await statusService.getEffective(asCtx(req), req.userId);
        if (!payload) return res.status(404).json({ error: 'User not found' });
        res.json(payload);
    } catch (err) {
        req.log.error({ err }, 'GET /me/status error');
        res.status(500).json({ error: 'Failed to load status' });
    }
});

// ─── PUT /api/me/status ──────────────────────────────────────────────────────
// Body: { status?: 'available'|'busy'|'dnd'|'brb'|null,
//         message?: string|null,
//         messageExpiresAt?: ISO|null }
// Passing { status: null } clears the manual choice (resolver falls back).
router.put('/', auth, async (req, res) => {
    try {
        const { status, message, messageExpiresAt } = req.body || {};

        // Allow null (clear) or any value in the v2 enum.
        if (status !== null && status !== undefined && !MANUAL_STATUSES.includes(status)) {
            return res.status(400).json({
                error: `Invalid status. Allowed: null, ${MANUAL_STATUSES.join(', ')}`,
            });
        }
        const safeMessage = typeof message === 'string' ? message.trim().slice(0, 100) : null;
        const safeExpiry = messageExpiresAt ? new Date(messageExpiresAt) : null;
        if (safeExpiry && Number.isNaN(safeExpiry.getTime())) {
            return res.status(400).json({ error: 'Invalid messageExpiresAt — must be an ISO date string.' });
        }

        const payload = await statusService.setManualStatus(asCtx(req), {
            status: status ?? null,
            message: safeMessage,
            messageExpiresAt: safeExpiry,
        });
        res.json(payload);
    } catch (err) {
        req.log.error({ err }, 'PUT /me/status error');
        res.status(500).json({ error: 'Failed to update status' });
    }
});

// ─── PUT /api/me/status/presence-preference ──────────────────────────────────
// Body: { preference: 'auto' | 'invisible' }
// This is the "Appear Offline" toggle. Separate from manual_status so that
// turning invisible off does NOT clobber the user's actual choice (busy/dnd/...).
router.put('/presence-preference', auth, async (req, res) => {
    try {
        const { preference } = req.body || {};
        if (!PRESENCE_PREFERENCES.includes(preference)) {
            return res.status(400).json({
                error: `Invalid preference. Allowed: ${PRESENCE_PREFERENCES.join(', ')}`,
            });
        }
        const payload = await statusService.setPresencePreference(asCtx(req), preference);
        res.json(payload);
    } catch (err) {
        req.log.error({ err }, 'PUT /me/status/presence-preference error');
        res.status(500).json({ error: 'Failed to update presence preference' });
    }
});

// ─── POST /api/me/status/activity-ping ───────────────────────────────────────
// Lightweight call from the client whenever the user shows real input
// activity (mousemove / keypress, throttled). Updates `last_activity_at` so
// the resolver flips 'away' back to 'available' on the next read.
//
// Returns no payload — it intentionally does NOT broadcast a `user_status`
// event so this can be called every minute or two without spamming the org.
router.post('/activity-ping', auth, async (req, res) => {
    try {
        await statusService.recordActivityPing(asCtx(req));
        res.json({ ok: true });
    } catch (err) {
        req.log.error({ err }, 'POST /me/status/activity-ping error');
        res.status(500).json({ error: 'Failed to record activity ping' });
    }
});

module.exports = router;