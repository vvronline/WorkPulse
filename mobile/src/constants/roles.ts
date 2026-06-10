/**
 * Canonical role keys (fixed by RBAC). Mirrors
 * client/src/pages/admin/constants.ts and server/middleware/rbac.js.
 */
export const ROLES = [
  "employee",
  "team_lead",
  "manager",
  "hr_admin",
  "super_admin",
] as const;

export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<string, string> = {
  employee: "Employee",
  team_lead: "Team Lead",
  manager: "Manager",
  hr_admin: "HR Admin",
  super_admin: "Super Admin",
  platform_admin: "Platform Admin",
};

export const ROLE_LEVEL: Record<string, number> = {
  employee: 1,
  user: 1,
  team_lead: 2,
  manager: 3,
  hr_admin: 4,
  super_admin: 5,
  platform_admin: 6,
};

export function roleLabel(role?: string | null): string {
  if (!role) return "—";
  return ROLE_LABELS[role] || role.replace(/_/g, " ");
}

/** Whether `actorRole` can manage a user/target with `targetRole`. */
export function canManageRole(actorRole: string, targetRole: string): boolean {
  if (actorRole === "platform_admin") return true;
  return (ROLE_LEVEL[actorRole] ?? 0) > (ROLE_LEVEL[targetRole] ?? 0);
}