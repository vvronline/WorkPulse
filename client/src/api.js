import axios from 'axios';
import NProgress from 'nprogress';
import 'nprogress/nprogress.css';

NProgress.configure({ showSpinner: false });

// Disable NProgress loading bar in Electron desktop app
const isElectron = !!import.meta.env.VITE_ELECTRON;
// Desktop (Electron) builds set VITE_API_URL to the Railway server; web builds use relative /api
export const baseURL = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '/api' : 'http://localhost:5000/api');
export const serverURL = import.meta.env.VITE_API_URL ? import.meta.env.VITE_API_URL.replace(/\/api$/, '') : '';

const API = axios.create({
    baseURL: baseURL,
    withCredentials: true,
    headers: { 'X-Requested-With': 'WorkPulse' }
});

// Get today's date in local timezone as YYYY-MM-DD
export function getLocalToday() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Get a date N days ago in local timezone as YYYY-MM-DD
export function getLocalDate(daysAgo = 0) {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Attach timezone offset to every request (Auth token is sent automatically via HttpOnly cookie)
API.interceptors.request.use(config => {
    if (!isElectron) NProgress.start();
    config.headers['x-timezone-offset'] = new Date().getTimezoneOffset();
    return config;
});

// NProgress bar — AxiosInterceptor component handles 401/token expiration separately
API.interceptors.response.use(
    response => {
        if (!isElectron) NProgress.done();
        return response;
    },
    error => {
        if (!isElectron) NProgress.done();
        return Promise.reject(error);
    }
);

// Auth
export const register = (data) => API.post('/auth/register', data);
export const login = (data) => API.post('/auth/login', data);
export const logoutUser = () => API.post('/auth/logout');
export const refreshToken = () => API.post('/auth/refresh');
export const forgotPassword = (data) => API.post('/auth/forgot-password', data);
export const resetPassword = (data) => API.post('/auth/reset-password', data);

// Tracker
// getStatus is deduplicated: concurrent calls within the same event loop
// tick share a single HTTP request (e.g. Dashboard + WorkStateContext on mount).
// On failure, the in-flight ref is cleared so subsequent callers can retry.
let _statusInFlight = null;
export const getStatus = () => {
    if (!_statusInFlight) {
        _statusInFlight = API.get('/tracker/status').then(
            res => { _statusInFlight = null; return res; },
            err => { _statusInFlight = null; throw err; },
        );
    }
    return _statusInFlight;
};
export const clockIn = (workMode) => API.post('/tracker/clock-in', { work_mode: workMode || 'office' });
export const breakStart = () => API.post('/tracker/break-start');
export const breakEnd = () => API.post('/tracker/break-end');
export const clockOut = () => API.post('/tracker/clock-out');
export const getHistory = (from, to) => API.get('/tracker/history', { params: { from, to } });
export const getAnalytics = (days) => API.get('/tracker/analytics', { params: { days } });

// Manual Entry
export const addManualEntry = (data) => API.post('/tracker/manual-entry', data);
export const updateManualEntry = (date, data) => API.put(`/tracker/manual-entry/${date}`, data);
export const deleteEntries = (date) => API.delete(`/tracker/entries/${date}`);
export const getEntries = (date) => API.get(`/tracker/entries/${date}`);
export const getManualEntryRequests = () => API.get('/tracker/manual-entries');

// Overtime
export const submitOvertimeRequest = (data) => API.post('/tracker/overtime-request', data);
export const getOvertimeRequests = () => API.get('/tracker/overtime-requests');

// Dashboard Widgets
export const getWidgets = () => API.get('/tracker/widgets');
export const getWeeklyChart = () => API.get('/tracker/weekly');
export const getTaskSummary = () => API.get('/tracker/task-summary');

// Theme
export const getTheme = () => API.get('/tracker/theme');
export const updateTheme = (theme) => API.put('/tracker/theme', { theme });

// Leaves
// The server's GET /leaves endpoint filters by `start_date` / `end_date`
// (see server/routes/leaves.js). The earlier `from` / `to` aliases were
// silently ignored, which made the manual-entry page think every date had
// a leave on it (it would pick the first leave from the unfiltered list).
export const getLeaves = (from, to) => API.get('/leaves', {
    params: { start_date: from, end_date: to },
});
export const addLeave = (data) => API.post('/leaves', data);
export const addLeavesBatch = (data) => API.post('/leaves', data);
export const deleteLeave = (id) => API.delete(`/leaves/${id}`);
export const withdrawLeave = (id) => API.post(`/leaves/${id}/withdraw`);
export const getLeaveSummary = (month, year) => API.get('/leaves/summary', { params: { month, year } });

// Tasks
export const getTasks = (date, filters, signal) => {
    const params = { ...filters };
    if (date !== undefined) {
        params.date = date;
    }
    return API.get('/tasks', { params, signal });
};
export const addTask = (data) => API.post('/tasks', data);
export const updateTaskStatus = (id, status) => API.patch(`/tasks/${id}/status`, { status });
export const updateTask = (id, data) => API.put(`/tasks/${id}`, data);
export const deleteTask = (id) => API.delete(`/tasks/${id}`);
export const carryForwardTasks = () => API.post('/tasks/carry-forward');
export const getAssignableUsers = () => API.get('/tasks/assignable-users');
export const getTaskLabels = () => API.get('/tasks/labels');
export const getTaskLabelsManage = () => API.get('/tasks/labels/manage');
export const createTaskLabel = (data) => API.post('/tasks/labels', data);
export const updateTaskLabel = (id, data) => API.put(`/tasks/labels/${id}`, data);
export const deleteTaskLabel = (id) => API.delete(`/tasks/labels/${id}`);
export const getTaskComments = (taskId) => API.get(`/tasks/${taskId}/comments`);
export const addTaskComment = (taskId, content) => API.post(`/tasks/${taskId}/comments`, { content });
export const updateTaskComment = (taskId, commentId, content) => API.put(`/tasks/${taskId}/comments/${commentId}`, { content });
export const deleteTaskComment = (taskId, commentId) => API.delete(`/tasks/${taskId}/comments/${commentId}`);

// Backlog
export const getBacklog = (filters) => API.get('/tasks/backlog', { params: filters });
export const addBacklogTask = (data) => API.post('/tasks/backlog', data);
export const scheduleTask = (id, date) => API.patch(`/tasks/${id}/schedule`, { date });
export const unscheduleTask = (id) => API.patch(`/tasks/${id}/unschedule`);
export const getTaskDetail = (id) => API.get(`/tasks/${id}/detail`);
export const getTaskHistory = (id) => API.get(`/tasks/${id}/history`);
export const searchTasks = (q) => API.get('/tasks/search', { params: { q } });
export const getAvailableSprints = () => API.get('/tasks/available-sprints');
export const assignTaskToSprint = (id, sprintId) => API.patch(`/tasks/${id}/assign-sprint`, { sprint_id: sprintId });

// Sprints
export const getSprints = () => API.get('/sprints');
export const getActiveSprint = () => API.get('/sprints/active');
export const createSprint = (data) => API.post('/sprints', data);
export const updateSprint = (id, data) => API.put(`/sprints/${id}`, data);
export const deleteSprint = (id) => API.delete(`/sprints/${id}`);
export const getSprintTasks = (id) => API.get(`/sprints/${id}/tasks`);
export const getSprintStats = (id) => API.get(`/sprints/${id}/stats`);
export const startSprint = (id) => API.post(`/sprints/${id}/start`);
export const completeSprint = (id, rolloverTo) => API.post(`/sprints/${id}/complete`, { rolloverTo });
export const getSprintBurndown = (id) => API.get(`/sprints/${id}/burndown`);
export const getRecentVelocity = (limit) => API.get('/sprints/velocity/recent', { params: { limit } });
// Phase 3 — Insights endpoints
export const getSprintCumulativeFlow = (id) => API.get(`/sprints/${id}/cumulative-flow`);
export const getSprintCycleTime = (id) => API.get(`/sprints/${id}/cycle-time`);
export const getSprintRetrospective = (id) => API.get(`/sprints/${id}/retrospective`);
export const updateSprintRetrospective = (id, data) => API.put(`/sprints/${id}/retrospective`, data);

// Pass 2 — task dependencies, acceptance criteria, blockers
export const getTaskDependencies = (id) => API.get(`/tasks/${id}/dependencies`);
export const addTaskDependency = (id, depends_on_id, type) => API.post(`/tasks/${id}/dependencies`, { depends_on_id, type });
export const removeTaskDependency = (id, depId) => API.delete(`/tasks/${id}/dependencies/${depId}`);
export const getAcceptanceCriteria = (id) => API.get(`/tasks/${id}/acceptance-criteria`);
export const updateAcceptanceCriteria = (id, criteria) => API.put(`/tasks/${id}/acceptance-criteria`, { criteria });
export const setTaskBlocker = (id, is_blocked, blocked_reason) => API.patch(`/tasks/${id}/block`, { is_blocked, blocked_reason });
export const quicksearchTasks = (q) => API.get('/tasks/lookup/quicksearch', { params: { q } });
export const getTaskChildren = (id) => API.get(`/tasks/${id}/children`);
export const getTaskParent = (id) => API.get(`/tasks/${id}/parent`);
export const setTaskParent = (id, parent_task_id) => API.patch(`/tasks/${id}/parent`, { parent_task_id });

// Agile (tenant-customisable Work Item Types, Workflow States, Story Points)
export const getAgileConfig = () => API.get('/agile/config');
export const getAgileSettings = () => API.get('/agile/settings');
export const updateAgileSettings = (data) => API.put('/agile/settings', data);
export const getWorkItemTypes = () => API.get('/agile/work-item-types');
export const createWorkItemType = (data) => API.post('/agile/work-item-types', data);
export const updateWorkItemType = (id, data) => API.put(`/agile/work-item-types/${id}`, data);
export const deleteWorkItemType = (id) => API.delete(`/agile/work-item-types/${id}`);
export const reorderWorkItemTypes = (order) => API.put('/agile/work-item-types/reorder', { order });
export const getWorkflowStates = () => API.get('/agile/workflow-states');
export const createWorkflowState = (data) => API.post('/agile/workflow-states', data);
export const updateWorkflowState = (id, data) => API.put(`/agile/workflow-states/${id}`, data);
export const deleteWorkflowState = (id) => API.delete(`/agile/workflow-states/${id}`);
export const reorderWorkflowStates = (order) => API.put('/agile/workflow-states/reorder', { order });
// Agile permissions are role-based — this endpoint just returns the caller's
// effective access level (canEdit + role). The previous request/grant/review
// flow was removed: edit access is granted purely by role membership in
// server/middleware/agileEditor.js#ROLES_THAT_CAN_EDIT_AGILE.
export const getAgilePermissions = () => API.get('/agile/permissions/me');

// ─── Custom Fields (Chunk 6) ───────────────────────────────────────────
// Tenant-customisable extra fields shown on every task. Definitions are
// admin-managed; values live per-task and are coerced server-side based
// on the field's declared type.
export const getCustomFields = () => API.get('/custom-fields');
export const getCustomFieldsAll = () => API.get('/custom-fields/all');
export const createCustomField = (data) => API.post('/custom-fields', data);
export const updateCustomField = (id, data) => API.put(`/custom-fields/${id}`, data);
export const deleteCustomField = (id) => API.delete(`/custom-fields/${id}`);
export const reorderCustomFields = (order) => API.put('/custom-fields/reorder', { order });
export const getTaskCustomFieldValues = (taskId) => API.get(`/custom-fields/task/${taskId}`);
export const updateTaskCustomFieldValues = (taskId, values) =>
    API.put(`/custom-fields/task/${taskId}`, { values });

// Service Desk
export const getServiceDeskTickets = (params) => API.get('/service-desk/tickets', { params });
export const getServiceDeskTicket = (id) => API.get(`/service-desk/tickets/${id}`);
export const createServiceDeskTicket = (data) => API.post('/service-desk/tickets', data);
export const updateServiceDeskTicket = (id, data) => API.patch(`/service-desk/tickets/${id}`, data);
export const deleteServiceDeskTicket = (id) => API.delete(`/service-desk/tickets/${id}`);
export const getServiceDeskStats = () => API.get('/service-desk/stats');

// Profile
export const getProfile = (config) => API.get('/profile', config);
export const updateProfile = (data) => API.put('/profile', data);
export const updateEmail = (email) => API.put('/profile/email', { email });
export const updatePassword = (data) => API.put('/profile/password', data);
export const deleteAccount = (password) => API.delete('/profile', { data: { password } });
export const uploadAvatar = (file) => {
    const formData = new FormData();
    formData.append('avatar', file);
    return API.post('/profile/avatar', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
};
export const removeAvatar = () => API.delete('/profile/avatar');

// Notification & sound preferences
export const getNotificationPrefs = () => API.get('/profile/notification-prefs');
export const updateNotificationPrefs = (prefs) => API.put('/profile/notification-prefs', prefs);

// ==================== ENTERPRISE API ====================

// Organization
export const createOrg = (name) => API.post('/org', { name });
export const getCurrentOrg = () => API.get('/org/current');
export const updateOrgSettings = (data) => API.put('/org/settings', data);
export const getOrgMembers = (params) => API.get('/org/members', { params });
export const inviteToOrg = (data) => API.post('/org/invite', data);
export const removeMember = (userId) => API.post('/org/remove-member', { user_id: userId });
export const getOrgDepartments = (params) => API.get('/org/departments', { params });
export const createDepartment = (data) => API.post('/org/departments', data);
export const updateDepartment = (id, data) => API.put(`/org/departments/${id}`, data);
export const deleteDepartment = (id) => API.delete(`/org/departments/${id}`);
export const getOrgTeams = (params) => API.get('/org/teams', { params });
export const createTeam = (data) => API.post('/org/teams', data);
export const updateTeam = (id, data) => API.put(`/org/teams/${id}`, data);
export const deleteTeam = (id) => API.delete(`/org/teams/${id}`);
export const getTeamSprintConfig = (teamId) => API.get(`/org/teams/${teamId}/sprint-config`);
export const updateTeamSprintConfig = (teamId, data) => API.put(`/org/teams/${teamId}/sprint-config`, data);
export const getOrgChart = (params) => API.get('/org/chart', { params });

// Custom Roles (tenant-defined roles with permission_level 1..4)
export const getOrgRoles = (params) => API.get('/org/roles', { params });
export const createOrgRole = (data) => API.post('/org/roles', data);
export const updateOrgRole = (roleKey, data) => API.patch(`/org/roles/${roleKey}`, data);
export const deleteOrgRole = (roleKey, params) => API.delete(`/org/roles/${roleKey}`, { params });

// Admin
export const getAdminOrganizations = () => API.get('/admin/organizations');
export const getAdminOrganization = (id) => API.get(`/admin/organizations/${id}`);
export const createAdminOrganization = (data) => API.post('/admin/organizations', data);
export const updateAdminOrganization = (id, data) => API.put(`/admin/organizations/${id}`, data);
export const deleteAdminOrganization = (id) => API.delete(`/admin/organizations/${id}`);
export const getAdminUsers = (params) => API.get('/admin/users', { params });
export const getAdminUser = (id) => API.get(`/admin/users/${id}`);
export const createAdminUser = (data) => API.post('/admin/users', data);
export const updateUserRole = (id, role, reason) => API.put(`/admin/users/${id}/role`, { role, reason });
export const updateUserAssignment = (id, data) => API.put(`/admin/users/${id}/assignment`, data);
export const toggleUserActive = (id) => API.put(`/admin/users/${id}/deactivate`);
export const deleteAdminUser = (id) => API.delete(`/admin/users/${id}`);
export const adminResetPassword = (id, password) => API.post(`/admin/users/${id}/reset-password`, { new_password: password });
export const getRoleChangeRequests = (params) => API.get('/admin/role-requests', { params });
export const approveRoleChange = (id) => API.post(`/admin/role-requests/${id}/approve`);
export const rejectRoleChange = (id, reason) => API.post(`/admin/role-requests/${id}/reject`, { reject_reason: reason });
export const cancelRoleChange = (id) => API.post(`/admin/role-requests/${id}/cancel`);
export const getAuditLogs = (params) => API.get('/admin/audit-logs', { params });
export const getAdminStats = () => API.get('/admin/stats');
export const getRegistrationSettings = () => API.get('/admin/registration-settings');
export const updateRegistrationSettings = (mode) => API.put('/admin/registration-settings', { mode });
export const getInviteCodes = () => API.get('/admin/invite-codes');
export const createInviteCode = (data) => API.post('/admin/invite-codes', data);
export const deactivateInviteCode = (id) => API.delete(`/admin/invite-codes/${id}`);
export const getRegistrationMode = () => API.get('/auth/registration-mode');
export const getAdminTaskLabels = () => API.get('/admin/task-labels');
export const createAdminTaskLabel = (data) => API.post('/admin/task-labels', data);
export const updateAdminTaskLabel = (id, data) => API.put(`/admin/task-labels/${id}`, data);
export const deleteAdminTaskLabel = (id) => API.delete(`/admin/task-labels/${id}`);
export const getAdminAnnouncements = () => API.get('/admin/announcements');
export const createAnnouncement = (data) => API.post('/admin/announcements', data);
export const updateAnnouncement = (id, data) => API.put(`/admin/announcements/${id}`, data);
export const deleteAnnouncement = (id) => API.delete(`/admin/announcements/${id}`);

// Tenant Management (platform_admin)
export const getTenants = (params) => API.get('/admin/tenants', { params });
export const getTenantOverview = () => API.get('/admin/tenants/overview');
export const getTenant = (id) => API.get(`/admin/tenants/${id}`);
export const createTenant = (data) => API.post('/admin/tenants', data);
export const updateTenant = (id, data) => API.put(`/admin/tenants/${id}`, data);
export const suspendTenant = (id, reason) => API.put(`/admin/tenants/${id}/suspend`, { reason });
export const reactivateTenant = (id) => API.put(`/admin/tenants/${id}/reactivate`);
export const deleteTenantApi = (id, hard) => API.delete(`/admin/tenants/${id}`, { params: { hard } });
export const getTenantStats = (id) => API.get(`/admin/tenants/${id}/stats`);
export const updateTenantDomain = (id, domain) => API.put(`/admin/tenants/${id}/domain`, { custom_domain: domain });
export const updateTenantFeatures = (id, features) => API.put(`/admin/tenants/${id}/features`, { features });
export const updateTenantLimits = (id, limits) => API.put(`/admin/tenants/${id}/limits`, limits);
export const impersonateTenant = (id) => API.post(`/admin/tenants/${id}/impersonate`);
export const exitImpersonation = (id) => API.post(`/admin/tenants/${id}/exit-impersonate`);
export const getImpersonationSession = (id) => API.get(`/admin/tenants/${id}/impersonation-session`);
export const getTenantUsers = (id, params) => API.get(`/admin/tenants/${id}/users`, { params });
export const createTenantUser = (id, data) => API.post(`/admin/tenants/${id}/users`, data);
export const deactivateTenantUser = (tenantId, userId) => API.put(`/admin/tenants/${tenantId}/users/${userId}/deactivate`);
export const seedTenant = (id) => API.post(`/admin/tenants/${id}/seed`);
export const getPlatformAuditLogs = (params) => API.get('/admin/tenants/audit-logs', { params });

// Platform Admin Management (platform_admin)
export const getPlatformUsers = () => API.get('/admin/tenants/platform-users');
export const createPlatformUser = (data) => API.post('/admin/tenants/platform-users', data);
export const deactivatePlatformUser = (id) => API.put(`/admin/tenants/platform-users/${id}/deactivate`);
export const resetPlatformUserPassword = (id, new_password) => API.post(`/admin/tenants/platform-users/${id}/reset-password`, { new_password });

// Manager Dashboard
export const getTeamAttendance = (date) => API.get('/manager/team-attendance', { params: { date } });
export const getTeamAnalytics = (days, from, to) => API.get('/manager/team-analytics', { params: { days, from, to } });
export const getApprovals = (params) => API.get('/manager/approvals', { params });
export const getMyRequests = (params) => API.get('/manager/my-requests', { params });
export const approveRequest = (id) => API.post(`/manager/approvals/${id}/approve`);
export const rejectRequest = (id, reason) => API.post(`/manager/approvals/${id}/reject`, { reject_reason: reason });
export const bulkApproval = (ids, action, reason) => API.post('/manager/approvals/bulk', { ids, action, reject_reason: reason });
export const getMemberHours = (userId, from, to) => API.get(`/manager/member/${userId}/hours`, { params: { from, to } });
export const getMemberTasks = (userId, date) => API.get(`/manager/member/${userId}/tasks`, { params: { date } });
export const getMemberLeaves = (userId, from, to) => API.get(`/manager/member/${userId}/leaves`, { params: { from, to } });
export const getMemberRequests = (userId) => API.get(`/manager/member/${userId}/requests`);
export const getMemberOverview = (userId) => API.get(`/manager/member/${userId}/overview`);

// Leave Policy
export const getLeavePolicies = () => API.get('/leave-policy/policies');
export const saveLeavePolicyAPI = (data) => API.post('/leave-policy/policies', data);
export const deleteLeavePolicyAPI = (id) => API.delete(`/leave-policy/policies/${id}`);
export const getLeaveBalances = (year) => API.get('/leave-policy/balances', { params: { year } });
export const getUserLeaveBalances = (userId, year) => API.get(`/leave-policy/balances/${userId}`, { params: { year } });
export const updateLeaveBalance = (userId, data) => API.put(`/leave-policy/balances/${userId}`, data);
export const getHolidays = (year) => API.get('/leave-policy/holidays', { params: { year } });
export const addHoliday = (data) => API.post('/leave-policy/holidays', data);
export const addHolidaysBatch = (holidays) => API.post('/leave-policy/holidays/batch', { holidays });
export const deleteHoliday = (id) => API.delete(`/leave-policy/holidays/${id}`);

// Notes
export const getNotes = () => API.get('/notes');
export const saveNotes = (data) => API.put('/notes', { data });
export const getPageHistory = (pageId) => API.get(`/notes/history/${encodeURIComponent(pageId)}`);
export const getHistorySnapshot = (snapshotId) => API.get(`/notes/history/snapshot/${snapshotId}`);
export const getMentionableUsers = () => API.get('/notes/mentionable-users');
export const sendNoteMention = (mentionedUserId, pageId, pageTitle) =>
    API.post('/notes/mention', { mentionedUserId, pageId, pageTitle });

// Notes — Tier 6 integrations
export const getNoteLinks = (pageId) => API.get(`/notes/links/${encodeURIComponent(pageId)}`);
export const addNoteLink = (pageId, entityType, entityId) =>
    API.post('/notes/links', { pageId, entityType, entityId });
export const removeNoteLink = (pageId, entityType, entityId) =>
    API.delete('/notes/links', { data: { pageId, entityType, entityId } });
export const getDailyPrefill = () => API.get('/notes/daily-prefill');
export const getOneOnOnePrefill = (userId) => API.get(`/notes/oneonone-prefill/${userId}`);
export const getTimeSummary = () => API.get('/notes/time-summary');
export const convertToTask = (title, pageId, pageTitle) =>
    API.post('/notes/convert-to-task', { title, pageId, pageTitle });
export const getSprintEmbed = () => API.get('/notes/sprint-embed');
export const searchNoteTasks = (q) => API.get('/notes/search-tasks', { params: { q } });
export const searchNoteMeetings = (q) => API.get('/notes/search-meetings', { params: { q } });
export const searchNoteEvents = (q) => API.get('/notes/search-events', { params: { q } });
export const getDirectReports = () => API.get('/notes/direct-reports');

// Public note share links (Chunk 5)
export const getNoteShare = (pageId) => API.get(`/notes/share/${encodeURIComponent(pageId)}`);
export const createNoteShare = (pageId) => API.post(`/notes/share/${encodeURIComponent(pageId)}`);
export const revokeNoteShare = (pageId) => API.delete(`/notes/share/${encodeURIComponent(pageId)}`);
// Public read-only note viewer — uses a separate axios instance with no
// CSRF header / no credentials, so it works anonymously.
export const getPublicNote = (token) => axios.get(`${baseURL}/public/notes/${encodeURIComponent(token)}`);

// Calendar
export const getCalendarEvents = (from, to) => API.get('/calendar', { params: { from, to } });
export const createCalendarEvent = (data) => API.post('/calendar', data);
export const updateCalendarEvent = (id, data) => API.put(`/calendar/${id}`, data);
export const deleteCalendarEvent = (id) => API.delete(`/calendar/${id}`);

// Notifications
export const getNotifications = () => API.get('/notifications');
export const markNotificationRead = (id) => API.post(`/notifications/${id}/read`);
export const markAllNotificationsRead = () => API.post('/notifications/read-all');
export const deleteNotification = (id) => API.delete(`/notifications/${id}`);
export const getActiveAnnouncements = () => API.get('/notifications/announcements');

// Export
export const exportMyAnalytics = (params) => API.get('/export/my-analytics', { params, responseType: 'blob' });
export const exportMyLeaves = (params) => API.get('/export/my-leaves', { params, responseType: 'blob' });
export const exportMyTasks = (params) => API.get('/export/my-tasks', { params, responseType: 'blob' });
export const exportTeamAnalytics = (params) => API.get('/export/team-analytics', { params, responseType: 'blob' });
export const exportTeamLeaves = (params) => API.get('/export/team-leaves', { params, responseType: 'blob' });
export const exportPayrollHours = (from, to, format = 'csv') =>
    API.get('/export/payroll-hours', { params: { from, to, format }, responseType: 'blob' });

// Global Search
export const globalSearch = (q, signal) => API.get('/search', { params: { q }, ...(signal && { signal }) });

// Pay Periods
export const getPayPeriods = () => API.get('/admin/pay-periods');
export const createPayPeriod = (data) => API.post('/admin/pay-periods', data);
export const deletePayPeriod = (id) => API.delete(`/admin/pay-periods/${id}`);

// Bulk User Import
export const importUsers = (payload, isFile = false) => {
    if (isFile) {
        return API.post('/admin/users/import', payload, { headers: { 'Content-Type': 'multipart/form-data' } });
    }
    return API.post('/admin/users/import', payload);
};

// Chat
export const searchChatUsers = (q) => API.get('/chat/search', { params: { q } });
export const getPresence = (userIds) => API.get('/chat/presence', { params: { userIds: userIds.join(',') } });
export const getUserStatus = () => API.get('/chat/status');
export const updateUserStatus = (status, statusText) => API.put('/chat/status', { status, statusText });
export const getConversations = () => API.get('/chat/conversations');
export const createConversation = (userId) => API.post('/chat/conversations', { userId });
export const createGroup = (name, userIds) => API.post('/chat/conversations/group', { name, userIds });
export const updateGroup = (convId, data) => API.put(`/chat/conversations/${convId}/group`, data);
export const getMembers = (convId) => API.get(`/chat/conversations/${convId}/members`);
export const getMessages = (convId, before) => API.get(`/chat/conversations/${convId}/messages`, { params: { before } });
export const markConversationRead = (convId) => API.post(`/chat/conversations/${convId}/read`);
export const getReadStatus = (convId) => API.get(`/chat/conversations/${convId}/read-status`);
export const uploadChatFile = (convId, formData) => API.post(`/chat/conversations/${convId}/files`, formData, { headers: { 'Content-Type': 'multipart/form-data' } });
export const toggleReaction = (msgId, emoji) => API.post(`/chat/messages/${msgId}/reactions`, { emoji });
export const editMessage = (msgId, content) => API.put(`/chat/messages/${msgId}`, { content });
export const deleteMessage = (msgId) => API.delete(`/chat/messages/${msgId}`);
export const togglePin = (msgId) => API.post(`/chat/messages/${msgId}/pin`);
export const getPinnedMessages = (convId) => API.get(`/chat/conversations/${convId}/pinned`);
export const searchMessages = (q, convId) => API.get('/chat/search-messages', { params: { q, convId } });
export const forwardMessage = (msgId, conversationIds) => API.post(`/chat/messages/${msgId}/forward`, { conversationIds });
export const toggleStar = (msgId) => API.post(`/chat/messages/${msgId}/star`);
export const getStarredMessages = () => API.get('/chat/starred');
export const createPoll = (convId, data) => API.post(`/chat/conversations/${convId}/polls`, data);
export const votePoll = (pollId, optionIdx) => API.post(`/chat/polls/${pollId}/vote`, { optionIdx });
export const getPoll = (pollId) => API.get(`/chat/polls/${pollId}`);
export const getSharedFiles = (convId) => API.get(`/chat/conversations/${convId}/files`);
export const ackDelivered = (msgId) => API.post(`/chat/messages/${msgId}/delivered`);
export const deleteConversation = (convId) => API.delete(`/chat/conversations/${convId}`);
export const clearChat = (convId) => API.delete(`/chat/conversations/${convId}/messages`);
export const togglePinConversation = (convId) => API.post(`/chat/conversations/${convId}/pin`);
export const toggleFavouriteConversation = (convId) => API.post(`/chat/conversations/${convId}/favourite`);
export const getCallHistory = (convId) => API.get(`/chat/conversations/${convId}/calls`);
export const getAllCallHistory = () => API.get('/chat/calls');
export const getActiveCall = () => API.get('/chat/calls/active');
export const getIceConfig = () => API.get('/chat/ice-config');

// Meetings
export const createMeeting = (data) => API.post('/meetings', data);
export const checkMeetingConflicts = (data) => API.post('/meetings/check-conflicts', data);
export const getMyMeetings = (params) => API.get('/meetings', { params });
export const getMeeting = (code) => API.get(`/meetings/${code}`);
export const updateMeeting = (id, data) => API.put(`/meetings/${id}`, data);
export const cancelMeeting = (id) => API.delete(`/meetings/${id}`);
export const getMeetingParticipants = (id) => API.get(`/meetings/${id}/participants`);
export const addMeetingParticipant = (id, userId) => API.post(`/meetings/${id}/participants`, { user_id: userId });
export const removeMeetingParticipant = (id, userId) => API.delete(`/meetings/${id}/participants/${userId}`);

// Meeting HLS broadcast (videosdk-hls-style large-meeting mode)
export const startMeetingHlsBroadcast = (code) => API.post(`/meetings/${code}/hls/start`);
export const stopMeetingHlsBroadcast = (code, broadcastId) =>
    API.post(`/meetings/${code}/hls/stop`, { broadcastId });
export const getMeetingHlsStatus = (code) => API.get(`/meetings/${code}/hls/status`);

// ─── Branding & email templates (Chunk 3) ───────────────────────────────
// `getBranding` is GET-only and is also called by the unauthenticated
// AuthContext bootstrap on first load to apply the org accent + logo before
// the user is even authenticated; the server only allows it for
// authenticated org members so it returns 401 pre-login (which we handle).
export const getBranding = () => API.get('/branding');
// Public branding (no auth) — used to theme the login / register pages with
// the org's accent color before the user signs in. Returns nulls on the
// master / default domain so callers can safely fall back to defaults.
export const getPublicBranding = () => API.get('/public/branding');
export const updateBrandingAccent = (accent_color) => API.put('/branding', { accent_color });
export const uploadBrandingLogo = (file) => {
    const fd = new FormData();
    fd.append('logo', file);
    return API.post('/branding/logo', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
};
export const deleteBrandingLogo = () => API.delete('/branding/logo');
export const getEmailTemplates = () => API.get('/branding/email-templates');
export const updateEmailTemplate = (key, data) => API.put(`/branding/email-templates/${encodeURIComponent(key)}`, data);
export const revertEmailTemplate = (key) => API.delete(`/branding/email-templates/${encodeURIComponent(key)}`);
export const previewEmailTemplate = (key, data) =>
    API.post(`/branding/email-templates/${encodeURIComponent(key)}/preview`, data || {});

export default API;
