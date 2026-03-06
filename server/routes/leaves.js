const express = require('express');
const { query, transaction } = require('../db');
const auth = require('../middleware/auth');
const { loadUserContext, requireSameOrg, requireRole } = require('../middleware/rbac');
const { findApprover } = require('../utils/approver');
const { initializeBalances, getAccruedQuota } = require('./leavePolicy');

const router = express.Router();
router.use(auth, loadUserContext);

// Helper: update leave balance (add or subtract used days)
async function updateLeaveBalance(userId, leaveType, date, duration, operation, client) {
    const q = client ? client.query.bind(client) : query;
    const year = parseInt(date.slice(0, 4));
    const durationValue = duration === 'half' ? 0.5 : duration === 'quarter' ? 0.25 : 1;
    const balRes = await q(
        'SELECT id, used FROM leave_balances WHERE user_id = $1 AND leave_type = $2 AND year = $3',
        [userId, leaveType, year]
    );
    const balance = balRes.rows[0];
    if (balance) {
        const newUsed = operation === 'add'
            ? balance.used + durationValue
            : Math.max(0, balance.used - durationValue);
        await q('UPDATE leave_balances SET used = $1 WHERE id = $2', [newUsed, balance.id]);
    }
}

// GET /leaves — list leaves (own or visible)
router.get('/', async (req, res) => {
    try {
        const { user_id, start_date, end_date, status, type } = req.query;

        const conditions = [];
        const params = [];
        let pi = 1;

        if (user_id && ['manager', 'hr_admin', 'super_admin'].includes(req.userRole)) {
            conditions.push(`l.user_id = $${pi++}`);
            params.push(parseInt(user_id, 10));
        } else {
            conditions.push(`l.user_id = $${pi++}`);
            params.push(req.userId);
        }

        if (start_date) { conditions.push(`l.date >= $${pi++}`); params.push(start_date); }
        if (end_date) { conditions.push(`l.date <= $${pi++}`); params.push(end_date); }
        if (status) { conditions.push(`l.status = $${pi++}`); params.push(status); }
        if (type) { conditions.push(`l.leave_type = $${pi++}`); params.push(type); }

        const leaves = (await query(`
            SELECT l.*, u.full_name, u.username, u.avatar
            FROM leaves l
            JOIN users u ON u.id = l.user_id
            WHERE ${conditions.join(' AND ')}
            ORDER BY l.date DESC
        `, params)).rows;

        res.json(leaves);
    } catch (err) {
        console.error('GET /leaves error:', err.message);
        res.status(500).json({ error: 'Failed to fetch leaves' });
    }
});

// GET /leaves/summary — daily summary for a date range
router.get('/summary', async (req, res) => {
    try {
        let { start_date, end_date, month, year } = req.query;

        // Support month+year shorthand
        if (!start_date && month && year) {
            const m = String(month).padStart(2, '0');
            const y = String(year);
            const lastDay = new Date(parseInt(y), parseInt(month), 0).getDate();
            start_date = `${y}-${m}-01`;
            end_date = `${y}-${m}-${String(lastDay).padStart(2, '0')}`;
        }

        if (!start_date || !end_date) return res.status(400).json({ error: 'start_date and end_date required' });

        const conditions = ['l.date >= $1 AND l.date <= $2', "l.status = 'approved'"];
        const params = [start_date, end_date];

        if (req.userRole === 'employee') {
            conditions.push('l.user_id = $3');
            params.push(req.userId);
        } else if (req.userOrgId) {
            conditions.push('u.org_id = $3');
            params.push(req.userOrgId);
        }

        const rows = (await query(`
            SELECT l.date, l.leave_type, l.duration, l.user_id,
                   u.full_name, u.username, u.avatar
            FROM leaves l
            JOIN users u ON u.id = l.user_id
            WHERE ${conditions.join(' AND ')}
            ORDER BY l.date ASC
        `, params)).rows;

        res.json(rows);
    } catch (err) {
        console.error('GET /leaves/summary error:', err.message);
        res.status(500).json({ error: 'Failed to fetch leave summary' });
    }
});

// GET /leaves/monthly-summary — monthly stats for analytics
router.get('/monthly-summary', async (req, res) => {
    try {
        const { year } = req.query;
        const targetYear = year || new Date().getFullYear().toString();

        const conditions = [
            "l.status = 'approved'",
            `l.date >= '${targetYear}-01-01' AND l.date <= '${targetYear}-12-31'`
        ];
        const params = [];
        let pi = 1;

        if (req.userRole === 'employee') {
            conditions.push(`l.user_id = $${pi++}`);
            params.push(req.userId);
        } else if (req.userOrgId) {
            conditions.push(`u.org_id = $${pi++}`);
            params.push(req.userOrgId);
        }

        const rows = (await query(`
            SELECT to_char(l.date::date, 'YYYY-MM') as month,
                   l.leave_type,
                   COUNT(*) as count,
                   SUM(CASE l.duration WHEN 'half' THEN 0.5 WHEN 'quarter' THEN 0.25 ELSE 1 END) as days
            FROM leaves l
            JOIN users u ON u.id = l.user_id
            WHERE ${conditions.join(' AND ')}
            GROUP BY to_char(l.date::date, 'YYYY-MM'), l.leave_type
            ORDER BY month ASC
        `, params)).rows;

        res.json(rows);
    } catch (err) {
        console.error('GET /leaves/monthly-summary error:', err.message);
        res.status(500).json({ error: 'Failed to fetch monthly summary' });
    }
});

// GET /leaves/balance — leave balance for a user
router.get('/balance', async (req, res) => {
    try {
        const targetUserId = req.query.user_id && ['manager', 'hr_admin', 'super_admin'].includes(req.userRole)
            ? parseInt(req.query.user_id, 10)
            : req.userId;

        const year = req.query.year ? parseInt(req.query.year, 10) : new Date().getFullYear();

        const balances = (await query(`
            SELECT lb.*, lp.name as policy_name, lp.color
            FROM leave_balances lb
            LEFT JOIN leave_policies lp ON lp.id = lb.policy_id
            WHERE lb.user_id = $1 AND lb.year = $2
            ORDER BY lb.leave_type ASC
        `, [targetUserId, year])).rows;

        res.json(balances);
    } catch (err) {
        console.error('GET /leaves/balance error:', err.message);
        res.status(500).json({ error: 'Failed to fetch leave balance' });
    }
});

// GET /leaves/pending — pending leave requests for approver
router.get('/pending', requireRole('manager'), async (req, res) => {
    try {
        const conditions = ["l.status = 'pending'"];
        const params = [];
        let pi = 1;

        if (req.userOrgId) {
            conditions.push(`u.org_id = $${pi++}`);
            params.push(req.userOrgId);
        }

        const leaves = (await query(`
            SELECT l.*, u.full_name, u.username, u.avatar, u.department_id
            FROM leaves l
            JOIN users u ON u.id = l.user_id
            WHERE ${conditions.join(' AND ')}
            ORDER BY l.created_at ASC
        `, params)).rows;

        res.json(leaves);
    } catch (err) {
        console.error('GET /leaves/pending error:', err.message);
        res.status(500).json({ error: 'Failed to fetch pending leaves' });
    }
});

// POST /leaves — apply for leave
router.post('/', async (req, res) => {
    try {
        const { leave_type, date, duration, reason, dates } = req.body;

        // Multi-day leave support
        const rawDates = Array.isArray(dates) && dates.length > 0 ? dates : (date ? [date] : null);
        if (!rawDates || rawDates.length === 0) return res.status(400).json({ error: 'Date(s) required' });
        if (!leave_type) return res.status(400).json({ error: 'Leave type required' });
        const validDurations = ['full', 'half', 'quarter'];
        const leaveDuration = validDurations.includes(duration) ? duration : 'full';
        const durationValue = leaveDuration === 'half' ? 0.5 : leaveDuration === 'quarter' ? 0.25 : 1;

        // Pre-filter: valid date format and no existing leave on that date
        const newDates = [];
        for (const d of rawDates) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
            const exists = (await query('SELECT id FROM leaves WHERE user_id = $1 AND date = $2', [req.userId, d])).rows[0];
            if (!exists) newDates.push(d);
        }
        if (newDates.length === 0) return res.json({ message: '0 leave(s) submitted', ids: [] });

        // ── Policy enforcement ────────────────────────────────────────────────
        if (req.userOrgId) {
            const policy = (await query(
                'SELECT * FROM leave_policies WHERE org_id = $1 AND leave_type = $2',
                [req.userOrgId, leave_type]
            )).rows[0];

            // If org has configured any policies, the requested type must be covered
            if (!policy) {
                const orgHasPolicy = (await query(
                    'SELECT 1 FROM leave_policies WHERE org_id = $1 LIMIT 1', [req.userOrgId]
                )).rows[0];
                if (orgHasPolicy) {
                    return res.status(400).json({ error: `'${leave_type}' leave is not allowed by your organization's policy` });
                }
            }

            if (policy) {
                // Check half / quarter-day permissions
                if (leaveDuration === 'half' && !policy.half_day_allowed) {
                    return res.status(400).json({ error: 'Half-day leave is not allowed for this leave type' });
                }
                if (leaveDuration === 'quarter' && !policy.quarter_day_allowed) {
                    return res.status(400).json({ error: 'Quarter-day leave is not allowed for this leave type' });
                }

                // Quota check grouped by year
                const datesByYear = {};
                for (const d of newDates) {
                    const yr = parseInt(d.slice(0, 4));
                    if (!datesByYear[yr]) datesByYear[yr] = [];
                    datesByYear[yr].push(d);
                }

                for (const [yr, yearDates] of Object.entries(datesByYear)) {
                    const year = parseInt(yr);
                    await initializeBalances(req.userId, req.userOrgId, year);

                    const balance = (await query(
                        'SELECT quota, used, carried_forward FROM leave_balances WHERE user_id = $1 AND leave_type = $2 AND year = $3',
                        [req.userId, leave_type, year]
                    )).rows[0];

                    // Full entitlement = accrued-so-far + carry-forward
                    const accrued = getAccruedQuota(policy, year);
                    const effectiveQuota = accrued + parseFloat(balance?.carried_forward ?? 0);
                    const alreadyUsed = parseFloat(balance?.used ?? 0);

                    // Count pending leaves for this type/year (not yet reflected in balance.used)
                    const pendingRow = (await query(
                        `SELECT COALESCE(SUM(
                            CASE duration WHEN 'half' THEN 0.5 WHEN 'quarter' THEN 0.25 ELSE 1 END
                         ), 0) AS pending_days
                         FROM leaves
                         WHERE user_id = $1 AND leave_type = $2 AND status = 'pending' AND date LIKE $3`,
                        [req.userId, leave_type, `${year}-%`]
                    )).rows[0];
                    const pendingDays = parseFloat(pendingRow.pending_days);

                    const requested = yearDates.length * durationValue;
                    const available = effectiveQuota - alreadyUsed - pendingDays;

                    if (requested > available) {
                        return res.status(400).json({
                            error: `Insufficient ${leave_type} leave balance for ${year}. ` +
                                `Available: ${Math.max(0, available)} day(s), Requested: ${requested}`,
                        });
                    }
                }
            }
        }
        // ─────────────────────────────────────────────────────────────────────

        const approver = req.userOrgId ? (await findApprover(req.userId, req.userOrgId)) : null;
        const created = [];

        for (const d of newDates) {
            const leaveResult = await query(
                `INSERT INTO leaves (user_id, leave_type, date, duration, reason, status, approved_by)
                 VALUES ($1, $2, $3, $4, $5, 'pending', $6)
                 RETURNING id`,
                [req.userId, leave_type, d, leaveDuration, reason || null, approver?.id || null]
            );
            const newLeave = leaveResult.rows[0];
            if (!newLeave) continue;
            created.push(newLeave.id);

            // Notify manager via approval queue
            await query(
                `INSERT INTO approval_requests (org_id, requester_id, approver_id, type, reference_id, reason, metadata)
                 VALUES ($1, $2, $3, 'leave', $4, $5, $6)`,
                [
                    req.userOrgId || null,
                    req.userId,
                    approver?.id || null,
                    newLeave.id,
                    reason || null,
                    JSON.stringify({ leave_type, date: d, duration: leaveDuration }),
                ]
            );
        }

        res.json({ message: `${created.length} leave(s) submitted`, ids: created });
    } catch (err) {
        console.error('POST /leaves error:', err.message);
        res.status(500).json({ error: 'Failed to submit leave' });
    }
});

// PATCH /leaves/:id/approve — approve leave
router.patch('/:id/approve', requireRole('manager'), async (req, res) => {
    try {
        const leave = (await query('SELECT * FROM leaves WHERE id = $1', [req.params.id])).rows[0];
        if (!leave) return res.status(404).json({ error: 'Leave not found' });
        if (leave.status !== 'pending') return res.status(400).json({ error: 'Leave is not pending' });

        await transaction(async (client) => {
            await client.query(
                "UPDATE leaves SET status = 'approved', approved_by = $1, reviewed_at = NOW() WHERE id = $2",
                [req.userId, leave.id]
            );
            await client.query(
                "UPDATE approval_requests SET status = 'approved', approver_id = $1, reviewed_at = NOW() WHERE type = 'leave' AND reference_id = $2 AND status = 'pending'",
                [req.userId, leave.id]
            );
            await updateLeaveBalance(leave.user_id, leave.leave_type, leave.date, leave.duration || 'full', 'add', client);
        });

        res.json({ message: 'Leave approved' });
    } catch (err) {
        console.error('PATCH /leaves/:id/approve error:', err.message);
        res.status(500).json({ error: 'Failed to approve leave' });
    }
});

// PATCH /leaves/:id/reject — reject leave
router.patch('/:id/reject', requireRole('manager'), async (req, res) => {
    try {
        const { reason } = req.body;
        const leave = (await query('SELECT * FROM leaves WHERE id = $1', [req.params.id])).rows[0];
        if (!leave) return res.status(404).json({ error: 'Leave not found' });
        if (leave.status !== 'pending') return res.status(400).json({ error: 'Leave is not pending' });

        await transaction(async (client) => {
            await client.query(
                "UPDATE leaves SET status = 'rejected', reject_reason = $1, approved_by = $2, reviewed_at = NOW() WHERE id = $3",
                [reason || null, req.userId, leave.id]
            );
            await client.query(
                "UPDATE approval_requests SET status = 'rejected', approver_id = $1, reviewed_at = NOW(), reject_reason = $2 WHERE type = 'leave' AND reference_id = $3 AND status = 'pending'",
                [req.userId, reason || null, leave.id]
            );
        });

        res.json({ message: 'Leave rejected' });
    } catch (err) {
        console.error('PATCH /leaves/:id/reject error:', err.message);
        res.status(500).json({ error: 'Failed to reject leave' });
    }
});

// DELETE /leaves/:id — cancel pending leave (own only)
router.delete('/:id', async (req, res) => {
    try {
        const leave = (await query('SELECT * FROM leaves WHERE id = $1 AND user_id = $2', [req.params.id, req.userId])).rows[0];
        if (!leave) return res.status(404).json({ error: 'Leave not found' });
        if (leave.status === 'approved') return res.status(400).json({ error: 'Cannot cancel an approved leave. Ask your manager to revoke it.' });

        await query('DELETE FROM leaves WHERE id = $1', [leave.id]);
        res.json({ message: 'Leave cancelled' });
    } catch (err) {
        console.error('DELETE /leaves/:id error:', err.message);
        res.status(500).json({ error: 'Failed to cancel leave' });
    }
});

// POST /leaves/:id/withdraw — employee withdraws pending or approved leave
router.post('/:id/withdraw', async (req, res) => {
    try {
        const leave = (await query('SELECT * FROM leaves WHERE id = $1 AND user_id = $2', [req.params.id, req.userId])).rows[0];
        if (!leave) return res.status(404).json({ error: 'Leave not found' });
        if (!['pending', 'approved'].includes(leave.status)) {
            return res.status(400).json({ error: 'Leave cannot be withdrawn in its current status' });
        }

        if (leave.status === 'pending') {
            // Cancel any open approval request for this leave too
            await query("UPDATE approval_requests SET status = 'rejected' WHERE type = 'leave' AND reference_id = $1 AND status = 'pending'", [leave.id]);
            await query('DELETE FROM leaves WHERE id = $1', [leave.id]);
            res.json({ message: 'Leave cancelled' });
        } else {
            // approved → request withdrawal, manager must approve to deduct balance
            const approver = req.userOrgId ? (await findApprover(req.userId, req.userOrgId)) : null;
            await query("UPDATE leaves SET status = 'withdraw_pending' WHERE id = $1", [leave.id]);
            await query(
                `INSERT INTO approval_requests (org_id, requester_id, approver_id, type, reference_id, reason, metadata)
                 VALUES ($1, $2, $3, 'leave_withdraw', $4, $5, $6)`,
                [
                    req.userOrgId || null,
                    req.userId,
                    approver?.id || null,
                    leave.id,
                    null,
                    JSON.stringify({ leave_type: leave.leave_type, date: leave.date, duration: leave.duration }),
                ]
            );
            res.json({ message: 'Withdrawal request submitted' });
        }
    } catch (err) {
        console.error('POST /leaves/:id/withdraw error:', err.message);
        res.status(500).json({ error: 'Failed to withdraw leave' });
    }
});

// PATCH /leaves/:id/revoke — revoke approved leave (manager+)
router.patch('/:id/revoke', requireRole('manager'), async (req, res) => {
    try {
        const leave = (await query('SELECT * FROM leaves WHERE id = $1', [req.params.id])).rows[0];
        if (!leave) return res.status(404).json({ error: 'Leave not found' });
        if (leave.status !== 'approved') return res.status(400).json({ error: 'Leave is not approved' });

        await transaction(async (client) => {
            await client.query(
                "UPDATE leaves SET status = 'revoked', approved_by = $1, reviewed_at = NOW() WHERE id = $2",
                [req.userId, leave.id]
            );
            await updateLeaveBalance(leave.user_id, leave.leave_type, leave.date, leave.duration || 'full', 'subtract', client);
        });

        res.json({ message: 'Leave revoked' });
    } catch (err) {
        console.error('PATCH /leaves/:id/revoke error:', err.message);
        res.status(500).json({ error: 'Failed to revoke leave' });
    }
});

module.exports = router;
module.exports.updateLeaveBalance = updateLeaveBalance;