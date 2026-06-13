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

export function updateAdminOrganization(
  id: number | string,
  data: {
    name?: string;
    timezone?: string;
    work_hours_per_day?: number;
    work_days?: string;
    fiscal_year_start?: number | string;
  },
) {
  return api.put(`/admin/organizations/${id}`, data);
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
  org_id?: number | null;
}) {
  return api.post<Department>("/org/departments", data);
}

export function updateDepartment(
  id: number | string,
  data: {
    name?: string;
    description?: string;
    head_id?: number | null;
    org_id?: number | null;
  },
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
  org_id?: number | null;
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
    org_id?: number | null;
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
  fiscal_year_start?: string | number;
  min_hours_present?: number | null;
  office_start_time?: string | null;
  // Attendance verification (face + geofence/wifi).
  attendance_verification_enabled?: boolean;
  office_latitude?: number | null;
  office_longitude?: number | null;
  office_radius_m?: number;
  office_address?: string | null;
  office_wifi_verification_enabled?: boolean;
  office_wifi_bssids?: Array<{
    bssid: string;
    label?: string | null;
    ssid?: string | null;
  }>;
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

// Mirrors server/routes/platformAccess.ts `publicRow()`.
export type IncomingAccessRequest = {
  id: number;
  tenant_id?: number;
  requested_by?: number;
  requested_by_name?: string | null;
  requested_by_email?: string | null;
  requested_at: string;
  reason?: string | null;
  scope?: "read" | "write" | string | null;
  duration_minutes?: number | null;
  status: string;
  raw_status?: string;
  approved_by?: number | null;
  approved_by_name?: string | null;
  approved_at?: string | null;
  denied_reason?: string | null;
  code_expires_at?: string | null;
  consumed_at?: string | null;
  session_ends_at?: string | null;
  revoked_at?: string | null;
  revoked_by_name?: string | null;
  revoked_reason?: string | null;
  cancelled_at?: string | null;
  created_at?: string;
  updated_at?: string;
};

export function listIncomingAccessRequests(params?: {
  status?: string;
  limit?: number;
  offset?: number;
}) {
  return api.get<{
    requests: IncomingAccessRequest[];
    active_session?: IncomingAccessRequest | null;
  }>("/platform-access", { params });
}

export function approveAccessRequest(id: number | string) {
  return api.post<{
    message: string;
    approval_code: string;
    code_expires_at?: string;
  }>(`/platform-access/${id}/approve`);
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

// Mirrors the `tenants` table rows returned by server/routes/tenants.ts.
export type Tenant = {
  id: number;
  org_name: string;
  slug?: string | null;
  custom_domain?: string | null;
  status?: "active" | "suspended" | "deleted" | string;
  plan?: string | null;
  user_count?: number;
  max_users?: number | null;
  max_storage_mb?: number | null;
  db_name?: string | null;
  is_default?: boolean;
  features?: Record<string, boolean> | null;
  effective_features?: Record<string, boolean>;
  created_at?: string;
  suspended_at?: string | null;
  suspended_reason?: string | null;
};

// Mirrors GET /admin/tenants/overview.
export type TenantOverview = {
  total_tenants?: number;
  total_users?: number;
  by_status?: Record<string, number>;
  by_plan?: Record<string, number>;
  trend_30d?: { day: string; count: string | number }[];
  recent?: {
    id: number;
    org_name: string;
    slug: string;
    status: string;
    created_at: string;
  }[];
  pool_stats?: Record<string, number>;
};

export function getTenants(params?: Record<string, string | number>) {
  return api.get<{ total: number; tenants: Tenant[] }>("/admin/tenants", {
    params,
  });
}

export function getTenantOverview() {
  return api.get<TenantOverview>("/admin/tenants/overview");
}

export function getTenant(id: number | string) {
  return api.get<Tenant>(`/admin/tenants/${id}`);
}

// Mirrors GET /admin/tenants/:id/stats.
export type TenantStats = {
  user_count?: number;
  task_count?: number;
  message_count?: number;
  db_size_bytes?: number;
  last_activity?: string | null;
};

export function getTenantStats(id: number | string) {
  return api.get<TenantStats>(`/admin/tenants/${id}/stats`);
}

export function createTenant(data: {
  org_name: string;
  slug: string;
  plan?: string;
  max_users?: number | null;
  max_storage_mb?: number | null;
}) {
  return api.post<{ tenant: Tenant }>("/admin/tenants", data);
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
  return api.get<{ total?: number; users?: TenantUser[] }>(
    `/admin/tenants/${id}/users`,
    { params },
  );
}

export function updateTenantDomain(id: number | string, custom_domain: string) {
  return api.put<{ tenant: Tenant }>(`/admin/tenants/${id}/domain`, {
    custom_domain,
  });
}

export function updateTenantLimits(
  id: number | string,
  data: { max_users?: number | null; max_storage_mb?: number | null },
) {
  return api.put<{ tenant: Tenant }>(`/admin/tenants/${id}/limits`, data);
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

export function createTenantUser(
  id: number | string,
  data: {
    username: string;
    full_name: string;
    email: string;
    password: string;
    role?: string;
  },
) {
  return api.post<{ user: TenantUser }>(`/admin/tenants/${id}/users`, data);
}

export function seedTenant(id: number | string) {
  return api.post<{
    message: string;
    seeded: { departments: number; leave_policies: number };
  }>(`/admin/tenants/${id}/seed`);
}

/* ─────────────── Platform: Access Requests (inspector side) ─────────────── */

// Mirrors server publicAccessRequest() in routes/tenants.ts.
export type TenantAccessRequest = {
  id: number;
  tenant_id: number;
  tenant_org_name?: string | null;
  tenant_slug?: string | null;
  requested_by?: number;
  requested_by_name?: string | null;
  requested_at?: string;
  reason?: string | null;
  scope?: "read" | "write" | string;
  duration_minutes?: number;
  status: string;
  raw_status?: string;
  approved_by_name?: string | null;
  approved_at?: string | null;
  denied_reason?: string | null;
  code_expires_at?: string | null;
  consumed_at?: string | null;
  session_ends_at?: string | null;
  cancelled_at?: string | null;
};

export function createTenantAccessRequest(
  tenantId: number | string,
  data: { reason: string; scope?: string; duration_minutes?: number },
) {
  return api.post<{ request: TenantAccessRequest }>(
    `/admin/tenants/${tenantId}/access-requests`,
    data,
  );
}

export function listTenantAccessRequests(tenantId: number | string) {
  return api.get<{ requests: TenantAccessRequest[] }>(
    `/admin/tenants/${tenantId}/access-requests`,
  );
}

export function cancelTenantAccessRequest(id: number | string) {
  return api.delete<{ message: string }>(
    `/admin/tenants/access-requests/${id}`,
  );
}

// Start an impersonation session. Server returns the impersonation JWT in
// the body (Bearer clients can't read the HttpOnly cookie).
export function impersonateTenant(
  id: number | string,
  body: { approval_code?: string; password: string; break_glass?: boolean },
) {
  return api.post<{
    tenant: { id: number; org_name: string; slug?: string };
    user: { id: number; username: string };
    token?: string;
    session: {
      request_id?: number | null;
      break_glass?: boolean;
      scope?: string;
      ends_at?: string;
      duration_minutes?: number;
    };
  }>(`/admin/tenants/${id}/impersonate`, body);
}

export function exitImpersonateTenant(id: number | string) {
  return api.post<{ message: string }>(
    `/admin/tenants/${id}/exit-impersonate`,
  );
}

/* ─────────────── Platform: Impersonation Policy ─────────────── */

export type ImpersonationPolicy = {
  requiresConsent?: boolean;
  breakGlassAllowed?: boolean;
  maxSessionMinutes?: number;
  codeTtlMinutes?: number;
  [k: string]: unknown;
};

export function getImpersonationPolicy() {
  return api.get<ImpersonationPolicy>("/admin/tenants/impersonation-policy");
}

export function updateImpersonationPolicy(data: {
  requires_consent?: boolean;
  break_glass_allowed?: boolean;
  max_session_minutes?: number;
  code_ttl_minutes?: number;
}) {
  return api.put<ImpersonationPolicy>(
    "/admin/tenants/impersonation-policy",
    data,
  );
}

/* ─────────────── Platform: Global Announcements ─────────────── */

export type PlatformAnnouncement = {
  id: number;
  message: string;
  type: string;
  is_active: boolean;
  created_at: string;
  expires_at?: string | null;
};

export function getAdminAnnouncements() {
  return api.get<PlatformAnnouncement[]>("/admin/announcements");
}

export function createAnnouncement(data: {
  message: string;
  type: string;
  duration?: string | number | null;
}) {
  return api.post("/admin/announcements", data);
}

export function updateAnnouncement(
  id: number | string,
  data: { is_active?: boolean },
) {
  return api.put(`/admin/announcements/${id}`, data);
}

export function deleteAnnouncement(id: number | string) {
  return api.delete(`/admin/announcements/${id}`);
}

/* ───────────────────────── Platform: Plans ───────────────────────── */

// Mirrors GET /admin/tenants/plan-catalog — plans is an OBJECT keyed by plan
// key (e.g. { standard: {...}, pro: {...} }), not an array.
export type PlanDef = {
  label: string;
  description?: string;
  features: Record<string, boolean>;
  limits: { max_users?: number | null; max_storage_mb?: number | null };
};

export type PlanCatalog = {
  plans: Record<string, PlanDef>;
  feature_labels: Record<string, string>;
  feature_keys?: string[];
};

export function getPlanCatalog() {
  return api.get<PlanCatalog>("/admin/tenants/plan-catalog");
}

export function updatePlanCatalog(plans: unknown) {
  return api.put<PlanCatalog>("/admin/tenants/plan-catalog", { plans });
}

export function resetPlanCatalog() {
  return api.post<PlanCatalog>("/admin/tenants/plan-catalog/reset");
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
  // Server returns a bare array of platform_users rows.
  return api.get<PlatformUser[]>("/admin/tenants/platform-users");
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

// Mirrors GET /admin/tenants/alerts → { alerts: [...] }.
export type TenantAlert = {
  tenant_id: number;
  tenant_name: string;
  slug: string;
  alert_type:
    | "users_approaching_limit"
    | "storage_approaching_limit"
    | "no_active_super_admin"
    | string;
  current_value: number;
  limit_value: number;
  percentage: number;
};

export function getTenantAlerts() {
  return api.get<{ alerts: TenantAlert[] }>("/admin/tenants/alerts");
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
  email?: string | null;
  role?: string;
  avatar?: string | null;
  manager_id?: number | null;
  manager_name?: string | null;
  department_id?: number | null;
  department_name?: string | null;
  team_id?: number | null;
  team_name?: string | null;
  title?: string | null;
};

export type OrgChartDepartment = {
  id: number;
  name: string;
  head_id?: number | null;
  head_name?: string | null;
  head_avatar?: string | null;
};

export type OrgChartTeam = {
  id: number;
  name: string;
  department_id?: number | null;
  lead_id?: number | null;
  lead_name?: string | null;
  lead_avatar?: string | null;
};

export type OrgChartResponse = {
  departments: OrgChartDepartment[];
  teams: OrgChartTeam[];
  members: OrgChartNode[];
};

// Server GET /org/chart returns { departments, teams, members } (see
// server/routes/organization.ts). The old typing assumed a bare array /
// { nodes } shape, which made the mobile Org Chart screen permanently empty.
export function getOrgChart() {
  return api.get<OrgChartResponse>("/org/chart");
}

/* ───────────────────────── Admin: Custom Roles ───────────────────────── */

export type OrgRole = {
  role_key: string;
  label: string;
  description?: string | null;
  color?: string | null;
  permission_level: number;
  is_system?: boolean;
  sort_order?: number;
  customised?: boolean;
  user_count?: number;
};

export function getOrgRoles() {
  return api.get<{ defaults: OrgRole[]; roles: OrgRole[] }>("/org/roles");
}

export function createOrgRole(data: {
  role_key: string;
  label: string;
  description?: string;
  color?: string;
  permission_level: number;
}) {
  return api.post<{ defaults: OrgRole[]; roles: OrgRole[] }>(
    "/org/roles",
    data,
  );
}

export function updateOrgRole(
  roleKey: string,
  data: {
    label?: string;
    description?: string | null;
    color?: string;
    permission_level?: number;
    sort_order?: number;
  },
) {
  return api.patch<{ defaults: OrgRole[]; roles: OrgRole[] }>(
    `/org/roles/${roleKey}`,
    data,
  );
}

export function deleteOrgRole(roleKey: string) {
  return api.delete<{ defaults: OrgRole[]; roles: OrgRole[] }>(
    `/org/roles/${roleKey}`,
  );
}

/* ───────────────────────── Admin: Branding (logo + email templates) ───────────────────────── */

export function uploadBrandingLogo(uri: string) {
  const name = uri.split("/").pop() || "logo.png";
  const match = /\.(\w+)$/.exec(name);
  const ext = (match?.[1] || "png").toLowerCase();
  const type =
    ext === "jpg" || ext === "jpeg"
      ? "image/jpeg"
      : ext === "webp"
        ? "image/webp"
        : ext === "svg"
          ? "image/svg+xml"
          : "image/png";
  const form = new FormData();
  // React Native FormData file shape.
  form.append("logo", { uri, name, type } as any);
  return api.post<{ logo_url: string }>("/branding/logo", form, {
    headers: { "Content-Type": "multipart/form-data" },
  });
}

export function deleteBrandingLogo() {
  return api.delete("/branding/logo");
}

export type EmailTemplate = {
  template_key: string;
  subject: string;
  body_html: string;
  enabled: boolean;
  is_overridden?: boolean;
  builtin_subject?: string;
  builtin_body_html?: string;
};

export function getEmailTemplates() {
  return api.get<{ templates: EmailTemplate[] }>("/branding/email-templates");
}

export function updateEmailTemplate(
  key: string,
  data: { subject?: string; body_html?: string; enabled?: boolean },
) {
  return api.put(`/branding/email-templates/${key}`, data);
}

export function revertEmailTemplate(key: string) {
  return api.delete(`/branding/email-templates/${key}`);
}

/* ───────────────────────── Admin: Agile Config ───────────────────────── */

export type AgileSettings = {
  org_id?: number;
  estimation_type?: string;
  estimation_values?: Array<number | string> | string;
  estimation_unit_label?: string;
  priority_scheme?: Array<{ key: string; label: string; color: string }> | string;
  enable_story_points?: boolean;
  enable_epics?: boolean;
  enable_dependencies?: boolean;
  enable_acceptance_criteria?: boolean;
  enable_wip_limits?: boolean;
  enable_blockers?: boolean;
  enable_retrospectives?: boolean;
  require_estimate_for_sprint?: boolean;
  default_dod?: string | null;
  [k: string]: unknown;
};

export type AgileWorkItemType = {
  id: number;
  key: string;
  name: string;
  icon?: string | null;
  color?: string | null;
  description?: string | null;
  is_default?: boolean;
  is_epic?: boolean;
  is_active?: boolean;
  sort_order?: number;
};

export type AgileWorkflowState = {
  id: number;
  key: string;
  name: string;
  category: "open" | "in_progress" | "in_review" | "done" | string;
  color?: string | null;
  icon?: string | null;
  wip_limit?: number | null;
  is_initial?: boolean;
  is_terminal?: boolean;
  is_active?: boolean;
  sort_order?: number;
};

export function getAgileSettings() {
  return api.get<AgileSettings>("/agile/settings");
}

export function updateAgileSettings(data: Partial<AgileSettings>) {
  return api.put<AgileSettings>("/agile/settings", data);
}

export function getWorkItemTypes() {
  return api.get<AgileWorkItemType[]>("/agile/work-item-types");
}

export function createWorkItemType(data: {
  name: string;
  icon?: string;
  color?: string;
  description?: string;
  is_epic?: boolean;
  is_default?: boolean;
}) {
  return api.post<AgileWorkItemType>("/agile/work-item-types", data);
}

export function updateWorkItemType(
  id: number | string,
  data: Partial<{
    name: string;
    icon: string | null;
    color: string;
    description: string | null;
    is_epic: boolean;
    is_default: boolean;
    is_active: boolean;
    sort_order: number;
  }>,
) {
  return api.put<AgileWorkItemType>(`/agile/work-item-types/${id}`, data);
}

export function deleteWorkItemType(id: number | string) {
  return api.delete(`/agile/work-item-types/${id}`);
}

export function getWorkflowStates() {
  return api.get<AgileWorkflowState[]>("/agile/workflow-states");
}

export function createWorkflowState(data: {
  name: string;
  category: string;
  color?: string;
  icon?: string;
  wip_limit?: number | null;
  is_initial?: boolean;
  is_terminal?: boolean;
}) {
  return api.post<AgileWorkflowState>("/agile/workflow-states", data);
}

export function updateWorkflowState(
  id: number | string,
  data: Partial<{
    name: string;
    category: string;
    color: string;
    icon: string | null;
    wip_limit: number | null;
    is_initial: boolean;
    is_terminal: boolean;
    is_active: boolean;
    sort_order: number;
  }>,
) {
  return api.put<AgileWorkflowState>(`/agile/workflow-states/${id}`, data);
}

export function deleteWorkflowState(id: number | string) {
  return api.delete(`/agile/workflow-states/${id}`);
}

export function getAgilePermissions() {
  return api.get<{
    canEdit: boolean;
    isSuperAdmin?: boolean;
    requestStatus?: string | null;
  }>("/agile/permissions/me");
}

/* ───────────────────────── Admin: Integrations ───────────────────────── */

export type Integration = {
  id: number;
  provider: string;
  status?: string;
  config?: Record<string, unknown> | null;
  created_at?: string;
  [k: string]: unknown;
};

export function getIntegrations() {
  return api.get<Integration[] | { integrations: Integration[] }>(
    "/integrations",
  );
}

export type GithubStatus = {
  connected: boolean;
  account?: string | null;
  repos?: Array<{ full_name: string; connected?: boolean }>;
  [k: string]: unknown;
};

export function getGithubStatus() {
  return api.get<GithubStatus>("/integrations/github/status");
}

export function deleteIntegration(id: number | string) {
  return api.delete(`/integrations/${id}`);
}

export function disconnectGithub() {
  return api.post("/integrations/github/disconnect");
}

/* ───────────────────────── Admin: Compensation ───────────────────────── */

export type CompensationTemplate = {
  id: number;
  name: string;
  description?: string | null;
  components?: Array<{ key?: string; name?: string; type?: string; value?: number }> | string;
  is_default?: boolean;
  created_at?: string;
};

export function getCompensationTemplates() {
  return api.get<CompensationTemplate[]>("/compensation/templates");
}

export type EmployeeCompensation = {
  user_id: number;
  full_name?: string;
  username?: string;
  email?: string | null;
  avatar?: string | null;
  department_name?: string | null;
  annual_ctc?: number | string | null;
  monthly_gross?: number | string | null;
  template_id?: number | null;
  template_name?: string | null;
  effective_from?: string | null;
  has_compensation?: boolean;
  id?: number;
  [k: string]: unknown;
};

export function getEmployeeCompensations() {
  return api.get<EmployeeCompensation[]>("/compensation/employees");
}

export function getEmployeeCompensation(userId: number | string) {
  return api.get<EmployeeCompensation[]>(`/compensation/employees/${userId}`);
}

export function setEmployeeCompensation(
  userId: number | string,
  data: {
    template_id?: number | null;
    annual_ctc?: number;
    effective_from?: string;
    components?: unknown;
  },
) {
  return api.post(`/compensation/employees/${userId}`, data);
}

/* ───────────────────────── Admin: Salary Slips ───────────────────────── */

export type SalarySlip = {
  id: number;
  user_id: number;
  full_name?: string;
  username?: string;
  pay_period_id: number;
  period_label?: string;
  gross_earnings?: number | string;
  total_deductions?: number | string;
  net_pay?: number | string;
  status: "draft" | "published" | string;
  created_at?: string;
  [k: string]: unknown;
};

export function getSalarySlips(params?: Record<string, string | number>) {
  return api.get<SalarySlip[]>("/compensation/salary-slips", { params });
}

export function runPayroll(data: { pay_period_id: number }) {
  return api.post<{ message: string; [k: string]: unknown }>(
    "/compensation/payroll-run",
    data,
  );
}

export function publishSalarySlip(id: number | string) {
  return api.put(`/compensation/salary-slips/${id}/publish`);
}

export function bulkPublishSlips(data: { pay_period_id: number }) {
  return api.post<{ message: string }>(
    "/compensation/salary-slips/bulk-publish",
    data,
  );
}

/* ───────────────────────── Admin: Payment Config ───────────────────────── */

export type PaymentConfig = {
  id?: number;
  api_key_id?: string | null;
  api_key_secret?: string | null;
  account_number?: string | null;
  webhook_secret?: string | null;
  default_transfer_mode?: string | null;
  is_active?: boolean;
  configured?: boolean;
  [k: string]: unknown;
};

export function getPaymentConfig() {
  return api.get<PaymentConfig>("/compensation/payment-config");
}

export function savePaymentConfig(data: {
  api_key_id?: string;
  api_key_secret?: string;
  account_number?: string;
  webhook_secret?: string;
  default_transfer_mode?: string;
  is_active?: boolean;
}) {
  return api.put<{ message: string }>("/compensation/payment-config", data);
}

export function testPaymentConfig() {
  return api.post<{ message?: string; balance?: unknown; [k: string]: unknown }>(
    "/compensation/payment-config/test",
  );
}
