const express = require('express');
const { query, transaction } = require('../db');
const auth = require('../middleware/auth');
const { loadUserContext, requireRole, requireSameOrg } = require('../middleware/rbac');
const { logAction } = require('../utils/audit');
const { logger } = require('../utils/logger');

const router = express.Router();
router.use(auth, loadUserContext);

// ==================== LEAVE POLICIES (HR Admin+) ====================

router.get('/policies', requireSameOrg, async (req, res) => {
    try {
        const policies = (await query('SELECT * FROM leave_policies WHERE org_id = $1 ORDER BY leave_type', [req.userOrgId])).rows;
        res.json(policies);
    } catch (err) {
        req.log.error({ err }, 'GET /policies error');
        res.status(500).json({ error: 'Failed to fetch policies' });
    }
});

router.post('/policies', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const { leave_type, annual_quota, accrual_type, carry_forward_limit, half_day_allowed, quarter_day_allowed } = req.body;
        if (!leave_type) return res.status(400).json({ error: 'Leave type is required' });

        const quota = Number(annual_quota) || 0;
        const cfLimit = Number(carry_forward_limit) || 0;
        if (quota < 0 || quota > 365) return res.status(400).json({ error: 'Annual quota must be between 0 and 365' });
        if (cfLimit < 0 || cfLimit > 365) return res.status(400).json({ error: 'Carry forward limit must be between 0 and 365' });

        const existing = (await query('SELECT id FROM leave_policies WHERE org_id = $1 AND leave_type = $2', [req.userOrgId, leave_type])).rows[0];

        if (existing) {
            await query(
                `UPDATE leave_policies SET annual_quota = $1, accrual_type = $2, carry_forward_limit = $3,
                 half_day_allowed = $4, quarter_day_allowed = $5 WHERE id = $6`,
                [quota, accrual_type || 'annual', cfLimit, !!half_day_allowed, !!quarter_day_allowed, existing.id]
            );
            logAction(req, 'update', 'leave_policy', existing.id, { leave_type });
            res.json({ message: `Leave policy for ${leave_type} updated` });
        } else {
            const result = await query(
                `INSERT INTO leave_policies (org_id, leave_type, annual_quota, accrual_type, carry_forward_limit, half_day_allowed, quarter_day_allowed)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
                [req.userOrgId, leave_type, quota, accrual_type || 'annual', cfLimit, !!half_day_allowed, !!quarter_day_allowed]
            );
            logAction(req, 'create', 'leave_policy', result.rows[0].id, { leave_type, annual_quota: quota });
            res.json({ id: result.rows[0].id, message: `Leave policy for ${leave_type} created` });
        }
    } catch (err) {
        req.log.error({ err }, 'POST /policies error');
        res.status(500).json({ error: 'Failed to save policy' });
    }
});

router.delete('/policies/:id', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const { id } = req.params;
        const policy = (await query('SELECT * FROM leave_policies WHERE id = $1 AND org_id = $2', [Number(id), req.userOrgId])).rows[0];
        if (!policy) return res.status(404).json({ error: 'Policy not found' });

        await query('DELETE FROM leave_policies WHERE id = $1', [Number(id)]);
        logAction(req, 'delete', 'leave_policy', Number(id), { leave_type: policy.leave_type });
        res.json({ message: 'Policy deleted' });
    } catch (err) {
        req.log.error({ err }, 'DELETE /policies/:id error');
        res.status(500).json({ error: 'Failed to delete policy' });
    }
});

// ==================== LEAVE BALANCES ====================

router.get('/balances', async (req, res) => {
    try {
        const year = parseInt(req.query.year) || new Date().getFullYear();
        if (req.userOrgId) await initializeBalances(req.userId, req.userOrgId, year);

        const balances = (await query(
            'SELECT * FROM leave_balances WHERE user_id = $1 AND year = $2',
            [req.userId, year]
        )).rows;
        res.json(balances);
    } catch (err) {
        req.log.error({ err }, 'GET /balances error');
        res.status(500).json({ error: 'Failed to fetch balances' });
    }
});

router.get('/balances/:userId', requireRole('team_lead'), requireSameOrg, async (req, res) => {
    try {
        const targetUserId = Number(req.params.userId);
        const year = parseInt(req.query.year) || new Date().getFullYear();

        const targetUser = (await query('SELECT org_id FROM users WHERE id = $1', [targetUserId])).rows[0];
        if (!targetUser || targetUser.org_id !== req.userOrgId) {
            return res.status(403).json({ error: 'Cannot view balances for users outside your organization' });
        }

        await initializeBalances(targetUserId, req.userOrgId, year);

        const balances = (await query(
            'SELECT * FROM leave_balances WHERE user_id = $1 AND year = $2',
            [targetUserId, year]
        )).rows;
        res.json(balances);
    } catch (err) {
        req.log.error({ err }, 'GET /balances/:userId error');
        res.status(500).json({ error: 'Failed to fetch balances' });
    }
});

router.put('/balances/:userId', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const targetUserId = Number(req.params.userId);
        const { leave_type, year, quota, carried_forward } = req.body;

        if (!leave_type || !year) return res.status(400).json({ error: 'Leave type and year are required' });

        const targetUser = (await query('SELECT org_id FROM users WHERE id = $1', [targetUserId])).rows[0];
        if (!targetUser || targetUser.org_id !== req.userOrgId) {
            return res.status(403).json({ error: 'Cannot modify balances for users outside your organization' });
        }

        const existing = (await query(
            'SELECT id FROM leave_balances WHERE user_id = $1 AND leave_type = $2 AND year = $3',
            [targetUserId, leave_type, year]
        )).rows[0];

        if (existing) {
            const updates = [];
            const params = [];
            let pi = 1;
            if (quota !== undefined) { updates.push(`quota = $${pi++}`); params.push(quota); }
            if (carried_forward !== undefined) { updates.push(`carried_forward = $${pi++}`); params.push(carried_forward); }
            if (updates.length === 0) return res.status(400).json({ error: 'No fields to update. Provide quota or carried_forward.' });
            params.push(existing.id);
            await query(`UPDATE leave_balances SET ${updates.join(', ')} WHERE id = $${pi}`, params);
        } else {
            await query(
                'INSERT INTO leave_balances (user_id, leave_type, year, quota, carried_forward) VALUES ($1, $2, $3, $4, $5)',
                [targetUserId, leave_type, year, quota || 0, carried_forward || 0]
            );
        }

        logAction(req, 'update_balance', 'leave_balance', targetUserId, { leave_type, year, quota, carried_forward });
        res.json({ message: 'Balance updated' });
    } catch (err) {
        req.log.error({ err }, 'PUT /balances/:userId error');
        res.status(500).json({ error: 'Failed to update balance' });
    }
});

// ==================== COMPANY HOLIDAYS ====================

router.get('/holidays', requireSameOrg, async (req, res) => {
    try {
        const y = parseInt(req.query.year) || new Date().getFullYear();
        const holidays = (await query(
            `SELECT * FROM holidays WHERE org_id = $1 AND date LIKE $2 ORDER BY date ASC`,
            [req.userOrgId, `${y}-%`]
        )).rows;
        res.json(holidays);
    } catch (err) {
        req.log.error({ err }, 'GET /holidays error');
        res.status(500).json({ error: 'Failed to fetch holidays' });
    }
});

router.post('/holidays', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const { date, name, is_optional } = req.body;
        if (!date || !name) return res.status(400).json({ error: 'Date and name are required' });

        const result = await query(
            'INSERT INTO holidays (org_id, date, name, is_optional) VALUES ($1, $2, $3, $4) RETURNING id',
            [req.userOrgId, date, name.trim(), !!is_optional]
        );
        logAction(req, 'create', 'holiday', result.rows[0].id, { date, name: name.trim() });
        res.json({ id: result.rows[0].id, message: 'Holiday added' });
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ error: 'Holiday already exists on this date' });
        req.log.error({ err }, 'POST /holidays error');
        res.status(500).json({ error: 'Failed to add holiday' });
    }
});

router.post('/holidays/batch', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const { holidays } = req.body;
        if (!holidays || !Array.isArray(holidays)) return res.status(400).json({ error: 'Holidays array is required' });

        const added = await transaction(async (client) => {
            let count = 0;
            for (const h of holidays) {
                if (h.date && h.name) {
                    const r = await client.query(
                        'INSERT INTO holidays (org_id, date, name, is_optional) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
                        [req.userOrgId, h.date, h.name.trim(), !!h.is_optional]
                    );
                    if (r.rowCount > 0) count++;
                }
            }
            return count;
        });

        logAction(req, 'batch_create', 'holiday', null, { count: added });
        res.json({ message: `${added} holiday(s) added` });
    } catch (err) {
        req.log.error({ err }, 'POST /holidays/batch error');
        res.status(500).json({ error: 'Failed to add holidays' });
    }
});

router.delete('/holidays/:id', requireRole('hr_admin'), requireSameOrg, async (req, res) => {
    try {
        const { id } = req.params;
        const holiday = (await query('SELECT * FROM holidays WHERE id = $1 AND org_id = $2', [Number(id), req.userOrgId])).rows[0];
        if (!holiday) return res.status(404).json({ error: 'Holiday not found' });

        await query('DELETE FROM holidays WHERE id = $1', [Number(id)]);
        logAction(req, 'delete', 'holiday', Number(id), { name: holiday.name, date: holiday.date });
        res.json({ message: 'Holiday deleted' });
    } catch (err) {
        req.log.error({ err }, 'DELETE /holidays/:id error');
        res.status(500).json({ error: 'Failed to delete holiday' });
    }
});

// ==================== HELPERS ====================

async function initializeBalances(userId, orgId, year) {
    if (!orgId) return;
    const policies = (await query('SELECT * FROM leave_policies WHERE org_id = $1', [orgId])).rows;

    for (const policy of policies) {
        let carryForward = 0;
        if (policy.carry_forward_limit > 0) {
            const prevBalance = (await query(
                'SELECT quota, used, carried_forward FROM leave_balances WHERE user_id = $1 AND leave_type = $2 AND year = $3',
                [userId, policy.leave_type, year - 1]
            )).rows[0];
            if (prevBalance) {
                const remaining = (prevBalance.quota + prevBalance.carried_forward) - prevBalance.used;
                carryForward = Math.min(Math.max(remaining, 0), policy.carry_forward_limit);
            }
        }
        await query(
            `INSERT INTO leave_balances (user_id, leave_type, year, quota, carried_forward)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, leave_type, year) DO NOTHING`,
            [userId, policy.leave_type, year, policy.annual_quota, carryForward]
        );
    }
}

function getAccruedQuota(policy, year, fiscalYearStart) {
    const fys = fiscalYearStart || 1; // default January
    const now = new Date();
    const currentYear = now.getFullYear();
    if (year !== currentYear) return policy.annual_quota;
    switch (policy.accrual_type) {
        case 'monthly': {
            // Months elapsed since fiscal year start
            const currentMonth = now.getMonth() + 1;
            const monthsElapsed = currentMonth >= fys
                ? currentMonth - fys + 1
                : 12 - fys + currentMonth + 1;
            return Math.round((policy.annual_quota / 12) * monthsElapsed * 100) / 100;
        }
        case 'quarterly': {
            const currentMonth = now.getMonth() + 1;
            const monthsElapsed = currentMonth >= fys
                ? currentMonth - fys + 1
                : 12 - fys + currentMonth + 1;
            const quarter = Math.ceil(monthsElapsed / 3);
            return Math.round((policy.annual_quota / 4) * quarter * 100) / 100;
        }
        default:
            return policy.annual_quota;
    }
}

module.exports = router;
module.exports.initializeBalances = initializeBalances;
module.exports.getAccruedQuota = getAccruedQuota;