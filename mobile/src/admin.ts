import { api } from "./api";

/* ════════════════════════════════════════════════════════════════════
   Admin + Platform Console API layer (mirrors client/src/api.ts).
   All endpoints are Bearer-auth ready on the shared backend.
   ════════════════════════════════════════════════════════════════════ */

/* ───────────────────────── Admin: Stats ───────────────────────── */

export type AdminStats = {
  totalUsers?: number;
  activeUsers?: number;
  departments?: number;
  teams?: number;
  pendingApprovals?: number;
  clockedInToday?: number;
  [k: string]: unknown;
};

export function getAdminStats() {
  return api.get<AdminStats>("/admin/stats");
}

/* ───────────────────────── Admin: Users ───────────────────────── */

export type AdminUser = {
  id: number;
  username: string;
  full_name: string;
  email?: string | null;
  avatar?: string | null;
  role: string;
  is_active: boolean;
  org_id?: number | null;
  department_id?: number | null;
  team_id?: number | null;
  manager_id?: number | null;
  created_at?: string;
  org_name?: string | null;
  department_name?: string | null;
  team_name?: string | null;
  manager_name?: string | null;
  timezone_offset?: number | null;
};

export type AdminUsersResponse = {
  data: AdminUser[];
  total: number;
  page: number;
  perPage: number;
};

export function getAdminUsers(params?: Record<string, string | number>) {
  return api.get<AdminUsersResponse>("/admin/users", { params });
}

export function getAdminUser(id: number | string) {
  return api.get<AdminUser>(`/admin/users/${id}`);
}

export function createAdminUser(data: {
  username: string;
  full_name: string;
  email: string;
  password?: string;
  role?: string;
  org_id?: number | null;
  department_id?: number | null;
  team_id?: number | null;
  manager_id?: number | null;
}) {
  return api.post<{ id: number; message: string }>("/admin/users", data);
}

export function updateUserRole(
  id: number | string,
  role: string,
  reason?: string,
) {
  return api.put<{ message: string; immediate?: boolean; pending?: boolean }>(
    `/admin/users/${id}/role`,
    { role, reason },
  );
}

export function updateUserAssignment(
  id: number | string,
  data: {
    org_id?: number | null;
    department_id?: number | null;
    team_id?: number | null;
    manager_id?: number | null;
  },
) {
  return api.put<{ message: string }>(`/admin/users/${id}/assignment`, data);
}

export function toggleUserActive(id: number | string) {
  return api.put<{ message: string; is_active: boolean }>(
    `/admin/users/${id}/deactivate`,
  );
}

export function deleteAdminUser(id: number | string) {
  return api.delete<{ message: string }>(`/admin/users/${id}`);
}

export function adminResetPassword(id: number | string, new_password: string) {
  return api.post<{ message: string }>(`/admin/users/${id}/reset-password`, {
    new_password,
  });
}

/* ───────────────────── Admin: Role Change Requests ───────────────────── */

export type RoleChangeRequest = {
  id: number;
  target_user_id: number;
  target_name?: string;
  target_username?: string;
  requester_name?: string;
  requested_by?: number;
  from_role: string;
  to_role: string;
  current_role?: string;
  requested_role?: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  reason?: string | null;
  reject_reason?: string | null;
  created_at: string;
  resolved_at?: string | null;
  approvals?: Record<string, { status: string; by?: number; at?: string }>;
};

export function getRoleChangeRequests(params?: { status?: string }) {
  return api.get<RoleChangeRequest[]>("/admin/role-requests", { params });
}

export function approveRoleChange(id: number | string) {
  return api.post<{ message: string; fully_approved?: boolean }>(
    `/admin/role-requests/${id}/approve`,
  );
}

export function rejectRoleChange(id: number | string, reason?: string) {
  return api.post<{ message: string }>(`/admin/role-requests/${id}/reject`, {
    reject_reason: reason,
  });
}

export function cancelRoleChange(id: number | string) {
  return api.post<{ message: string }>(`/admin/role-requests/${id}/cancel`);
}

/* ───────────────────────── Admin: Audit Logs ───────────────────────── */

export type AuditLog = {
  id: number;
  created_at: string;
  action: string;
  entity_type: string;
  entity_id?: number | string | null;
  details?: unknown;
  ip_address?: string | null;
  actor_id?: number | string;
  actor_name?: string;
  actor_username?: string;
  actor_is_inspector?: boolean;
};

export function getAuditLogs(params?: Record<string, string | number>) {
  return api.get<{ logs: AuditLog[]; total: number }>("/admin/audit-logs", {
    params,
  });
}

/* ───────────────────────── Admin: Organizations (platform) ───────────────────────── */

export type AdminOrganization = {
  id: number;
  name: string;
  slug?: string | null;
  timezone?: string | null;
  work_hours_per_day?: number | null;
  work_days?: string | null;
  fiscal_year_start?: string | null;
  member_count?: number;
};

export function getAdminOrganizations() {
  return api.get<{ data: AdminOrganization[]; total: number }>(
    "/admin/organizations",
  );
}

/* ─────────────────── Admin: Departments / Teams CRUD ─────────────────── */

export type Department = {
  id: number;
  name: string;
  description?: string | null;
  member_count?: number;
  head_id?: number | null;
  head_name?: string | null;
};

export type Team = {
  id: number;
  name: string;
  description?: string | null;
  department_id?: number | null;
  department_name?: string | null;
  member_count?: number;
  lead_id?: number | null;
  lead_name?: string | null;
};

export function getDepartments(params?: Record<string, string | number>) {
  return api.get<Department[]>("/org/departments", { params });
}

export function createDepartment(data: {
  name: string;
  description?: string;
  head_id?: number | null;
}) {
  return api.post<Department>("/org/departments", data);
}

export function updateDepartment(
  id: number | string,
  data: { name?: string; description?: string; head_id?: number | null },
) {
  return api.put<Department>(`/org/departments/${id}`, data);
}

export function deleteDepartment(id: number | string) {
  return api.delete(`/org/departments/${id}`);
}

export function getTeams(params?: Record<string, string | number>) {
  return api.get<Team[]>("/org/teams", { params });
}

export function createTeam(data: {
  name: string;
  description?: string;
  department_id?: number | null;
  lead_id?: number | null;
}) {
  return api.post<Team>("/org/teams", data);
}

export function updateTeam(
  id: number | string,
  data: {
    name?: string;
    description?: string;
    department_id?: number | null;
    lead_id?: number | null;
  },
) {
  return api.put<Team>(`/org/teams/${id}`, data);
}

export function deleteTeam(id: number | string) {
  return api.delete(`/org/teams/${id}`);
}

/* ───────────────────────── Admin: Org Settings ───────────────────────── */

export function updateOrgSettings(data: {
  name?: string;
  timezone?: string;
  work_hours_per_day?: number;
  work_days?: string;
  fiscal_year_start?: string;
}) {
  return api.put("/org/settings", data);
}

export type Branding = {
  accent_color?: string | null;
  logo_url?: string | null;
  [k: string]: unknown;
};

export function getBranding() {
  return api.get<Branding>("/branding");
}

export function updateBrandingAccent(accent_color: string) {
  return api.put("/branding", { accent_color });
}

/* ───────────────────────── Admin: Registration settings ───────────────────────── */

export function getRegistrationSettings() {
  return api.get<{ mode: string }>("/admin/registration-settings");
}

export function updateRegistrationSettings(mode: string) {
  return api.put("/admin/registration-settings", { mode });
}

export type InviteCode = {
  id: number;
  code: string;
  role?: string;
  max_uses?: number | null;
  uses?: number;
  expires_at?: string | null;
  created_at?: string;
  is_active?: boolean;
};

export function getInviteCodes() {
  return api.get<InviteCode[]>("/admin/invite-codes");
}

export function createInviteCode(data: {
  role?: string;
  max_uses?: number;
  expires_in_days?: number;
}) {
  return api.post<InviteCode>("/admin/invite-codes", data);
}

export function deactivateInviteCode(id: number | string) {
  return api.delete(`/admin/invite-codes/${id}`);
}

/* ───────────────────────── Platform Access (impersonation) ───────────────────────── */

export type IncomingAccessRequest = {
  id: number;
  inspector_name?: string;
  inspector_username?: string;
  reason?: string | null;
  status: string;
  created_at: string;
  expires_at?: string | null;
  scope?: string | null;
};

export function listIncomingAccessRequests(params?: { status?: string }) {
  return api.get<IncomingAccessRequest[]>("/platform-access", { params });
}

export function approveAccessRequest(id: number | string) {
  return api.post<{ message: string }>(`/platform-access/${id}/approve`);
}

export function denyAccessRequest(id: number | string, reason?: string) {
  return api.post<{ message: string }>(`/platform-access/${id}/deny`, {
    reason,
  });
}

export function revokeAccessSession(id: number | string, reason?: string) {
  return api.post<{ message: string }>(`/platform-access/${id}/revoke`, {
    reason,
  });
}

/* ════════════════════════ PLATFORM CONSOLE (Tenants) ════════════════════════ */

export type Tenant = {
  id: number;
  name: string;
  slug?: string | null;
  custom_domain?: string | null;
  status?: "active" | "suspended" | "deleted" | string;
  plan?: string | null;
  user_count?: number;
  created_at?: string;
  suspended_at?: string | null;
  suspended_reason?: string | null;
};

export type TenantOverview = {
  total?: number;
  active?: number;
  suspended?: number;
  totalUsers?: number;
  [k: string]: unknown;
};

export function getTenants(params?: Record<string, string | number>) {
  return api.get<{ tenants: Tenant[] }>("/admin/tenants", { params });
}

export function getTenantOverview() {
  return api.get<TenantOverview>("/admin/tenants/overview");
}

export function getTenant(id: number | string) {
  return api.get<Tenant>(`/admin/tenants/${id}`);
}

export type TenantStats = {
  users?: number;
  activeUsers?: number;
  tasks?: number;
  storage?: number;
  [k: string]: unknown;
};

export function getTenantStats(id: number | string) {
  return api.get<TenantStats>(`/admin/tenants/${id}/stats`);
}

export function createTenant(data: {
  name: string;
  admin_email?: string;
  admin_username?: string;
  admin_password?: string;
  plan?: string;
}) {
  return api.post<{ id: number; message: string }>("/admin/tenants", data);
}

export function suspendTenant(
  id: number | string,
  reason?: string,
  password?: string,
) {
  return api.put<{ message: string }>(`/admin/tenants/${id}/suspend`, {
    reason,
    password,
  });
}

export function reactivateTenant(id: number | string) {
  return api.put<{ message: string }>(`/admin/tenants/${id}/reactivate`);
}

export function deleteTenant(
  id: number | string,
  hard?: boolean,
  password?: string,
) {
  return api.delete<{ message: string }>(`/admin/tenants/${id}`, {
    params: hard ? { hard: "true" } : undefined,
    data: { password },
  });
}

export type TenantUser = {
  id: number;
  username: string;
  full_name: string;
  email?: string | null;
  role: string;
  is_active: boolean;
};

export function getTenantUsers(
  id: number | string,
  params?: Record<string, string | number>,
) {
  return api.get<{ data?: TenantUser[]; users?: TenantUser[] }>(
    `/admin/tenants/${id}/users`,
    { params },
  );
}

export function updateTenantPlan(
  id: number | string,
  plan: string,
  applyPlanLimits?: boolean,
) {
  return api.put<{ message: string }>(`/admin/tenants/${id}/plan`, {
    plan,
    apply_plan_limits: applyPlanLimits,
  });
}

export function updateTenantFeatures(id: number | string, features: unknown) {
  return api.put<{ message: string }>(`/admin/tenants/${id}/features`, {
    features,
  });
}

/* ───────────────────────── Platform: Plans ───────────────────────── */

export type Plan = {
  key: string;
  name: string;
  price?: number | null;
  max_users?: number | null;
  features?: Record<string, boolean> | string[];
  [k: string]: unknown;
};

export function getPlanCatalog() {
  return api.get<{ plans: Plan[] } | Plan[]>("/admin/tenants/plan-catalog");
}

export function updatePlanCatalog(plans: unknown) {
  return api.put("/admin/tenants/plan-catalog", { plans });
}

/* ───────────────────────── Platform: Admins ───────────────────────── */

export type PlatformUser = {
  id: number;
  username: string;
  full_name: string;
  email?: string | null;
  is_active: boolean;
  created_at?: string;
};

export function getPlatformUsers() {
  return api.get<{ data?: PlatformUser[]; users?: PlatformUser[] } | PlatformUser[]>(
    "/admin/tenants/platform-users",
  );
}

export function createPlatformUser(data: {
  username: string;
  full_name: string;
  email: string;
  password: string;
}) {
  return api.post<{ id: number; message: string }>(
    "/admin/tenants/platform-users",
    data,
  );
}

export function deactivatePlatformUser(id: number | string) {
  return api.put<{ message: string }>(
    `/admin/tenants/platform-users/${id}/deactivate`,
  );
}

export function resetPlatformUserPassword(
  id: number | string,
  new_password: string,
) {
  return api.post<{ message: string }>(
    `/admin/tenants/platform-users/${id}/reset-password`,
    { new_password },
  );
}

/* ───────────────────────── Platform: Config + Audit ───────────────────────── */

export function getPlatformConfig() {
  return api.get<Record<string, unknown>>("/admin/tenants/platform-config");
}

export function updatePlatformConfig(data: Record<string, unknown>) {
  return api.put("/admin/tenants/platform-config", data);
}

export function getTenantAlerts() {
  return api.get<unknown[]>("/admin/tenants/alerts");
}

export function getPlatformAuditLogs(params?: Record<string, string | number>) {
  return api.get<{ logs: AuditLog[]; total: number }>(
    "/admin/tenants/audit-logs",
    { params },
  );
}

/* ───────────────────────── Admin: Pay Periods ───────────────────────── */

export type PayPeriod = {
  id: number;
  label: string;
  start_date: string;
  end_date: string;
  is_locked?: boolean;
  locked_at?: string | null;
  created_at?: string;
};

export function getPayPeriods() {
  return api.get<PayPeriod[]>("/admin/pay-periods");
}

export function createPayPeriod(data: {
  label: string;
  start_date: string;
  end_date: string;
}) {
  return api.post<PayPeriod>("/admin/pay-periods", data);
}

export function deletePayPeriod(id: number | string) {
  return api.delete(`/admin/pay-periods/${id}`);
}

/* ───────────────────────── Admin: Projects ───────────────────────── */

export type Project = {
  id: number;
  name: string;
  key?: string;
  description?: string | null;
  is_archived?: boolean;
  task_count?: number;
  created_at?: string;
};

export function getProjects(includeArchived = false) {
  return api.get<Project[] | { projects: Project[] }>("/projects", {
    params: includeArchived ? { include_archived: 1 } : undefined,
  });
}

export function createProject(data: {
  name: string;
  key?: string;
  description?: string;
}) {
  return api.post<Project>("/projects", data);
}

export function archiveProject(id: number | string, isArchived: boolean) {
  return api.patch(`/projects/${id}/archive`, { is_archived: isArchived });
}

export function deleteProject(id: number | string) {
  return api.delete(`/projects/${id}`);
}

/* ───────────────────────── Admin: Org Chart ───────────────────────── */

export type OrgChartNode = {
  id: number;
  full_name: string;
  role?: string;
  avatar?: string | null;
  manager_id?: number | null;
  department_name?: string | null;
  team_name?: string | null;
  title?: string | null;
};

export function getOrgChart() {
  return api.get<OrgChartNode[] | { nodes: OrgChartNode[] }>("/org/chart");
}
