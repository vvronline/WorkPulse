/**
 * Canonical role keys (fixed by RBAC, not customisable).
 *
 * NOTE: ROLE_LABELS is the *system default* fallback only — at runtime,
 * everywhere that displays a role name in the UI should call
 * `useRoleLabel(role)` from RoleLabelsContext to pick up the tenant's
 * customised label. Keep this map in sync with server/middleware/rbac.js
 * `DEFAULT_ROLE_LABELS`.
 */
export const ROLES = ['employee', 'team_lead', 'manager', 'hr_admin', 'super_admin'];
export const ROLE_LABELS = {
    employee: 'Employee',
    team_lead: 'Team Lead',
    manager: 'Manager',
    hr_admin: 'HR Admin',
    super_admin: 'Super Admin',
    platform_admin: 'Platform Admin',
};
