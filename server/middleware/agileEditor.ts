/**
 * Agile editor authorization middleware.
 *
 * Editing Agile settings (work item types, workflow states, org_agile_settings)
 * is allowed by default for the roles that own the Agile process:
 *
 *   - platform_admin   (system operator)
 *   - super_admin      (org owner)
 *   - hr_admin         (org admin — keeps the admin sidebar consistent)
 *   - manager          (delivery manager)
 *   - team_lead        (team lead = scrum master in our role hierarchy)
 *   - scrum_master     (explicit alias if a tenant uses this label)
 *
 * Plus: any user with an active row in agile_editor_grants for their org
 * (for ad-hoc product owners / coaches outside the role tree).
 *
 * Everyone else is read-only and can submit a request via
 * POST /agile/permissions/request, which any of the above approve/reject.
 *
 * Requires loadUserContext to have run first.
 */
import type { Response, NextFunction } from "express";

const ROLES_THAT_CAN_EDIT_AGILE = new Set<string>([
    "platform_admin",
    "super_admin",
    "hr_admin",
    "manager",
    "team_lead",
    "scrum_master",
]);

const ROLES_THAT_CAN_REVIEW_AGILE_REQUESTS = new Set<string>([
    "platform_admin",
    "super_admin",
    "hr_admin",
    "manager",
]);

function isAgileEditorRole(role: string): boolean {
    return ROLES_THAT_CAN_EDIT_AGILE.has(role);
}

function isAgileReviewerRole(role: string): boolean {
    return ROLES_THAT_CAN_REVIEW_AGILE_REQUESTS.has(role);
}

async function isAgileEditor(req: any): Promise<boolean> {
    if (!req.userId) return false;
    if (isAgileEditorRole(req.userRole)) return true;
    if (!req.userOrgId) return false;
    try {
        const r = await req.db.query(
            `SELECT 1 FROM agile_editor_grants
              WHERE org_id = $1 AND user_id = $2 AND revoked_at IS NULL
              LIMIT 1`,
            [req.userOrgId, req.userId],
        );
        return r.rowCount > 0;
    } catch {
        return false;
    }
}

async function requireAgileEditor(req: any, res: Response, next: NextFunction): Promise<void | Response> {
    const ok = await isAgileEditor(req);
    if (!ok) {
        return res.status(403).json({
            error: "Insufficient permissions to edit Agile settings. Request access from a super_admin or manager.",
        });
    }
    next();
}

export {
    requireAgileEditor,
    isAgileEditor,
    isAgileEditorRole,
    isAgileReviewerRole,
    ROLES_THAT_CAN_EDIT_AGILE,
    ROLES_THAT_CAN_REVIEW_AGILE_REQUESTS,
};