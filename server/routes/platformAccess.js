/**
 * Tenant-side endpoints for the Just-In-Time Platform Access workflow.
 *
 * These run in the TENANT context (i.e. authenticated as a regular tenant
 * user, super_admin specifically) — not in the platform_admin context.
 * They let the tenant's super_admin:
 *
 *   - See incoming access requests in an inbox
 *   - Approve a request (server returns a one-shot 6-digit code)
 *   - Deny a request
 *   - See who currently has an active impersonation session
 *   - Revoke an active session (force the inspector out)
 *
 * Mounted in server/index.js as:
 *     app.use('/api/platform-access', apiLimiter, platformAccessRoutes);
 */
const express = require('express');
const auth = require('../middleware/auth');
const { masterQuery } = require('../db');
const { loadUserContext, requireRole } = require('../middleware/rbac');
const { logger } = require('../utils/logger');
const {
    generateApprovalCode, hashApprovalCode,
    getImpersonationPolicy, computeEffectiveStatus,
    expireStaleRequests, getActiveSession,
} = require('../utils/impersonationApproval');
const { logPlatformAction, updatePlatformAuditLog } = require('../utils/platformAudit');

const router = express.Router();

// Auth + role gate.
//
// Who can approve / deny / revoke a platform-admin support session for THIS
// tenant?
//   - `super_admin` — canonical tenant owner.
//   - `hr_admin`    — the people-ops role; in most orgs this is the
//                     "IT coordinator" who would actually field a support
//                     request from the platform team. Including hr_admin
//                     keeps the consent flow practical in companies that
//                     don't have a dedicated super_admin user online 24/7.
//
// We intentionally do NOT allow `platform_admin` to self-approve via this
// endpoint — that would defeat the entire consent model (the platform_admin
// IS the inspector).
const APPROVER_ROLES = new Set(['super_admin', 'hr_admin']);

router.use(auth, loadUserContext, (req, res, next) => {
    if (!APPROVER_ROLES.has(req.userRole)) {
        return res.status(403).json({
            error: 'Only super admins or HR admins can manage platform access requests.',
        });
    }
    if (!req.tenantId) {
        return res.status(400).json({ error: 'Tenant context required.' });
    }
    next();
});

/** Strip internal fields (`approval_code_hash` must never leave the server). */
function publicRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        tenant_id: row.tenant_id,
        requested_by: row.requested_by,
        requested_by_name: row.requested_by_name,
        requested_by_email: row.requested_by_email,
        requested_at: row.requested_at,
        reason: row.reason,
        scope: row.scope,
        duration_minutes: row.duration_minutes,
        status: computeEffectiveStatus(row),
        raw_status: row.status,
        approved_by: row.approved_by,
        approved_by_name: row.approved_by_name,
        approved_at: row.approved_at,
        denied_reason: row.denied_reason,
        code_expires_at: row.code_expires_at,
        consumed_at: row.consumed_at,
        session_ends_at: row.session_ends_at,
        revoked_at: row.revoked_at,
        revoked_by_name: row.revoked_by_name,
        revoked_reason: row.revoked_reason,
        cancelled_at: row.cancelled_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

// GET /api/platform-access — list requests for THIS tenant
//
// Includes pending/approved/recent history so the inbox can show both
// "needs your attention" and audit context.
router.get('/', async (req, res) => {
    try {
        await expireStaleRequests();
        const { status, limit: rawLimit, offset } = req.query;
        const limit = Math.min(Math.max(Number(rawLimit) || 50, 1), 200);
        const off = Math.max(Number(offset) || 0, 0);

        const where = ['tenant_id = $1'];
        const params = [req.tenantId];
        let p = 2;
        if (status) { where.push(`status = $${p++}`); params.push(status); }

        const result = await masterQuery(`
            SELECT * FROM tenant_access_requests
             WHERE ${where.join(' AND ')}
             ORDER BY requested_at DESC
             LIMIT $${p++} OFFSET $${p++}
        `, [...params, limit, off]);

        res.json({
            requests: result.rows.map(publicRow),
            active_session: await getActiveSession(req.tenantId),
        });
    } catch (err) {
        logger.error({ err }, 'platformAccess.list error');
        res.status(500).json({ error: 'Failed to list access requests' });
    }
});

// POST /api/platform-access/:id/approve
//
// Generates a one-shot 6-digit code, hashes it, and returns the PLAINTEXT
// exactly once. The platform admin will need to type this code on the
// impersonate page within `code_ttl_minutes`.
router.post('/:id/approve', async (req, res) => {
    try {
        const rid = Number(req.params.id);
        const row = (await masterQuery(
            'SELECT * FROM tenant_access_requests WHERE id = $1 AND tenant_id = $2',
            [rid, req.tenantId],
        )).rows[0];
        if (!row) return res.status(404).json({ error: 'Request not found' });
        if (row.status !== 'pending') {
            return res.status(409).json({ error: `Cannot approve a request in status '${row.status}'.` });
        }

        const policy = await getImpersonationPolicy();
        const code = generateApprovalCode();
        const codeHash = await hashApprovalCode(code);
        const codeExpiresAt = new Date(Date.now() + policy.codeTtlMinutes * 60 * 1000);

        await masterQuery(`
            UPDATE tenant_access_requests
               SET status              = 'approved',
                   approved_by         = $1,
                   approved_by_name    = $2,
                   approved_at         = NOW(),
                   approval_code_hash  = $3,
                   code_expires_at     = $4,
                   updated_at          = NOW()
             WHERE id = $5
        `, [req.userId, req.username || null, codeHash, codeExpiresAt, rid]);

        // Mirror into platform audit log (master DB) so the inspector's
        // history shows the approval timestamp + approver.
        logPlatformAction({
            userId: row.requested_by,           // actor on the platform side
            ip: req.ip, headers: req.headers,
        }, 'tenant_access_request_approved', 'tenant_access_request', rid, {
            approved_by_user_id: req.userId,
            approved_by_username: req.username || null,
            code_expires_at: codeExpiresAt,
        }, req.tenantId);

        // Notify the requester via WebSocket so their UI flips to the
        // "Enter the 6-digit code" step automatically.
        try {
            const { sendToUser } = require('../utils/ws');
            // Inspector is a platform_user; their WS connection is keyed
            // by tenantId=0 in clients map (no tenant context). Both
            // null tenant and the target tenant are notified so the
            // tenant-side detail page also refreshes.
            sendToUser(0, row.requested_by, 'platform_access_request_approved', {
                request_id: rid, code_expires_at: codeExpiresAt,
            });
            const { broadcast } = require('../utils/ws');
            broadcast(req.tenantId, 'platform_access_request_updated', publicRow({
                ...row,
                status: 'approved', approved_at: new Date(),
                approved_by: req.userId, approved_by_name: req.username,
                code_expires_at: codeExpiresAt,
            }));
        } catch { /* ws not initialised in tests */ }

        res.json({
            message: 'Request approved.',
            // Plaintext code returned ONLY in this response. Never logged.
            approval_code: code,
            code_expires_at: codeExpiresAt,
        });
    } catch (err) {
        logger.error({ err }, 'platformAccess.approve error');
        res.status(500).json({ error: 'Failed to approve request' });
    }
});

// POST /api/platform-access/:id/deny
router.post('/:id/deny', async (req, res) => {
    try {
        const rid = Number(req.params.id);
        const reason = (req.body?.reason || '').toString().trim().slice(0, 500) || null;

        const row = (await masterQuery(
            'SELECT * FROM tenant_access_requests WHERE id = $1 AND tenant_id = $2',
            [rid, req.tenantId],
        )).rows[0];
        if (!row) return res.status(404).json({ error: 'Request not found' });
        if (row.status !== 'pending') {
            return res.status(409).json({ error: `Cannot deny a request in status '${row.status}'.` });
        }

        await masterQuery(`
            UPDATE tenant_access_requests
               SET status        = 'denied',
                   denied_reason = $1,
                   approved_by   = $2,
                   approved_by_name = $3,
                   approved_at   = NOW(),
                   updated_at    = NOW()
             WHERE id = $4
        `, [reason, req.userId, req.username || null, rid]);

        logPlatformAction({
            userId: row.requested_by,
            ip: req.ip, headers: req.headers,
        }, 'tenant_access_request_denied', 'tenant_access_request', rid, {
            denied_by_user_id: req.userId, denied_reason: reason,
        }, req.tenantId);

        try {
            const { sendToUser, broadcast } = require('../utils/ws');
            sendToUser(0, row.requested_by, 'platform_access_request_denied', {
                request_id: rid, denied_reason: reason,
            });
            broadcast(req.tenantId, 'platform_access_request_updated', publicRow({
                ...row, status: 'denied', denied_reason: reason,
            }));
        } catch { /* ws not initialised in tests */ }

        res.json({ message: 'Request denied.' });
    } catch (err) {
        logger.error({ err }, 'platformAccess.deny error');
        res.status(500).json({ error: 'Failed to deny request' });
    }
});

// POST /api/platform-access/:id/revoke — kill an active impersonation session
//
// This forcibly ends a `status='consumed'` request. The platform admin's
// JWT will continue to validate against its signature until it expires, so
// we also bump the access_request status so the `loadUserContext`
// middleware can reject any further requests carrying that token. (See
// the new check added to middleware/auth.js below.)
router.post('/:id/revoke', async (req, res) => {
    try {
        const rid = Number(req.params.id);
        const reason = (req.body?.reason || '').toString().trim().slice(0, 500) || null;

        const row = (await masterQuery(
            'SELECT * FROM tenant_access_requests WHERE id = $1 AND tenant_id = $2',
            [rid, req.tenantId],
        )).rows[0];
        if (!row) return res.status(404).json({ error: 'Request not found' });
        if (row.status !== 'consumed' || row.revoked_at) {
            return res.status(409).json({ error: 'There is no active session for this request.' });
        }

        await masterQuery(`
            UPDATE tenant_access_requests
               SET status         = 'revoked',
                   revoked_at     = NOW(),
                   revoked_by     = $1,
                   revoked_by_name = $2,
                   revoked_reason = $3,
                   updated_at     = NOW()
             WHERE id = $4
        `, [req.userId, req.username || null, reason, rid]);

        // Close the audit log row for this session so the duration is correct.
        if (row.session_audit_log_id) {
            await updatePlatformAuditLog(row.session_audit_log_id, {
                ended_at: new Date(),
                details: {
                    revoked: true,
                    revoked_by_user_id: req.userId,
                    revoked_reason: reason,
                },
            });
        }

        logPlatformAction({
            userId: row.requested_by,
            ip: req.ip, headers: req.headers,
        }, 'tenant_access_session_revoked', 'tenant_access_request', rid, {
            revoked_by_user_id: req.userId, revoked_reason: reason,
        }, req.tenantId);

        // Notify both the inspector and the tenant. The inspector's frontend
        // catches `platform_access_session_revoked` and force-logs-out of
        // the impersonation context.
        try {
            const { sendToUser, broadcast } = require('../utils/ws');
            sendToUser(0, row.requested_by, 'platform_access_session_revoked', {
                request_id: rid, revoked_reason: reason,
            });
            broadcast(req.tenantId, 'platform_access_session_ended', {
                request_id: rid, revoked: true, revoked_by_name: req.username,
            });
        } catch { /* ws not initialised in tests */ }

        res.json({ message: 'Session revoked.' });
    } catch (err) {
        logger.error({ err }, 'platformAccess.revoke error');
        res.status(500).json({ error: 'Failed to revoke session' });
    }
});

// GET /api/platform-access/active-session — the currently-active session, if any
router.get('/active-session', async (req, res) => {
    try {
        const row = await getActiveSession(req.tenantId);
        res.json({ active_session: row });
    } catch (err) {
        logger.error({ err }, 'platformAccess.activeSession error');
        res.status(500).json({ error: 'Failed to read active session' });
    }
});

module.exports = router;