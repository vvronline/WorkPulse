/**
 * Service Desk Routes — cross-tenant ticket system.
 *
 * Any authenticated user from any tenant can submit tickets (bugs, feature requests,
 * access issues). Tickets are stored in the master DB and managed by the default
 * (platform) tenant's team via their backlog.
 *
 * Endpoints:
 *   GET    /service-desk/tickets        — List tickets (own tenant or all for default tenant)
 *   GET    /service-desk/tickets/:id    — Get single ticket
 *   POST   /service-desk/tickets        — Submit a new ticket
 *   PATCH  /service-desk/tickets/:id    — Update ticket (status, notes, assignment — default tenant only)
 *   DELETE /service-desk/tickets/:id    — Delete ticket (default tenant admin only)
 *   GET    /service-desk/stats          — Ticket stats (default tenant only)
 */
const express = require('express');
const { masterQuery } = require('../db');
const auth = require('../middleware/auth');
const { loadUserContext } = require('../middleware/rbac');
const { logger } = require('../utils/logger');

const router = express.Router();
router.use(auth, loadUserContext);

const VALID_TICKET_TYPES = ['bug', 'feature_request', 'access_issue', 'other'];
const VALID_PRIORITIES = ['low', 'medium', 'high', 'critical'];
const VALID_STATUSES = ['open', 'acknowledged', 'in_progress', 'resolved', 'closed'];

/**
 * Check if the current user belongs to the default (platform) tenant.
 */
async function isDefaultTenant(req) {
    if (!req.tenant) return false;
    const res = await masterQuery('SELECT is_default FROM tenants WHERE id = $1', [req.tenant.id]);
    return res.rows[0]?.is_default === true;
}

// GET /service-desk/tickets — list tickets
router.get('/tickets', async (req, res) => {
    try {
        const isAdmin = await isDefaultTenant(req);
        const { status, ticket_type, priority, page = 1, per_page = 50 } = req.query;
        const pageNum = Math.max(parseInt(page) || 1, 1);
        const perPage = Math.min(Math.max(parseInt(per_page) || 50, 1), 100);
        const offset = (pageNum - 1) * perPage;

        let where = [];
        let params = [];
        let idx = 1;

        // Non-default tenants can only see their own tickets
        if (!isAdmin) {
            if (!req.tenant) {
                return res.status(400).json({ error: 'Organization context required.' });
            }
            where.push(`t.tenant_id = $${idx++}`);
            params.push(req.tenant.id);
        }

        if (status && VALID_STATUSES.includes(status)) {
            where.push(`t.status = $${idx++}`);
            params.push(status);
        }
        if (ticket_type && VALID_TICKET_TYPES.includes(ticket_type)) {
            where.push(`t.ticket_type = $${idx++}`);
            params.push(ticket_type);
        }
        if (priority && VALID_PRIORITIES.includes(priority)) {
            where.push(`t.priority = $${idx++}`);
            params.push(priority);
        }

        const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

        const countRes = await masterQuery(
            `SELECT COUNT(*) as count FROM service_desk_tickets t ${whereClause}`,
            params
        );
        const total = parseInt(countRes.rows[0].count, 10);

        const ticketsRes = await masterQuery(
            `SELECT t.*, tn.org_name as tenant_name, tn.slug as tenant_slug
             FROM service_desk_tickets t
             LEFT JOIN tenants tn ON tn.id = t.tenant_id
             ${whereClause}
             ORDER BY
                CASE t.status
                    WHEN 'open' THEN 1
                    WHEN 'acknowledged' THEN 2
                    WHEN 'in_progress' THEN 3
                    WHEN 'resolved' THEN 4
                    WHEN 'closed' THEN 5
                END,
                CASE t.priority
                    WHEN 'critical' THEN 1
                    WHEN 'high' THEN 2
                    WHEN 'medium' THEN 3
                    WHEN 'low' THEN 4
                END,
                t.created_at DESC
             LIMIT $${idx++} OFFSET $${idx++}`,
            [...params, perPage, offset]
        );

        res.json({ tickets: ticketsRes.rows, total, page: pageNum, perPage });
    } catch (err) {
        logger.error({ err }, 'List service desk tickets error');
        res.status(500).json({ error: 'Failed to load tickets' });
    }
});

// GET /service-desk/tickets/:id — single ticket detail
router.get('/tickets/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const ticketRes = await masterQuery(
            `SELECT t.*, tn.org_name as tenant_name, tn.slug as tenant_slug
             FROM service_desk_tickets t
             LEFT JOIN tenants tn ON tn.id = t.tenant_id
             WHERE t.id = $1`,
            [id]
        );
        const ticket = ticketRes.rows[0];
        if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

        // Non-default tenants can only view their own tickets
        const isAdmin = await isDefaultTenant(req);
        if (!isAdmin && req.tenant && ticket.tenant_id !== req.tenant.id) {
            return res.status(403).json({ error: 'Access denied' });
        }

        res.json(ticket);
    } catch (err) {
        logger.error({ err }, 'Get service desk ticket error');
        res.status(500).json({ error: 'Failed to load ticket' });
    }
});

// POST /service-desk/tickets — submit new ticket
router.post('/tickets', async (req, res) => {
    try {
        if (!req.tenant) {
            return res.status(400).json({ error: 'Organization context required to submit a ticket.' });
        }

        const { ticket_type, title, description, priority } = req.body;

        // Validate
        if (!title || !title.trim()) {
            return res.status(400).json({ error: 'Title is required' });
        }
        if (title.trim().length > 200) {
            return res.status(400).json({ error: 'Title must be 200 characters or less' });
        }
        if (description && description.length > 5000) {
            return res.status(400).json({ error: 'Description must be 5000 characters or less' });
        }
        if (!ticket_type || !VALID_TICKET_TYPES.includes(ticket_type)) {
            return res.status(400).json({ error: `Invalid ticket type. Must be one of: ${VALID_TICKET_TYPES.join(', ')}` });
        }
        if (priority && !VALID_PRIORITIES.includes(priority)) {
            return res.status(400).json({ error: `Invalid priority. Must be one of: ${VALID_PRIORITIES.join(', ')}` });
        }

        const result = await masterQuery(
            `INSERT INTO service_desk_tickets
             (tenant_id, submitted_by_user_id, submitted_by_name, submitted_by_email, ticket_type, title, description, priority)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [
                req.tenant.id,
                req.user.id,
                req.user.full_name || req.user.username,
                req.user.email || null,
                ticket_type,
                title.trim(),
                description?.trim() || null,
                priority || 'medium',
            ]
        );

        res.status(201).json(result.rows[0]);
    } catch (err) {
        logger.error({ err }, 'Create service desk ticket error');
        res.status(500).json({ error: 'Failed to submit ticket' });
    }
});

// PATCH /service-desk/tickets/:id — update ticket (default tenant admins, or own ticket limited updates)
router.patch('/tickets/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const ticketRes = await masterQuery('SELECT * FROM service_desk_tickets WHERE id = $1', [id]);
        const ticket = ticketRes.rows[0];
        if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

        const isAdmin = await isDefaultTenant(req);
        const isOwner = req.tenant && ticket.tenant_id === req.tenant.id && ticket.submitted_by_user_id === req.user.id;

        if (!isAdmin && !isOwner) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const { status, priority, assigned_to, admin_notes, title, description } = req.body;
        const updates = [];
        const params = [];
        let idx = 1;

        // Owners can only update title, description, priority (if still open)
        if (!isAdmin) {
            if (ticket.status !== 'open') {
                return res.status(400).json({ error: 'Can only edit tickets that are still open' });
            }
            if (title !== undefined) {
                if (!title.trim() || title.trim().length > 200) {
                    return res.status(400).json({ error: 'Title must be 1-200 characters' });
                }
                updates.push(`title = $${idx++}`);
                params.push(title.trim());
            }
            if (description !== undefined) {
                if (description.length > 5000) {
                    return res.status(400).json({ error: 'Description must be 5000 characters or less' });
                }
                updates.push(`description = $${idx++}`);
                params.push(description.trim());
            }
            if (priority !== undefined) {
                if (!VALID_PRIORITIES.includes(priority)) {
                    return res.status(400).json({ error: 'Invalid priority' });
                }
                updates.push(`priority = $${idx++}`);
                params.push(priority);
            }
        } else {
            // Admins (default tenant) can update all fields
            if (status !== undefined) {
                if (!VALID_STATUSES.includes(status)) {
                    return res.status(400).json({ error: 'Invalid status' });
                }
                updates.push(`status = $${idx++}`);
                params.push(status);
                if (status === 'resolved' || status === 'closed') {
                    updates.push(`resolved_at = NOW()`);
                }
            }
            if (priority !== undefined) {
                if (!VALID_PRIORITIES.includes(priority)) {
                    return res.status(400).json({ error: 'Invalid priority' });
                }
                updates.push(`priority = $${idx++}`);
                params.push(priority);
            }
            if (assigned_to !== undefined) {
                updates.push(`assigned_to = $${idx++}`);
                params.push(assigned_to || null);
            }
            if (admin_notes !== undefined) {
                updates.push(`admin_notes = $${idx++}`);
                params.push(admin_notes);
            }
            if (title !== undefined) {
                if (!title.trim() || title.trim().length > 200) {
                    return res.status(400).json({ error: 'Title must be 1-200 characters' });
                }
                updates.push(`title = $${idx++}`);
                params.push(title.trim());
            }
            if (description !== undefined) {
                updates.push(`description = $${idx++}`);
                params.push(description?.trim() || null);
            }
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        updates.push(`updated_at = NOW()`);
        params.push(id);

        const result = await masterQuery(
            `UPDATE service_desk_tickets SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
            params
        );

        res.json(result.rows[0]);
    } catch (err) {
        logger.error({ err }, 'Update service desk ticket error');
        res.status(500).json({ error: 'Failed to update ticket' });
    }
});

// DELETE /service-desk/tickets/:id — delete (default tenant admin only)
router.delete('/tickets/:id', async (req, res) => {
    try {
        const isAdmin = await isDefaultTenant(req);
        if (!isAdmin) {
            return res.status(403).json({ error: 'Only the platform team can delete tickets' });
        }

        const { id } = req.params;
        const result = await masterQuery('DELETE FROM service_desk_tickets WHERE id = $1 RETURNING id', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Ticket not found' });
        }

        res.json({ message: 'Ticket deleted' });
    } catch (err) {
        logger.error({ err }, 'Delete service desk ticket error');
        res.status(500).json({ error: 'Failed to delete ticket' });
    }
});

// GET /service-desk/stats — ticket stats (default tenant sees all; others see own)
router.get('/stats', async (req, res) => {
    try {
        const isAdmin = await isDefaultTenant(req);
        let tenantFilter = '';
        let params = [];

        if (!isAdmin) {
            if (!req.tenant) return res.status(400).json({ error: 'Organization context required.' });
            tenantFilter = 'WHERE tenant_id = $1';
            params = [req.tenant.id];
        }

        const statsRes = await masterQuery(
            `SELECT
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE status = 'open') as open,
                COUNT(*) FILTER (WHERE status = 'acknowledged') as acknowledged,
                COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress,
                COUNT(*) FILTER (WHERE status = 'resolved') as resolved,
                COUNT(*) FILTER (WHERE status = 'closed') as closed
             FROM service_desk_tickets ${tenantFilter}`,
            params
        );

        res.json(statsRes.rows[0]);
    } catch (err) {
        logger.error({ err }, 'Service desk stats error');
        res.status(500).json({ error: 'Failed to load stats' });
    }
});

module.exports = router;
