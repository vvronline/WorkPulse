/**
 * Leave Policy routes — leave quotas, balances, holidays, accrual.
 */
const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const { loadUserContext, requireRole, requireSameOrg } = require('../middleware/rbac');
const { logAction } = require('../utils/audit');

const router = express.Router();

router.use(auth, loadUserContext);

// ==================== LEAVE POLICIES (HR Admin+) ====================

// Get all leave policies for the org
router.get('/policies', requireSameOrg, (req, res) => {
    const policies = db.prepare('SELECT * FROM leave_policies WHERE org_id = ? ORDER BY leave_type')
        .all(req.userOrgId);
    res.json(policies);
});

// Create/update a leave policy
router.post('/policies', requireRole('hr_admin'), requireSameOrg, (req, res) => {
    const { leave_type, annual_quota, accrual_type, carry_forward_limit, half_day_allowed, quarter_day_allowed } = req.body;

    if (!leave_type) return res.status(400).json({ error: 'Leave type is required' });

    const existing = db.prepare('SELECT id FROM leave_policies WHERE org_id = ? AND leave_type = ?')
        .get(req.userOrgId, leave_type);

    if (existing) {
        db.prepare(`
            UPDATE leave_policies SET
                annual_quota = ?, accrual_type = ?, carry_forward_limit = ?,
                half_day_allowed = ?, quarter_day_allowed = ?
            WHERE id = ?
        `).run(
            annual_quota || 0, accrual_type || 'annual', carry_forward_limit || 0,
            half_day_allowed ? 1 : 0, quarter_day_allowed ? 1 : 0,
            existing.id
        );
        logAction(req, 'update', 'leave_policy', existing.id, { leave_type });
        res.json({ message: `Leave policy for ${leave_type} updated` });
    } else {
        const result = db.prepare(`
            INSERT INTO leave_policies (org_id, leave_type, annual_quota, accrual_type, carry_forward_limit, half_day_allowed, quarter_day_allowed)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(req.userOrgId, leave_type, annual_quota || 0, accrual_type || 'annual', carry_forward_limit || 0, half_day_allowed ? 1 : 0, quarter_day_allowed ? 1 : 0);
        logAction(req, 'create', 'leave_policy', result.lastInsertRowid, { leave_type, annual_quota });
        res.json({ id: result.lastInsertRowid, message: `Leave policy for ${leave_type} created` });
    }
});

// Delete a leave policy
router.delete('/policies/:id', requireRole('hr_admin'), requireSameOrg, (req, res) => {
    const { id } = req.params;
    const policy = db.prepare('SELECT * FROM leave_policies WHERE id = ? AND org_id = ?').get(Number(id), req.userOrgId);
    if (!policy) return res.status(404).json({ error: 'Policy not found' });

    db.prepare('DELETE FROM leave_policies WHERE id = ?').run(Number(id));
    logAction(req, 'delete', 'leave_policy', Number(id), { leave_type: policy.leave_type });
    res.json({ message: 'Policy deleted' });
});

// ==================== LEAVE BALANCES ====================

// Get current user's balances
router.get('/balances', (req, res) => {
    const year = parseInt(req.query.year) || new Date().getFullYear();

    // If org has policies, check for initialized balances
    if (req.userOrgId) {
        initializeBalances(req.userId, req.userOrgId, year);
    }

    const balances = db.prepare(
        'SELECT * FROM leave_balances WHERE user_id = ? AND year = ?'
    ).all(req.userId, year);

    res.json(balances);
});

// Get a specific user's balances (team_lead+)
router.get('/balances/:userId', requireRole('team_lead'), requireSameOrg, (req, res) => {
    const targetUserId = Number(req.params.userId);
    const year = parseInt(req.query.year) || new Date().getFullYear();

    initializeBalances(targetUserId, req.userOrgId, year);

    const balances = db.prepare(
        'SELECT * FROM leave_balances WHERE user_id = ? AND year = ?'
    ).all(targetUserId, year);

    res.json(balances);
});

// Adjust a user's balance (hr_admin+)
router.put('/balances/:userId', requireRole('hr_admin'), requireSameOrg, (req, res) => {
    const targetUserId = Number(req.params.userId);
    const { leave_type, year, quota, carried_forward } = req.body;

    if (!leave_type || !year) return res.status(400).json({ error: 'Leave type and year are required' });

    const existing = db.prepare(
        'SELECT id FROM leave_balances WHERE user_id = ? AND leave_type = ? AND year = ?'
    ).get(targetUserId, leave_type, year);

    if (existing) {
        const updates = [];
        const params = [];
        if (quota !== undefined) { updates.push('quota = ?'); params.push(quota); }
        if (carried_forward !== undefined) { updates.push('carried_forward = ?'); params.push(carried_forward); }
        params.push(existing.id);
        db.prepare(`UPDATE leave_balances SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    } else {
        db.prepare(
            'INSERT INTO leave_balances (user_id, leave_type, year, quota, carried_forward) VALUES (?, ?, ?, ?, ?)'
        ).run(targetUserId, leave_type, year, quota || 0, carried_forward || 0);
    }

    logAction(req, 'update_balance', 'leave_balance', targetUserId, { leave_type, year, quota, carried_forward });
    res.json({ message: 'Balance updated' });
});

// ==================== COMPANY HOLIDAYS ====================

// Get holidays for the org
router.get('/holidays', requireSameOrg, (req, res) => {
    const { year } = req.query;
    const y = parseInt(year) || new Date().getFullYear();

    const holidays = db.prepare(`
        SELECT * FROM holidays
        WHERE org_id = ? AND date LIKE ?
        ORDER BY date ASC
    `).all(req.userOrgId, `${y}-%`);

    res.json(holidays);
});

// Add a holiday (hr_admin+)
router.post('/holidays', requireRole('hr_admin'), requireSameOrg, (req, res) => {
    const { date, name, is_optional } = req.body;
    if (!date || !name) return res.status(400).json({ error: 'Date and name are required' });

    try {
        const result = db.prepare(
            'INSERT INTO holidays (org_id, date, name, is_optional) VALUES (?, ?, ?, ?)'
        ).run(req.userOrgId, date, name.trim(), is_optional ? 1 : 0);

        logAction(req, 'create', 'holiday', result.lastInsertRowid, { date, name: name.trim() });
        res.json({ id: result.lastInsertRowid, message: 'Holiday added' });
    } catch (e) {
        if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Holiday already exists on this date' });
        throw e;
    }
});

// Add multiple holidays (batch)
router.post('/holidays/batch', requireRole('hr_admin'), requireSameOrg, (req, res) => {
    const { holidays } = req.body;
    if (!holidays || !Array.isArray(holidays)) return res.status(400).json({ error: 'Holidays array is required' });

    const insert = db.prepare('INSERT OR IGNORE INTO holidays (org_id, date, name, is_optional) VALUES (?, ?, ?, ?)');
    const tx = db.transaction(() => {
        let added = 0;
        for (const h of holidays) {
            if (h.date && h.name) {
                const r = insert.run(req.userOrgId, h.date, h.name.trim(), h.is_optional ? 1 : 0);
                if (r.changes > 0) added++;
            }
        }
        return added;
    });

    const added = tx();
    logAction(req, 'batch_create', 'holiday', null, { count: added });
    res.json({ message: `${added} holiday(s) added` });
});

// Delete a holiday
router.delete('/holidays/:id', requireRole('hr_admin'), requireSameOrg, (req, res) => {
    const { id } = req.params;
    const holiday = db.prepare('SELECT * FROM holidays WHERE id = ? AND org_id = ?').get(Number(id), req.userOrgId);
    if (!holiday) return res.status(404).json({ error: 'Holiday not found' });

    db.prepare('DELETE FROM holidays WHERE id = ?').run(Number(id));
    logAction(req, 'delete', 'holiday', Number(id), { name: holiday.name, date: holiday.date });
    res.json({ message: 'Holiday deleted' });
});

// ==================== HELPERS ====================

/**
 * Initialize leave balances for a user for a given year based on org policies.
 */
function initializeBalances(userId, orgId, year) {
    if (!orgId) return;

    const policies = db.prepare('SELECT * FROM leave_policies WHERE org_id = ?').all(orgId);

    const insertOrIgnore = db.prepare(`
        INSERT OR IGNORE INTO leave_balances (user_id, leave_type, year, quota, carried_forward)
        VALUES (?, ?, ?, ?, ?)
    `);

    for (const policy of policies) {
        // Check carry-forward from previous year
        let carryForward = 0;
        if (policy.carry_forward_limit > 0) {
            const prevBalance = db.prepare(
                'SELECT quota, used, carried_forward FROM leave_balances WHERE user_id = ? AND leave_type = ? AND year = ?'
            ).get(userId, policy.leave_type, year - 1);

            if (prevBalance) {
                const remaining = (prevBalance.quota + prevBalance.carried_forward) - prevBalance.used;
                carryForward = Math.min(Math.max(remaining, 0), policy.carry_forward_limit);
            }
        }

        insertOrIgnore.run(userId, policy.leave_type, year, policy.annual_quota, carryForward);
    }
}

/**
 * Get accrued quota for current period.
 */
function getAccruedQuota(policy, year) {
    const now = new Date();
    const currentYear = now.getFullYear();
    if (year !== currentYear) return policy.annual_quota; // full quota for past/future years

    switch (policy.accrual_type) {
        case 'monthly': {
            const month = now.getMonth() + 1;
            return Math.round((policy.annual_quota / 12) * month * 100) / 100;
        }
        case 'quarterly': {
            const quarter = Math.ceil((now.getMonth() + 1) / 3);
            return Math.round((policy.annual_quota / 4) * quarter * 100) / 100;
        }
        default: // annual
            return policy.annual_quota;
    }
}

module.exports = router;
