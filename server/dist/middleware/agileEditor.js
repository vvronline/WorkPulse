"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ROLES_THAT_CAN_REVIEW_AGILE_REQUESTS = exports.ROLES_THAT_CAN_EDIT_AGILE = void 0;
exports.requireAgileEditor = requireAgileEditor;
exports.isAgileEditor = isAgileEditor;
exports.isAgileEditorRole = isAgileEditorRole;
exports.isAgileReviewerRole = isAgileReviewerRole;
const ROLES_THAT_CAN_EDIT_AGILE = new Set([
    "platform_admin",
    "super_admin",
    "hr_admin",
    "manager",
    "team_lead",
    "scrum_master",
]);
exports.ROLES_THAT_CAN_EDIT_AGILE = ROLES_THAT_CAN_EDIT_AGILE;
const ROLES_THAT_CAN_REVIEW_AGILE_REQUESTS = new Set([
    "platform_admin",
    "super_admin",
    "hr_admin",
    "manager",
]);
exports.ROLES_THAT_CAN_REVIEW_AGILE_REQUESTS = ROLES_THAT_CAN_REVIEW_AGILE_REQUESTS;
function isAgileEditorRole(role) {
    return ROLES_THAT_CAN_EDIT_AGILE.has(role);
}
function isAgileReviewerRole(role) {
    return ROLES_THAT_CAN_REVIEW_AGILE_REQUESTS.has(role);
}
async function isAgileEditor(req) {
    if (!req.userId)
        return false;
    if (isAgileEditorRole(req.userRole))
        return true;
    if (!req.userOrgId)
        return false;
    try {
        const r = await req.db.query(`SELECT 1 FROM agile_editor_grants
              WHERE org_id = $1 AND user_id = $2 AND revoked_at IS NULL
              LIMIT 1`, [req.userOrgId, req.userId]);
        return r.rowCount > 0;
    }
    catch {
        return false;
    }
}
async function requireAgileEditor(req, res, next) {
    const ok = await isAgileEditor(req);
    if (!ok) {
        return res.status(403).json({
            error: "Insufficient permissions to edit Agile settings. Request access from a super_admin or manager.",
        });
    }
    next();
}
//# sourceMappingURL=agileEditor.js.map