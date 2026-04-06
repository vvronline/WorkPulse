import axios from 'axios';
import NProgress from 'nprogress';
import 'nprogress/nprogress.css';

NProgress.configure({ showSpinner: false });

export const baseURL = import.meta.env.PROD ? '/api' : 'http://localhost:5000/api';

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
    NProgress.start();
    config.headers['x-timezone-offset'] = new Date().getTimezoneOffset();
    return config;
});

// NProgress bar — AxiosInterceptor component handles 401/token expiration separately
API.interceptors.response.use(
    response => {
        NProgress.done();
        return response;
    },
    error => {
        NProgress.done();
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
export const getLeaves = (from, to) => API.get('/leaves', { params: { from, to } });
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

export default API;
