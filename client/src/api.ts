import axios from "axios";
import type { AxiosRequestConfig, AxiosResponse, InternalAxiosRequestConfig } from "axios";
import NProgress from "nprogress";
import "nprogress/nprogress.css";

type AnyData = Record<string, unknown> | unknown;
type Params = Record<string, unknown>;

NProgress.configure({ showSpinner: false });

// Disable NProgress loading bar in Electron desktop app
const isElectron = !!import.meta.env.VITE_ELECTRON;
// Desktop (Electron) builds set VITE_API_URL to the Railway server; web builds use relative /api
export const baseURL =
    import.meta.env.VITE_API_URL || (import.meta.env.PROD ? "/api" : "http://localhost:5000/api");
export const serverURL = import.meta.env.VITE_API_URL
    ? import.meta.env.VITE_API_URL.replace(/\/api$/, "")
    : "";

const API = axios.create({
    baseURL: baseURL,
    withCredentials: true,
    headers: { "X-Requested-With": "WorkPulse" },
});

// Get today's date in local timezone as YYYY-MM-DD
export function getLocalToday(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Get a date N days ago in local timezone as YYYY-MM-DD
export function getLocalDate(daysAgo = 0): string {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Attach timezone offset to every request (Auth token is sent automatically via HttpOnly cookie)
API.interceptors.request.use((config: InternalAxiosRequestConfig) => {
    if (!isElectron) NProgress.start();
    config.headers["x-timezone-offset"] = new Date().getTimezoneOffset();
    return config;
});

// NProgress bar — AxiosInterceptor component handles 401/token expiration separately
API.interceptors.response.use(
    (response) => {
        if (!isElectron) NProgress.done();
        return response;
    },
    (error) => {
        if (!isElectron) NProgress.done();
        return Promise.reject(error);
    }
);

// GIF/Sticker search via the server-side GIPHY proxy (key stays server-side).
export type GiphyMedia = { id: string; previewUrl: string; mediaUrl: string };
export const searchGiphy = (q: string, type: "gifs" | "stickers" = "gifs") =>
    API.get<{ results: GiphyMedia[] }>("/giphy/search", { params: { q, type } });
export const trendingGiphy = (type: "gifs" | "stickers" = "gifs") =>
    API.get<{ results: GiphyMedia[] }>("/giphy/trending", { params: { type } });

// Auth
export const register = (data: AnyData) => API.post("/auth/register", data);
export const login = (data: AnyData) => API.post("/auth/login", data);
export const logoutUser = () => API.post("/auth/logout");
export const refreshToken = () => API.post("/auth/refresh");
export const forgotPassword = (data: AnyData) => API.post("/auth/forgot-password", data);
export const resetPassword = (data: AnyData) => API.post("/auth/reset-password", data);

// Biometric device credentials (mobile/desktop "login with your face").
// enroll is auth-gated; login is public and exchanges the device secret for a
// session, identical to a password login.
export const biometricEnroll = (data: { platform: string; deviceLabel?: string }) =>
    API.post("/auth/biometric/enroll", data);
export const biometricLogin = (data: { credentialId: string; deviceSecret: string }) =>
    API.post("/auth/biometric/login", data);
export const listBiometricDevices = () => API.get("/auth/biometric");
export const revokeBiometricDevice = (id: string) => API.delete(`/auth/biometric/${id}`);

// Tracker
// getStatus is deduplicated: concurrent calls within the same event loop
// tick share a single HTTP request (e.g. Dashboard + WorkStateContext on mount).
// On failure, the in-flight ref is cleared so subsequent callers can retry.
let _statusInFlight: Promise<AxiosResponse> | null = null;
export const getStatus = (): Promise<AxiosResponse> => {
    if (!_statusInFlight) {
        _statusInFlight = API.get("/tracker/status").then(
            (res) => {
                _statusInFlight = null;
                return res;
            },
            (err) => {
                _statusInFlight = null;
                throw err;
            }
        );
    }
    return _statusInFlight;
};

interface ClockInPayload {
    work_mode?: string;
    latitude?: number;
    longitude?: number;
    accuracy?: number;
    face_descriptor?: number[];
}
export const clockIn = (payload?: string | ClockInPayload | null) => {
    // Backwards-compat: callers used to pass just the work_mode string.
    if (typeof payload === "string" || payload == null) {
        return API.post("/tracker/clock-in", { work_mode: payload || "office" });
    }
    return API.post("/tracker/clock-in", {
        work_mode: payload.work_mode || "office",
        latitude: payload.latitude,
        longitude: payload.longitude,
        accuracy: payload.accuracy,
        face_descriptor: payload.face_descriptor,
    });
};

// Face enrollment for attendance verification (descriptor extracted in
// browser via face-api.js — only the 128-float embedding is sent).
export const getFaceStatus = () => API.get("/profile/face-status");
export const enrollFace = (descriptor: number[]) =>
    API.post("/profile/face-enroll", { descriptor });
export const clearFaceEnrollment = () => API.delete("/profile/face-enroll");
export const breakStart = () => API.post("/tracker/break-start");
export const breakEnd = () => API.post("/tracker/break-end");
export const clockOut = () => API.post("/tracker/clock-out");
export const getHistory = (from?: string, to?: string) =>
    API.get("/tracker/history", { params: { from, to } });
export const getAnalytics = (days?: number, from?: string, to?: string) =>
    API.get("/tracker/analytics", { params: { days, from, to } });

// Manual Entry
export const addManualEntry = (data: AnyData) => API.post("/tracker/manual-entry", data);
export const updateManualEntry = (date: string, data: AnyData) =>
    API.put(`/tracker/manual-entry/${date}`, data);
export const deleteEntries = (date: string) => API.delete(`/tracker/entries/${date}`);
export const getEntries = (date: string) => API.get(`/tracker/entries/${date}`);
export const getManualEntryRequests = () => API.get("/tracker/manual-entries");

// Overtime
export const submitOvertimeRequest = (data: AnyData) =>
    API.post("/tracker/overtime-request", data);
export const getOvertimeRequests = () => API.get("/tracker/overtime-requests");

// Dashboard Widgets
export const getWidgets = () => API.get("/tracker/widgets");
export const getWeeklyChart = () => API.get("/tracker/weekly");
export const getTaskSummary = () => API.get("/tracker/task-summary");

// Theme
export const getTheme = () => API.get("/tracker/theme");
export const updateTheme = (theme: string) => API.put("/tracker/theme", { theme });

// Leaves
// The server's GET /leaves endpoint filters by `start_date` / `end_date`
// (see server/routes/leaves.js). The earlier `from` / `to` aliases were
// silently ignored, which made the manual-entry page think every date had
// a leave on it (it would pick the first leave from the unfiltered list).
export const getLeaves = (from?: string, to?: string) =>
    API.get("/leaves", {
        params: { start_date: from, end_date: to },
    });
export const addLeave = (data: AnyData) => API.post("/leaves", data);
export const addLeavesBatch = (data: AnyData) => API.post("/leaves", data);
export const deleteLeave = (id: number | string) => API.delete(`/leaves/${id}`);
export const withdrawLeave = (id: number | string) => API.post(`/leaves/${id}/withdraw`);
export const getLeaveSummary = (month?: number, year?: number) =>
    API.get("/leaves/summary", { params: { month, year } });

// Tasks
export const getTasks = (date?: string, filters?: Params, signal?: AbortSignal) => {
    const params: Params = { ...filters };
    if (date !== undefined) {
        params.date = date;
    }
    return API.get("/tasks", { params, signal });
};
export const addTask = (data: AnyData) => API.post("/tasks", data);
export const updateTaskStatus = (id: number | string, status: string) =>
    API.patch(`/tasks/${id}/status`, { status });
export const updateTask = (id: number | string, data: AnyData) => API.put(`/tasks/${id}`, data);
export const deleteTask = (id: number | string) => API.delete(`/tasks/${id}`);
export const carryForwardTasks = () => API.post("/tasks/carry-forward");
export const getAssignableUsers = () => API.get("/tasks/assignable-users");
export const getTaskLabels = () => API.get("/tasks/labels");
export const getTaskLabelsManage = () => API.get("/tasks/labels/manage");
export const createTaskLabel = (data: AnyData) => API.post("/tasks/labels", data);
export const updateTaskLabel = (id: number | string, data: AnyData) =>
    API.put(`/tasks/labels/${id}`, data);
export const deleteTaskLabel = (id: number | string) => API.delete(`/tasks/labels/${id}`);
// ── Stage 3: Projects, Git integration (GitHub OAuth), task git refs ─────
// Projects = Jira-style folders with a unique KEY (e.g. WEB). Tasks inside
// a project automatically get a per-project task_number, surfaced as
// "WEB-123" (issue_key) by the server's enrich step.
// Projects list — call without options for the legacy plain-array response,
// or pass `{ limit, offset }` to opt-in to the paginated `{ projects, pagination }`
// shape (page sizes are capped server-side).
export const getProjects = (
    includeArchived = false,
    opts: { limit?: number; offset?: number } | null = null
) => {
    const params: Params = {};
    if (includeArchived) params.include_archived = 1;
    if (opts && typeof opts === "object") {
        params.paginate = 1;
        if (opts.limit != null) params.limit = opts.limit;
        if (opts.offset != null) params.offset = opts.offset;
    }
    return API.get("/projects", { params });
};
export const getProject = (id: number | string) => API.get(`/projects/${id}`);
export const createProject = (data: AnyData) => API.post("/projects", data);
export const updateProject = (id: number | string, data: AnyData) =>
    API.put(`/projects/${id}`, data);
export const archiveProject = (id: number | string, isArchived: boolean) =>
    API.patch(`/projects/${id}/archive`, { is_archived: isArchived });
export const deleteProject = (id: number | string, { force = false }: { force?: boolean } = {}) =>
    API.delete(`/projects/${id}`, { params: force ? { force: 1 } : {} });
export const getProjectTasks = (id: number | string, params?: Params) =>
    API.get(`/projects/${id}/tasks`, { params });

// GitHub integration — OAuth flow + repo selection.
export const startGithubOAuth = () => API.post("/integrations/github/oauth/start");
export const getGithubStatus = () => API.get("/integrations/github/status");
export const listGithubRepos = () => API.get("/integrations/github/repos");
export const connectGithubRepos = (repos: unknown) =>
    API.post("/integrations/github/repos/connect", { repos });
export const disconnectGithubRepo = (fullName: string) =>
    API.delete(`/integrations/github/repos/${encodeURIComponent(fullName)}`);
export const disconnectGithub = () => API.post("/integrations/github/disconnect");
export const listIntegrations = () => API.get("/integrations");

// Git refs (branches, PRs, commits) linked to a task.
export const getTaskGitRefs = (taskId: number | string) => API.get(`/tasks/${taskId}/git`);
export const linkTaskGitRef = (taskId: number | string, data: AnyData) =>
    API.post(`/tasks/${taskId}/git`, data);
export const unlinkTaskGitRef = (taskId: number | string, refId: number | string) =>
    API.delete(`/tasks/${taskId}/git/${refId}`);

export const getTaskComments = (taskId: number | string) => API.get(`/tasks/${taskId}/comments`);
// Add a comment with optional file attachment. When a file is present we send
// multipart/form-data; otherwise a plain JSON body keeps backward compat.
export const addTaskComment = (taskId: number | string, content?: string, file?: File) => {
    if (file) {
        const fd = new FormData();
        if (content) fd.append("content", content);
        fd.append("file", file);
        return API.post(`/tasks/${taskId}/comments`, fd, {
            headers: { "Content-Type": "multipart/form-data" },
        });
    }
    return API.post(`/tasks/${taskId}/comments`, { content });
};
export const updateTaskComment = (
    taskId: number | string,
    commentId: number | string,
    content: string
) => API.put(`/tasks/${taskId}/comments/${commentId}`, { content });
export const deleteTaskComment = (taskId: number | string, commentId: number | string) =>
    API.delete(`/tasks/${taskId}/comments/${commentId}`);

// Backlog
export const getBacklog = (filters?: Params) => API.get("/tasks/backlog", { params: filters });
export const addBacklogTask = (data: AnyData) => API.post("/tasks/backlog", data);
export const scheduleTask = (id: number | string, date: string) =>
    API.patch(`/tasks/${id}/schedule`, { date });
export const unscheduleTask = (id: number | string) => API.patch(`/tasks/${id}/unschedule`);
export const getTaskDetail = (id: number | string) => API.get(`/tasks/${id}/detail`);
export const getTaskHistory = (id: number | string) => API.get(`/tasks/${id}/history`);
export const searchTasks = (q: string) => API.get("/tasks/search", { params: { q } });
export const getAvailableSprints = () => API.get("/tasks/available-sprints");
export const assignTaskToSprint = (id: number | string, sprintId: number | string) =>
    API.patch(`/tasks/${id}/assign-sprint`, { sprint_id: sprintId });

// Sprints
export const getSprints = () => API.get("/sprints");
export const getActiveSprint = () => API.get("/sprints/active");
export const createSprint = (data: AnyData) => API.post("/sprints", data);
export const updateSprint = (id: number | string, data: AnyData) => API.put(`/sprints/${id}`, data);
export const deleteSprint = (id: number | string) => API.delete(`/sprints/${id}`);
export const getSprintTasks = (id: number | string) => API.get(`/sprints/${id}/tasks`);
export const getSprintStats = (id: number | string) => API.get(`/sprints/${id}/stats`);
export const startSprint = (id: number | string) => API.post(`/sprints/${id}/start`);
export const completeSprint = (id: number | string, rolloverTo?: number | string) =>
    API.post(`/sprints/${id}/complete`, { rolloverTo });
export const pauseSprint = (id: number | string) => API.post(`/sprints/${id}/pause`);
export const resumeSprint = (id: number | string) => API.post(`/sprints/${id}/resume`);
export const getSprintCarriedOver = (id: number | string) =>
    API.get(`/sprints/${id}/carried-over`);
export const getSprintBurndown = (id: number | string) => API.get(`/sprints/${id}/burndown`);
export const getRecentVelocity = (limit?: number) =>
    API.get("/sprints/velocity/recent", { params: { limit } });
// Phase 3 — Insights endpoints
export const getSprintCumulativeFlow = (id: number | string) =>
    API.get(`/sprints/${id}/cumulative-flow`);
export const getSprintCycleTime = (id: number | string) => API.get(`/sprints/${id}/cycle-time`);
export const getSprintRetrospective = (id: number | string) =>
    API.get(`/sprints/${id}/retrospective`);
export const updateSprintRetrospective = (id: number | string, data: AnyData) =>
    API.put(`/sprints/${id}/retrospective`, data);

// Pass 2 — task dependencies, acceptance criteria, blockers
export const getTaskDependencies = (id: number | string) => API.get(`/tasks/${id}/dependencies`);
export const addTaskDependency = (
    id: number | string,
    depends_on_id: number | string,
    type: string
) => API.post(`/tasks/${id}/dependencies`, { depends_on_id, type });
export const removeTaskDependency = (id: number | string, depId: number | string) =>
    API.delete(`/tasks/${id}/dependencies/${depId}`);
export const getAcceptanceCriteria = (id: number | string) =>
    API.get(`/tasks/${id}/acceptance-criteria`);
export const updateAcceptanceCriteria = (id: number | string, criteria: unknown) =>
    API.put(`/tasks/${id}/acceptance-criteria`, { criteria });
export const setTaskBlocker = (
    id: number | string,
    is_blocked: boolean,
    blocked_reason?: string
) => API.patch(`/tasks/${id}/block`, { is_blocked, blocked_reason });
export const quicksearchTasks = (q: string) =>
    API.get("/tasks/lookup/quicksearch", { params: { q } });
export const getTaskChildren = (id: number | string) => API.get(`/tasks/${id}/children`);
export const getTaskParent = (id: number | string) => API.get(`/tasks/${id}/parent`);
export const setTaskParent = (id: number | string, parent_task_id: number | string | null) =>
    API.patch(`/tasks/${id}/parent`, { parent_task_id });

// Agile (tenant-customisable Work Item Types, Workflow States, Story Points)
export const getAgileConfig = () => API.get("/agile/config");
export const getAgileSettings = () => API.get("/agile/settings");
export const updateAgileSettings = (data: AnyData) => API.put("/agile/settings", data);
export const getWorkItemTypes = () => API.get("/agile/work-item-types");
export const createWorkItemType = (data: AnyData) => API.post("/agile/work-item-types", data);
export const updateWorkItemType = (id: number | string, data: AnyData) =>
    API.put(`/agile/work-item-types/${id}`, data);
export const deleteWorkItemType = (id: number | string) =>
    API.delete(`/agile/work-item-types/${id}`);
export const reorderWorkItemTypes = (order: unknown) =>
    API.put("/agile/work-item-types/reorder", { order });
export const getWorkflowStates = () => API.get("/agile/workflow-states");
export const createWorkflowState = (data: AnyData) => API.post("/agile/workflow-states", data);
export const updateWorkflowState = (id: number | string, data: AnyData) =>
    API.put(`/agile/workflow-states/${id}`, data);
export const deleteWorkflowState = (id: number | string) =>
    API.delete(`/agile/workflow-states/${id}`);
export const reorderWorkflowStates = (order: unknown) =>
    API.put("/agile/workflow-states/reorder", { order });
// Agile permissions are role-based — this endpoint just returns the caller's
// effective access level (canEdit + role). The previous request/grant/review
// flow was removed: edit access is granted purely by role membership in
// server/middleware/agileEditor.js#ROLES_THAT_CAN_EDIT_AGILE.
export const getAgilePermissions = () => API.get("/agile/permissions/me");

// ─── Custom Fields (Chunk 6) ───────────────────────────────────────────
// Tenant-customisable extra fields shown on every task. Definitions are
// admin-managed; values live per-task and are coerced server-side based
// on the field's declared type.
export const getCustomFields = () => API.get("/custom-fields");
export const getCustomFieldsAll = () => API.get("/custom-fields/all");
export const createCustomField = (data: AnyData) => API.post("/custom-fields", data);
export const updateCustomField = (id: number | string, data: AnyData) =>
    API.put(`/custom-fields/${id}`, data);
export const deleteCustomField = (id: number | string) => API.delete(`/custom-fields/${id}`);
export const reorderCustomFields = (order: unknown) =>
    API.put("/custom-fields/reorder", { order });
export const getTaskCustomFieldValues = (taskId: number | string) =>
    API.get(`/custom-fields/task/${taskId}`);
export const updateTaskCustomFieldValues = (taskId: number | string, values: unknown) =>
    API.put(`/custom-fields/task/${taskId}`, { values });

// Service Desk
export const getServiceDeskTickets = (params?: Params) =>
    API.get("/service-desk/tickets", { params });
export const getServiceDeskTicket = (id: number | string) =>
    API.get(`/service-desk/tickets/${id}`);
export const createServiceDeskTicket = (data: AnyData) => API.post("/service-desk/tickets", data);
export const updateServiceDeskTicket = (id: number | string, data: AnyData) =>
    API.patch(`/service-desk/tickets/${id}`, data);
export const deleteServiceDeskTicket = (id: number | string) =>
    API.delete(`/service-desk/tickets/${id}`);
export const getServiceDeskStats = () => API.get("/service-desk/stats");

// Profile
export const getProfile = (config?: AxiosRequestConfig) => API.get("/profile", config);
export const updateProfile = (data: AnyData) => API.put("/profile", data);
export const updateEmail = (email: string) => API.put("/profile/email", { email });
export const updatePassword = (data: AnyData) => API.put("/profile/password", data);
export const deleteAccount = (password: string) =>
    API.delete("/profile", { data: { password } });
export const uploadAvatar = (file: File) => {
    const formData = new FormData();
    formData.append("avatar", file);
    return API.post("/profile/avatar", formData, {
        headers: { "Content-Type": "multipart/form-data" },
    });
};
export const removeAvatar = () => API.delete("/profile/avatar");

// Notification & sound preferences
export const getNotificationPrefs = () => API.get("/profile/notification-prefs");
export const updateNotificationPrefs = (prefs: AnyData) =>
    API.put("/profile/notification-prefs", prefs);

// ==================== ENTERPRISE API ====================

// Organization
export const createOrg = (name: string) => API.post("/org", { name });
export const getCurrentOrg = () => API.get("/org/current");
export const updateOrgSettings = (data: AnyData) => API.put("/org/settings", data);
export const getOrgMembers = (params?: Params) => API.get("/org/members", { params });
export const inviteToOrg = (data: AnyData) => API.post("/org/invite", data);
export const removeMember = (userId: number | string) =>
    API.post("/org/remove-member", { user_id: userId });
export const getOrgDepartments = (params?: Params) => API.get("/org/departments", { params });
export const createDepartment = (data: AnyData) => API.post("/org/departments", data);
export const updateDepartment = (id: number | string, data: AnyData) =>
    API.put(`/org/departments/${id}`, data);
export const deleteDepartment = (id: number | string) => API.delete(`/org/departments/${id}`);
export const getOrgTeams = (params?: Params) => API.get("/org/teams", { params });
export const createTeam = (data: AnyData) => API.post("/org/teams", data);
export const updateTeam = (id: number | string, data: AnyData) => API.put(`/org/teams/${id}`, data);
export const deleteTeam = (id: number | string) => API.delete(`/org/teams/${id}`);
export const getTeamSprintConfig = (teamId: number | string) =>
    API.get(`/org/teams/${teamId}/sprint-config`);
export const updateTeamSprintConfig = (teamId: number | string, data: AnyData) =>
    API.put(`/org/teams/${teamId}/sprint-config`, data);
export const getOrgChart = (params?: Params) => API.get("/org/chart", { params });

// Custom Roles (tenant-defined roles with permission_level 1..4)
export const getOrgRoles = (params?: Params) => API.get("/org/roles", { params });
export const createOrgRole = (data: AnyData) => API.post("/org/roles", data);
export const updateOrgRole = (roleKey: string, data: AnyData) =>
    API.patch(`/org/roles/${roleKey}`, data);
export const deleteOrgRole = (roleKey: string, params?: Params) =>
    API.delete(`/org/roles/${roleKey}`, { params });

// Admin
export const getAdminOrganizations = () => API.get("/admin/organizations");
export const getAdminOrganization = (id: number | string) =>
    API.get(`/admin/organizations/${id}`);
export const createAdminOrganization = (data: AnyData) => API.post("/admin/organizations", data);
export const updateAdminOrganization = (id: number | string, data: AnyData) =>
    API.put(`/admin/organizations/${id}`, data);
export const deleteAdminOrganization = (id: number | string) =>
    API.delete(`/admin/organizations/${id}`);
export const getAdminUsers = (params?: Params) => API.get("/admin/users", { params });
export const getAdminUser = (id: number | string) => API.get(`/admin/users/${id}`);
export const createAdminUser = (data: AnyData) => API.post("/admin/users", data);
export const updateUserRole = (id: number | string, role: string, reason?: string) =>
    API.put(`/admin/users/${id}/role`, { role, reason });
export const updateUserAssignment = (id: number | string, data: AnyData) =>
    API.put(`/admin/users/${id}/assignment`, data);
export const toggleUserActive = (id: number | string) =>
    API.put(`/admin/users/${id}/deactivate`);
export const deleteAdminUser = (id: number | string) => API.delete(`/admin/users/${id}`);
export const adminResetPassword = (id: number | string, password: string) =>
    API.post(`/admin/users/${id}/reset-password`, { new_password: password });
export const getRoleChangeRequests = (params?: Params) =>
    API.get("/admin/role-requests", { params });
export const approveRoleChange = (id: number | string) =>
    API.post(`/admin/role-requests/${id}/approve`);
export const rejectRoleChange = (id: number | string, reason?: string) =>
    API.post(`/admin/role-requests/${id}/reject`, { reject_reason: reason });
export const cancelRoleChange = (id: number | string) =>
    API.post(`/admin/role-requests/${id}/cancel`);
export const getAuditLogs = (params?: Params) => API.get("/admin/audit-logs", { params });
export const getAdminStats = () => API.get("/admin/stats");
export const getRegistrationSettings = () => API.get("/admin/registration-settings");
export const updateRegistrationSettings = (mode: string) =>
    API.put("/admin/registration-settings", { mode });
export const getInviteCodes = () => API.get("/admin/invite-codes");
export const createInviteCode = (data: AnyData) => API.post("/admin/invite-codes", data);
export const deactivateInviteCode = (id: number | string) =>
    API.delete(`/admin/invite-codes/${id}`);
export const getRegistrationMode = () => API.get("/auth/registration-mode");
export const getAdminTaskLabels = () => API.get("/admin/task-labels");
export const createAdminTaskLabel = (data: AnyData) => API.post("/admin/task-labels", data);
export const updateAdminTaskLabel = (id: number | string, data: AnyData) =>
    API.put(`/admin/task-labels/${id}`, data);
export const deleteAdminTaskLabel = (id: number | string) =>
    API.delete(`/admin/task-labels/${id}`);
export const getAdminAnnouncements = () => API.get("/admin/announcements");
export const createAnnouncement = (data: AnyData) => API.post("/admin/announcements", data);
export const updateAnnouncement = (id: number | string, data: AnyData) =>
    API.put(`/admin/announcements/${id}`, data);
export const deleteAnnouncement = (id: number | string) =>
    API.delete(`/admin/announcements/${id}`);

// ─── Platform-Access (consent-gated impersonation) ────────────────────────
// Platform-side (the inspector — runs while authenticated as platform_admin):
export const createTenantAccessRequest = (tenantId: number | string, data: AnyData) =>
    API.post(`/admin/tenants/${tenantId}/access-requests`, data);
export const listMyAccessRequests = (params?: Params) =>
    API.get("/admin/tenants/access-requests", { params });
export const listTenantAccessRequests = (tenantId: number | string) =>
    API.get(`/admin/tenants/${tenantId}/access-requests`);
export const cancelAccessRequest = (id: number | string) =>
    API.delete(`/admin/tenants/access-requests/${id}`);
export const getImpersonationPolicy = () => API.get("/admin/tenants/impersonation-policy");
export const updateImpersonationPolicy = (data: AnyData) =>
    API.put("/admin/tenants/impersonation-policy", data);

// Tenant-side (the approver — runs while authenticated as super_admin):
export const listIncomingAccessRequests = (params?: Params) =>
    API.get("/platform-access", { params });
export const approveAccessRequest = (id: number | string) =>
    API.post(`/platform-access/${id}/approve`);
export const denyAccessRequest = (id: number | string, reason?: string) =>
    API.post(`/platform-access/${id}/deny`, { reason });
export const revokeAccessSession = (id: number | string, reason?: string) =>
    API.post(`/platform-access/${id}/revoke`, { reason });
export const getActiveInspectorSession = () => API.get("/platform-access/active-session");

// Tenant Management (platform_admin)
export const getTenants = (params?: Params) => API.get("/admin/tenants", { params });
export const getTenantOverview = () => API.get("/admin/tenants/overview");
export const getTenant = (id: number | string) => API.get(`/admin/tenants/${id}`);
export const createTenant = (data: AnyData) => API.post("/admin/tenants", data);
export const updateTenant = (id: number | string, data: AnyData) =>
    API.put(`/admin/tenants/${id}`, data);
export const suspendTenant = (id: number | string, reason?: string, password?: string) =>
    API.put(`/admin/tenants/${id}/suspend`, { reason, password });
export const reactivateTenant = (id: number | string) =>
    API.put(`/admin/tenants/${id}/reactivate`);
export const deleteTenantApi = (id: number | string, hard?: boolean, password?: string) =>
    API.delete(`/admin/tenants/${id}`, { params: { hard }, data: { password } });
export const getTenantStats = (id: number | string) => API.get(`/admin/tenants/${id}/stats`);
export const updateTenantDomain = (id: number | string, domain: string) =>
    API.put(`/admin/tenants/${id}/domain`, { custom_domain: domain });
export const updateTenantFeatures = (id: number | string, features: unknown) =>
    API.put(`/admin/tenants/${id}/features`, { features });
export const updateTenantLimits = (id: number | string, limits: AnyData) =>
    API.put(`/admin/tenants/${id}/limits`, limits);
// The consent-gated flow needs to send { approval_code, password, break_glass }
// in the body. The old single-argument signature dropped the body silently,
// which made every modal submission hit the server with no password and
// fail with 400 REAUTH_REQUIRED.
export const impersonateTenant = (id: number | string, body?: AnyData) =>
    API.post(`/admin/tenants/${id}/impersonate`, body || {});
export const exitImpersonation = (id: number | string) =>
    API.post(`/admin/tenants/${id}/exit-impersonate`);
export const getImpersonationSession = (id: number | string) =>
    API.get(`/admin/tenants/${id}/impersonation-session`);
export const getTenantUsers = (id: number | string, params?: Params) =>
    API.get(`/admin/tenants/${id}/users`, { params });
export const createTenantUser = (id: number | string, data: AnyData) =>
    API.post(`/admin/tenants/${id}/users`, data);
export const deactivateTenantUser = (tenantId: number | string, userId: number | string) =>
    API.put(`/admin/tenants/${tenantId}/users/${userId}/deactivate`);
export const seedTenant = (id: number | string) => API.post(`/admin/tenants/${id}/seed`);
export const getPlatformAuditLogs = (params?: Params) =>
    API.get("/admin/tenants/audit-logs", { params });
export const getPlanCatalog = () => API.get("/admin/tenants/plan-catalog");
export const updatePlanCatalog = (plans: unknown) =>
    API.put("/admin/tenants/plan-catalog", { plans });
export const resetPlanCatalog = () => API.post("/admin/tenants/plan-catalog/reset");
export const updateTenantPlan = (
    id: number | string,
    plan: string,
    applyPlanLimits?: boolean
) => API.put(`/admin/tenants/${id}/plan`, { plan, apply_plan_limits: applyPlanLimits });

// Platform Admin Management (platform_admin)
export const getPlatformUsers = () => API.get("/admin/tenants/platform-users");
export const createPlatformUser = (data: AnyData) =>
    API.post("/admin/tenants/platform-users", data);
export const deactivatePlatformUser = (id: number | string) =>
    API.put(`/admin/tenants/platform-users/${id}/deactivate`);
export const resetPlatformUserPassword = (id: number | string, new_password: string) =>
    API.post(`/admin/tenants/platform-users/${id}/reset-password`, { new_password });

// Platform Configuration (platform_admin)
export const getPlatformConfig = () => API.get("/admin/tenants/platform-config");
export const updatePlatformConfig = (data: AnyData) =>
    API.put("/admin/tenants/platform-config", data);
export const getTenantAlerts = () => API.get("/admin/tenants/alerts");

// Manager Dashboard
export const getTeamAttendance = (date?: string) =>
    API.get("/manager/team-attendance", { params: { date } });
export const getTeamAnalytics = (days?: number, from?: string, to?: string) =>
    API.get("/manager/team-analytics", { params: { days, from, to } });
export const getApprovals = (params?: Params) => API.get("/manager/approvals", { params });
export const getMyRequests = (params?: Params) => API.get("/manager/my-requests", { params });
export const approveRequest = (id: number | string) =>
    API.post(`/manager/approvals/${id}/approve`);
export const rejectRequest = (id: number | string, reason?: string) =>
    API.post(`/manager/approvals/${id}/reject`, { reject_reason: reason });
export const bulkApproval = (ids: unknown, action: string, reason?: string) =>
    API.post("/manager/approvals/bulk", { ids, action, reject_reason: reason });
export const getMemberHours = (userId: number | string, from?: string, to?: string) =>
    API.get(`/manager/member/${userId}/hours`, { params: { from, to } });
export const getMemberTasks = (userId: number | string, date?: string) =>
    API.get(`/manager/member/${userId}/tasks`, { params: { date } });
export const getMemberLeaves = (userId: number | string, from?: string, to?: string) =>
    API.get(`/manager/member/${userId}/leaves`, { params: { from, to } });
export const getMemberRequests = (userId: number | string) =>
    API.get(`/manager/member/${userId}/requests`);
export const getMemberOverview = (userId: number | string) =>
    API.get(`/manager/member/${userId}/overview`);

// Leave Policy
export const getLeavePolicies = () => API.get("/leave-policy/policies");
export const saveLeavePolicyAPI = (data: AnyData) => API.post("/leave-policy/policies", data);
export const deleteLeavePolicyAPI = (id: number | string) =>
    API.delete(`/leave-policy/policies/${id}`);
export const getLeaveBalances = (year?: number) =>
    API.get("/leave-policy/balances", { params: { year } });
export const getUserLeaveBalances = (userId: number | string, year?: number) =>
    API.get(`/leave-policy/balances/${userId}`, { params: { year } });
export const updateLeaveBalance = (userId: number | string, data: AnyData) =>
    API.put(`/leave-policy/balances/${userId}`, data);
export const getHolidays = (year?: number) =>
    API.get("/leave-policy/holidays", { params: { year } });
export const addHoliday = (data: AnyData) => API.post("/leave-policy/holidays", data);
export const addHolidaysBatch = (holidays: unknown) =>
    API.post("/leave-policy/holidays/batch", { holidays });
export const deleteHoliday = (id: number | string) => API.delete(`/leave-policy/holidays/${id}`);

// Notes
export const getNotes = () => API.get("/notes");
export const saveNotes = (data: AnyData) => API.put("/notes", { data });
export const getPageHistory = (pageId: string) =>
    API.get(`/notes/history/${encodeURIComponent(pageId)}`);
export const getHistorySnapshot = (snapshotId: number | string) =>
    API.get(`/notes/history/snapshot/${snapshotId}`);
export const getMentionableUsers = () => API.get("/notes/mentionable-users");
export const sendNoteMention = (
    mentionedUserId: number | string,
    pageId: string,
    pageTitle: string
) => API.post("/notes/mention", { mentionedUserId, pageId, pageTitle });

// Notes — Tier 6 integrations
export const getNoteLinks = (pageId: string) =>
    API.get(`/notes/links/${encodeURIComponent(pageId)}`);
export const addNoteLink = (pageId: string, entityType: string, entityId: number | string) =>
    API.post("/notes/links", { pageId, entityType, entityId });
export const removeNoteLink = (pageId: string, entityType: string, entityId: number | string) =>
    API.delete("/notes/links", { data: { pageId, entityType, entityId } });
export const getDailyPrefill = () => API.get("/notes/daily-prefill");
export const getOneOnOnePrefill = (userId: number | string) =>
    API.get(`/notes/oneonone-prefill/${userId}`);
export const getTimeSummary = () => API.get("/notes/time-summary");
export const convertToTask = (title: string, pageId: string, pageTitle: string) =>
    API.post("/notes/convert-to-task", { title, pageId, pageTitle });
export const getSprintEmbed = () => API.get("/notes/sprint-embed");
export const searchNoteTasks = (q: string) => API.get("/notes/search-tasks", { params: { q } });
export const searchNoteMeetings = (q: string) =>
    API.get("/notes/search-meetings", { params: { q } });
export const searchNoteEvents = (q: string) => API.get("/notes/search-events", { params: { q } });
export const getDirectReports = () => API.get("/notes/direct-reports");

// Public note share links (Chunk 5)
export const getNoteShare = (pageId: string) =>
    API.get(`/notes/share/${encodeURIComponent(pageId)}`);
export const createNoteShare = (pageId: string) =>
    API.post(`/notes/share/${encodeURIComponent(pageId)}`);
export const revokeNoteShare = (pageId: string) =>
    API.delete(`/notes/share/${encodeURIComponent(pageId)}`);
// Public read-only note viewer — uses a separate axios instance with no
// CSRF header / no credentials, so it works anonymously.
export const getPublicNote = (token: string) =>
    axios.get(`${baseURL}/public/notes/${encodeURIComponent(token)}`);

// Calendar
export const getCalendarEvents = (from?: string, to?: string) =>
    API.get("/calendar", { params: { from, to } });
export const createCalendarEvent = (data: AnyData) => API.post("/calendar", data);
export const updateCalendarEvent = (id: number | string, data: AnyData) =>
    API.put(`/calendar/${id}`, data);
export const deleteCalendarEvent = (id: number | string) => API.delete(`/calendar/${id}`);

// Notifications
export const getNotifications = () => API.get("/notifications");
export const markNotificationRead = (id: number | string) =>
    API.post(`/notifications/${id}/read`);
export const markAllNotificationsRead = () => API.post("/notifications/read-all");
export const deleteNotification = (id: number | string) => API.delete(`/notifications/${id}`);
export const getActiveAnnouncements = () => API.get("/notifications/announcements");

// Export
export const exportMyAnalytics = (params?: Params) =>
    API.get("/export/my-analytics", { params, responseType: "blob" });
export const exportMyLeaves = (params?: Params) =>
    API.get("/export/my-leaves", { params, responseType: "blob" });
export const exportMyTasks = (params?: Params) =>
    API.get("/export/my-tasks", { params, responseType: "blob" });
export const exportTeamAnalytics = (params?: Params) =>
    API.get("/export/team-analytics", { params, responseType: "blob" });
export const exportTeamLeaves = (params?: Params) =>
    API.get("/export/team-leaves", { params, responseType: "blob" });
export const exportPayrollHours = (from?: string, to?: string, format = "csv") =>
    API.get("/export/payroll-hours", { params: { from, to, format }, responseType: "blob" });

// Global Search
export const globalSearch = (q: string, signal?: AbortSignal) =>
    API.get("/search", { params: { q }, ...(signal && { signal }) });

// Pay Periods
export const getPayPeriods = () => API.get("/admin/pay-periods");
export const createPayPeriod = (data: AnyData) => API.post("/admin/pay-periods", data);
export const deletePayPeriod = (id: number | string) => API.delete(`/admin/pay-periods/${id}`);

// Compensation Templates
export const getCompensationTemplates = () => API.get("/compensation/templates");
export const createCompensationTemplate = (data: AnyData) =>
    API.post("/compensation/templates", data);
export const updateCompensationTemplate = (id: number | string, data: AnyData) =>
    API.put(`/compensation/templates/${id}`, data);
export const deleteCompensationTemplate = (id: number | string) =>
    API.delete(`/compensation/templates/${id}`);

// Employee Compensation
export const getEmployeeCompensations = () => API.get("/compensation/employees");
export const getEmployeeCompensation = (userId: number | string) =>
    API.get(`/compensation/employees/${userId}`);
export const assignCompensation = (userId: number | string, data: AnyData) =>
    API.post(`/compensation/employees/${userId}`, data);
export const updateCompensation = (
    userId: number | string,
    id: number | string,
    data: AnyData
) => API.put(`/compensation/employees/${userId}/${id}`, data);

// Salary Slips (HR Admin)
export const runPayroll = (data: AnyData) => API.post("/compensation/payroll-run", data);
export const getSalarySlips = (params?: Params) =>
    API.get("/compensation/salary-slips", { params });
export const getSalarySlip = (id: number | string) =>
    API.get(`/compensation/salary-slips/${id}`);
export const publishSalarySlip = (id: number | string) =>
    API.put(`/compensation/salary-slips/${id}/publish`);
export const bulkPublishSlips = (data: AnyData) =>
    API.post("/compensation/salary-slips/bulk-publish", data);
export const downloadSalarySlipPdf = (id: number | string) =>
    API.get(`/compensation/salary-slips/${id}/pdf`, { responseType: "blob" });

// Salary Slips (Employee Self-Service)
export const getMySalarySlips = () => API.get("/compensation/my-slips");
export const downloadMySalarySlipPdf = (id: number | string) =>
    API.get(`/compensation/my-slips/${id}/pdf`, { responseType: "blob" });

// Disbursement
export const disburseSalaries = (data: AnyData) => API.post("/compensation/disburse", data);
export const disburseSingle = (slipId: number | string) =>
    API.post(`/compensation/disburse/${slipId}`);
export const getDisbursements = (params?: Params) =>
    API.get("/compensation/disbursements", { params });
export const retryDisbursement = (id: number | string) =>
    API.post(`/compensation/disburse/retry/${id}`);

// Payment Config
export const getPaymentConfig = () => API.get("/compensation/payment-config");
export const savePaymentConfig = (data: AnyData) =>
    API.put("/compensation/payment-config", data);
export const testPaymentConfig = () => API.post("/compensation/payment-config/test");

// Employee Bank Details
export const getOrgBankDetails = () => API.get("/compensation/bank-details");
export const getEmployeeBankDetails = (userId: number | string) =>
    API.get(`/compensation/bank-details/${userId}`);
export const saveEmployeeBankDetails = (userId: number | string, data: AnyData) =>
    API.post(`/compensation/bank-details/${userId}`, data);
export const verifyBankDetails = (userId: number | string) =>
    API.post(`/compensation/bank-details/${userId}/verify`);
export const getMyBankDetails = () => API.get("/compensation/my-bank-details");
export const saveMyBankDetails = (data: AnyData) =>
    API.post("/compensation/my-bank-details", data);
export const getBankVerifications = () => API.get("/compensation/bank-verifications");
export const approveBankDetails = (userId: number | string) =>
    API.post(`/compensation/bank-details/${userId}/approve`);
export const rejectBankDetails = (userId: number | string) =>
    API.post(`/compensation/bank-details/${userId}/reject`);

// CTC Config
export const getCtcConfig = () => API.get("/compensation/ctc-config");
export const saveCtcConfig = (data: AnyData) => API.put("/compensation/ctc-config", data);

// Bulk User Import
export const importUsers = (payload: AnyData, isFile = false) => {
    if (isFile) {
        return API.post("/admin/users/import", payload, {
            headers: { "Content-Type": "multipart/form-data" },
        });
    }
    return API.post("/admin/users/import", payload);
};

// Chat
export const searchChatUsers = (q: string) => API.get("/chat/search", { params: { q } });
export const getPresence = (userIds: (number | string)[]) =>
    API.get("/chat/presence", { params: { userIds: userIds.join(",") } });
export const getUserStatus = () => API.get("/chat/status");
// PR7: removed `updateUserStatus` (PUT /chat/status). The v2 client uses
// `client/src/status/api.js` → setMyStatus (PUT /api/me/status) instead.
export const getConversations = () => API.get("/chat/conversations");
export const createConversation = (userId: number | string) =>
    API.post("/chat/conversations", { userId });
export const createGroup = (name: string, userIds: (number | string)[]) =>
    API.post("/chat/conversations/group", { name, userIds });
export const updateGroup = (convId: number | string, data: AnyData) =>
    API.put(`/chat/conversations/${convId}/group`, data);
export const getMembers = (convId: number | string) =>
    API.get(`/chat/conversations/${convId}/members`);
export const getMessages = (convId: number | string, before?: string) =>
    API.get(`/chat/conversations/${convId}/messages`, { params: { before } });
export const markConversationRead = (convId: number | string) =>
    API.post(`/chat/conversations/${convId}/read`);
export const getReadStatus = (convId: number | string) =>
    API.get(`/chat/conversations/${convId}/read-status`);
export const uploadChatFile = (
    convId: number | string,
    formData: FormData,
    opts?: {
        signal?: AbortSignal;
        onUploadProgress?: (evt: { loaded: number; total?: number }) => void;
    },
) =>
    API.post(`/chat/conversations/${convId}/files`, formData, {
        headers: { "Content-Type": "multipart/form-data" },
        signal: opts?.signal,
        onUploadProgress: opts?.onUploadProgress as
            | ((progressEvent: unknown) => void)
            | undefined,
    });
export const cancelChatMediaJob = (mediaJobId: number | string) =>
    API.post(`/chat/media-jobs/${mediaJobId}/cancel`);
export const retryChatMediaJob = (mediaJobId: number | string) =>
    API.post(`/chat/media-jobs/${mediaJobId}/retry`);
export const toggleReaction = (msgId: number | string, emoji: string) =>
    API.post(`/chat/messages/${msgId}/reactions`, { emoji });
export const editMessage = (msgId: number | string, content: string) =>
    API.put(`/chat/messages/${msgId}`, { content });
export const deleteMessage = (msgId: number | string) => API.delete(`/chat/messages/${msgId}`);
export const togglePin = (msgId: number | string) => API.post(`/chat/messages/${msgId}/pin`);
export const markMessageViewed = (msgId: number | string) =>
    API.post<{ fileUrl?: string; viewed?: boolean }>(`/chat/messages/${msgId}/view`);
export const getPinnedMessages = (convId: number | string) =>
    API.get(`/chat/conversations/${convId}/pinned`);
export const searchMessages = (q: string, convId?: number | string) =>
    API.get("/chat/search-messages", { params: { q, convId } });
export const forwardMessage = (msgId: number | string, conversationIds: (number | string)[]) =>
    API.post(`/chat/messages/${msgId}/forward`, { conversationIds });
export const toggleStar = (msgId: number | string) => API.post(`/chat/messages/${msgId}/star`);
export const getStarredMessages = () => API.get("/chat/starred");
export const createPoll = (convId: number | string, data: AnyData) =>
    API.post(`/chat/conversations/${convId}/polls`, data);
export const votePoll = (pollId: number | string, optionIdx: number) =>
    API.post(`/chat/polls/${pollId}/vote`, { optionIdx });
export const getPoll = (pollId: number | string) => API.get(`/chat/polls/${pollId}`);
export const getSharedFiles = (convId: number | string) =>
    API.get(`/chat/conversations/${convId}/files`);
export const ackDelivered = (msgId: number | string) =>
    API.post(`/chat/messages/${msgId}/delivered`);
export const deleteConversation = (convId: number | string) =>
    API.delete(`/chat/conversations/${convId}`);
export const clearChat = (convId: number | string) =>
    API.delete(`/chat/conversations/${convId}/messages`);
export const togglePinConversation = (convId: number | string) =>
    API.post(`/chat/conversations/${convId}/pin`);
export const toggleFavouriteConversation = (convId: number | string) =>
    API.post(`/chat/conversations/${convId}/favourite`);
export const getCallHistory = (convId: number | string) =>
    API.get(`/chat/conversations/${convId}/calls`);
export const getAllCallHistory = () => API.get("/chat/calls");
export const getActiveCall = () => API.get("/chat/calls/active");
export const getIceConfig = () => API.get("/chat/ice-config");

// Meetings
export const createMeeting = (data: AnyData) => API.post("/meetings", data);
export const checkMeetingConflicts = (data: AnyData) =>
    API.post("/meetings/check-conflicts", data);
export const getMyMeetings = (params?: Params) => API.get("/meetings", { params });
export const getMeeting = (code: string) => API.get(`/meetings/${code}`);
export const updateMeeting = (id: number | string, data: AnyData) =>
    API.put(`/meetings/${id}`, data);
export const cancelMeeting = (id: number | string) => API.delete(`/meetings/${id}`);
export const getMeetingParticipants = (id: number | string) =>
    API.get(`/meetings/${id}/participants`);
export const addMeetingParticipant = (id: number | string, userId: number | string) =>
    API.post(`/meetings/${id}/participants`, { user_id: userId });
export const removeMeetingParticipant = (id: number | string, userId: number | string) =>
    API.delete(`/meetings/${id}/participants/${userId}`);
// Fetch the persisted in-meeting chat history for the meeting's conversation.
// Used by useMeetingState to re-hydrate the chat panel on join/rejoin so
// messages don't appear lost after a refresh or after leaving + rejoining
// during the same session.
export const getMeetingMessages = (code: string, limit = 200) =>
    API.get(`/meetings/${code}/messages`, { params: { limit } });

// Meeting HLS broadcast (videosdk-hls-style large-meeting mode)
export const startMeetingHlsBroadcast = (code: string) => API.post(`/meetings/${code}/hls/start`);
export const stopMeetingHlsBroadcast = (code: string, broadcastId: number | string) =>
    API.post(`/meetings/${code}/hls/stop`, { broadcastId });
export const getMeetingHlsStatus = (code: string) => API.get(`/meetings/${code}/hls/status`);

// ─── Branding & email templates (Chunk 3) ───────────────────────────────
// `getBranding` is GET-only and is also called by the unauthenticated
// AuthContext bootstrap on first load to apply the org accent + logo before
// the user is even authenticated; the server only allows it for
// authenticated org members so it returns 401 pre-login (which we handle).
export const getBranding = () => API.get("/branding");
// Public branding (no auth) — used to theme the login / register pages with
// the org's accent color before the user signs in. Returns nulls on the
// master / default domain so callers can safely fall back to defaults.
export const getPublicBranding = (slug?: string) =>
    API.get("/public/branding", slug ? { params: { slug } } : undefined);
export const updateBrandingAccent = (accent_color: string) =>
    API.put("/branding", { accent_color });
export const uploadBrandingLogo = (file: File) => {
    const fd = new FormData();
    fd.append("logo", file);
    return API.post("/branding/logo", fd, {
        headers: { "Content-Type": "multipart/form-data" },
    });
};
export const deleteBrandingLogo = () => API.delete("/branding/logo");
export const getEmailTemplates = () => API.get("/branding/email-templates");
export const updateEmailTemplate = (key: string, data: AnyData) =>
    API.put(`/branding/email-templates/${encodeURIComponent(key)}`, data);
export const revertEmailTemplate = (key: string) =>
    API.delete(`/branding/email-templates/${encodeURIComponent(key)}`);
export const previewEmailTemplate = (key: string, data?: AnyData) =>
    API.post(`/branding/email-templates/${encodeURIComponent(key)}/preview`, data || {});

export default API;