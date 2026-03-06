/**
 * Shared utility to find the appropriate approver for a user.
 * Priority: Direct manager → Team lead → Department head → HR admin
 */
const { query } = require('../db');

async function findApprover(userId, orgId) {
    const userRes = await query(
        'SELECT manager_id, team_id, department_id FROM users WHERE id = $1',
        [userId],
    );
    const user = userRes.rows[0];

    // 1. Direct manager
    if (user?.manager_id) {
        const mgrRes = await query(
            'SELECT id FROM users WHERE id = $1 AND is_active = TRUE',
            [user.manager_id],
        );
        if (mgrRes.rows[0]) return mgrRes.rows[0];
    }

    if (!orgId) return null;

    // 2. Team lead
    if (user?.team_id) {
        const teamRes = await query('SELECT lead_id FROM teams WHERE id = $1', [user.team_id]);
        const leadId = teamRes.rows[0]?.lead_id;
        if (leadId && leadId !== userId) {
            const leadRes = await query(
                'SELECT id FROM users WHERE id = $1 AND is_active = TRUE',
                [leadId],
            );
            if (leadRes.rows[0]) return leadRes.rows[0];
        }
    }

    // 3. Department head
    if (user?.department_id) {
        const deptRes = await query('SELECT head_id FROM departments WHERE id = $1', [user.department_id]);
        const headId = deptRes.rows[0]?.head_id;
        if (headId && headId !== userId) {
            const headRes = await query(
                'SELECT id FROM users WHERE id = $1 AND is_active = TRUE',
                [headId],
            );
            if (headRes.rows[0]) return headRes.rows[0];
        }
    }

    // 4. Any HR admin in the org
    const hrRes = await query(
        `SELECT id FROM users
         WHERE org_id = $1 AND role IN ('hr_admin','super_admin') AND id != $2 AND is_active = TRUE
         LIMIT 1`,
        [orgId, userId],
    );
    if (hrRes.rows[0]) return hrRes.rows[0];

    // 5. Super admins with no one above them self-approve
    const selfRes = await query(
        `SELECT id FROM users WHERE id = $1 AND role = 'super_admin' AND is_active = TRUE`,
        [userId],
    );
    return selfRes.rows[0] || null;
}

module.exports = { findApprover };
