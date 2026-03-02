/**
 * Shared utility to find the appropriate approver for a user.
 * Priority: Direct manager → Team lead → Department head → HR admin
 */
const db = require('../db');

function findApprover(userId, orgId) {
    const user = db.prepare('SELECT manager_id, team_id, department_id FROM users WHERE id = ?').get(userId);

    // 1. Direct manager (works with or without org)
    if (user?.manager_id) {
        const mgr = db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(user.manager_id);
        if (mgr) return mgr;
    }

    if (!orgId) return null;

    // 2. Team lead
    if (user?.team_id) {
        const team = db.prepare('SELECT lead_id FROM teams WHERE id = ?').get(user.team_id);
        if (team?.lead_id && team.lead_id !== userId) {
            const lead = db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(team.lead_id);
            if (lead) return lead;
        }
    }

    // 3. Department head
    if (user?.department_id) {
        const dept = db.prepare('SELECT head_id FROM departments WHERE id = ?').get(user.department_id);
        if (dept?.head_id && dept.head_id !== userId) {
            const head = db.prepare('SELECT id FROM users WHERE id = ? AND is_active = 1').get(dept.head_id);
            if (head) return head;
        }
    }

    // 4. Any HR admin in the org
    const hrAdmin = db.prepare(
        "SELECT id FROM users WHERE org_id = ? AND role IN ('hr_admin', 'super_admin') AND id != ? AND is_active = 1 LIMIT 1"
    ).get(orgId, userId);

    return hrAdmin || null;
}

module.exports = { findApprover };
