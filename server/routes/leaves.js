const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const { loadUserContext, ROLE_LEVEL } = require('../middleware/rbac');
const { logAction } = require('../utils/audit');
const { getLocalToday } = require('../utils/timezone');
const { findApprover } = require('../utils/approver');

const router = express.Router();

// Get leaves for a date range
router.get('/', auth, loadUserContext, (req, res) => {
    const { from, to } = req.query;
    const fromDate = from || new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const toDate = to || getLocalToday(req);

    const leaves = db.prepare(`
        SELECT l.*, u.full_name as approved_by_name
        FROM leaves l
        LEFT JOIN users u ON u.id = l.approved_by
        WHERE l.user_id = ? AND l.date BETWEEN ? AND ?
        ORDER BY l.date DESC
    `).all(req.userId, fromDate, toDate);

    res.json(leaves);
});

// Add a leave (with approval workflow if org exists)
router.post('/', auth, loadUserContext, (req, res) => {
    const { date, leave_type, reason, duration } = req.body;

    if (!date || !leave_type) {
        return res.status(400).json({ error: 'Date and leave type are required' });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
    }

    const validTypes = ['sick', 'holiday', 'planned', 'personal', 'other'];
    if (!validTypes.includes(leave_type)) {
        return res.status(400).json({ error: 'Invalid leave type' });
    }

    const validDurations = ['full', 'half', 'quarter'];
    const leaveDuration = validDurations.includes(duration) ? duration : 'full';

    // Check for duplicate
    const existing = db.prepare('SELECT id FROM leaves WHERE user_id = ? AND date = ?').get(req.userId, date);
    if (existing) {
        return res.status(400).json({ error: 'Leave already exists for this date' });
    }

    // Check balance if user belongs to an org with policies
    if (req.userOrgId) {
        const policy = db.prepare('SELECT * FROM leave_policies WHERE org_id = ? AND leave_type = ?')
            .get(req.userOrgId, leave_type);

        if (policy) {
            // Validate duration against policy
            if (leaveDuration === 'half' && !policy.half_day_allowed) {
                return res.status(400).json({ error: 'Half-day leave is not allowed for this leave type' });
            }
            if (leaveDuration === 'quarter' && !policy.quarter_day_allowed) {
                return res.status(400).json({ error: 'Quarter-day leave is not allowed for this leave type' });
            }

            const year = parseInt(date.slice(0, 4));
            const balance = db.prepare(
                'SELECT * FROM leave_balances WHERE user_id = ? AND leave_type = ? AND year = ?'
            ).get(req.userId, leave_type, year);

            if (balance) {
                const durationValue = leaveDuration === 'half' ? 0.5 : leaveDuration === 'quarter' ? 0.25 : 1;
                const available = (balance.quota + balance.carried_forward) - balance.used;
                if (durationValue > available) {
                    return res.status(400).json({ error: `Insufficient ${leave_type} leave balance. Available: ${available} days` });
                }
            }
        }
    }

    // Determine approval status
    let leaveStatus = 'approved';
    let needsApproval = false;

    // Needs approval if: user has a manager assigned, OR is in an org with role < hr_admin
    const hasManager = req.userManagerId != null;
    const isOrgSubordinate = req.userOrgId && (ROLE_LEVEL[req.userRole] || 1) < ROLE_LEVEL.hr_admin;
    if (hasManager || isOrgSubordinate) {
        leaveStatus = 'pending';
        needsApproval = true;
    }

    const result = db.prepare(
        'INSERT INTO leaves (user_id, date, leave_type, reason, duration, status) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(req.userId, date, leave_type, reason || null, leaveDuration, leaveStatus);

    // Create approval request if needed
    if (needsApproval) {
        const approver = findApprover(req.userId, req.userOrgId);

        db.prepare(`
            INSERT INTO approval_requests (org_id, requester_id, approver_id, type, reference_id, reason, metadata)
            VALUES (?, ?, ?, 'leave', ?, ?, ?)
        `).run(
            req.userOrgId || null, req.userId, approver?.id || null,
            result.lastInsertRowid, reason || null,
            JSON.stringify({ date, leave_type, duration: leaveDuration })
        );
    }

    // Update balance only if auto-approved
    if (leaveStatus === 'approved' && req.userOrgId) {
        updateLeaveBalance(req.userId, leave_type, date, leaveDuration, 'add');
    }

    logAction(req, 'create', 'leave', result.lastInsertRowid, { date, leave_type, duration: leaveDuration, status: leaveStatus });

    res.json({
        id: result.lastInsertRowid,
        status: leaveStatus,
        message: needsApproval ? 'Leave request submitted for approval' : 'Leave added successfully'
    });
});

// Add multiple leaves (batch)
router.post('/batch', auth, loadUserContext, (req, res) => {
    const { dates, leave_type, reason, duration } = req.body;

    if (!dates || !Array.isArray(dates) || dates.length === 0 || !leave_type) {
        return res.status(400).json({ error: 'Dates array and leave type are required' });
    }

    const validTypes = ['sick', 'holiday', 'planned', 'personal', 'other'];
    if (!validTypes.includes(leave_type)) {
        return res.status(400).json({ error: 'Invalid leave type' });
    }

    const leaveDuration = ['full', 'half', 'quarter'].includes(duration) ? duration : 'full';
    let leaveStatus = 'approved';
    let needsApproval = false;

    const hasManager = req.userManagerId != null;
    const isOrgSubordinate = req.userOrgId && (ROLE_LEVEL[req.userRole] || 1) < ROLE_LEVEL.hr_admin;
    if (hasManager || isOrgSubordinate) {
        leaveStatus = 'pending';
        needsApproval = true;
    }

    const insert = db.prepare('INSERT OR IGNORE INTO leaves (user_id, date, leave_type, reason, duration, status) VALUES (?, ?, ?, ?, ?, ?)');
    const transaction = db.transaction(() => {
        let added = 0;
        const approver = needsApproval ? findApprover(req.userId, req.userOrgId) : null;

        for (const date of dates) {
            if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                const r = insert.run(req.userId, date, leave_type, reason || null, leaveDuration, leaveStatus);
                if (r.changes > 0) {
                    added++;
                    if (needsApproval) {
                        db.prepare(`
                            INSERT INTO approval_requests (org_id, requester_id, approver_id, type, reference_id, reason, metadata)
                            VALUES (?, ?, ?, 'leave', ?, ?, ?)
                        `).run(
                            req.userOrgId || null, req.userId, approver?.id || null,
                            r.lastInsertRowid, reason || null,
                            JSON.stringify({ date, leave_type, duration: leaveDuration })
                        );
                    }
                    if (leaveStatus === 'approved' && req.userOrgId) {
                        updateLeaveBalance(req.userId, leave_type, date, leaveDuration, 'add');
                    }
                }
            }
        }
        return added;
    });

    try {
        const added = transaction();
        logAction(req, 'batch_create', 'leave', null, { count: added, leave_type });
        res.json({
            message: needsApproval ? `${added} leave request(s) submitted for approval` : `${added} leave(s) added successfully`,
            status: leaveStatus
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to add leaves' });
    }
});

// Delete a leave
router.delete('/:id', auth, loadUserContext, (req, res) => {
    const { id } = req.params;
    const leave = db.prepare('SELECT * FROM leaves WHERE id = ? AND user_id = ?').get(id, req.userId);

    if (!leave) {
        return res.status(404).json({ error: 'Leave not found' });
    }

    // If it was approved, restore balance
    if (leave.status === 'approved' && req.userOrgId) {
        updateLeaveBalance(req.userId, leave.leave_type, leave.date, leave.duration || 'full', 'subtract');
    }

    // Delete related approval request
    db.prepare("DELETE FROM approval_requests WHERE type = 'leave' AND reference_id = ? AND requester_id = ?")
        .run(Number(id), req.userId);

    db.prepare('DELETE FROM leaves WHERE id = ?').run(id);
    logAction(req, 'delete', 'leave', Number(id), { date: leave.date, leave_type: leave.leave_type });
    res.json({ message: 'Leave deleted successfully' });
});

// Get monthly leave summary
router.get('/summary', auth, (req, res) => {
    const { month, year } = req.query;
    const y = parseInt(year) || new Date().getFullYear();
    const m = parseInt(month) || new Date().getMonth() + 1;
    const mStr = String(m).padStart(2, '0');

    const leaves = db.prepare(`
        SELECT leave_type, COUNT(*) as count FROM leaves
        WHERE user_id = ? AND strftime('%Y-%m', date) = ?
        GROUP BY leave_type
    `).all(req.userId, `${y}-${mStr}`);

    // Count weekend days (Sat + Sun) in this month up to today (using client timezone)
    const offsetMin = parseInt(req.headers['x-timezone-offset']) || 0;
    const localNow = new Date(Date.now() - offsetMin * 60000);
    const todayYear = localNow.getUTCFullYear();
    const todayMonth = localNow.getUTCMonth() + 1;
    const todayDate = localNow.getUTCDate();
    const lastDay = (y === todayYear && m === todayMonth)
        ? todayDate
        : new Date(Date.UTC(y, m, 0)).getUTCDate();
    let weekendDays = 0;
    for (let d = 1; d <= lastDay; d++) {
        const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
        if (dow === 0 || dow === 6) weekendDays++;
    }

    const total = leaves.reduce((s, l) => s + l.count, 0);
    res.json({ month: m, year: y, total, weekendDays, breakdown: leaves });
});

// ==================== HELPERS ====================

// ==================== HELPERS ====================

/**
 * Update leave balance when a leave is approved/deleted.
 */
function updateLeaveBalance(userId, leaveType, date, duration, operation) {
    const year = parseInt(date.slice(0, 4));
    const durationValue = duration === 'half' ? 0.5 : duration === 'quarter' ? 0.25 : 1;

    const balance = db.prepare(
        'SELECT id, used FROM leave_balances WHERE user_id = ? AND leave_type = ? AND year = ?'
    ).get(userId, leaveType, year);

    if (balance) {
        const newUsed = operation === 'add'
            ? balance.used + durationValue
            : Math.max(0, balance.used - durationValue);
        db.prepare('UPDATE leave_balances SET used = ? WHERE id = ?').run(newUsed, balance.id);
    }
}

module.exports = router;
module.exports.updateLeaveBalance = updateLeaveBalance;
