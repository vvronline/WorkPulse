import axios from 'axios';
import NProgress from 'nprogress';
import 'nprogress/nprogress.css';

NProgress.configure({ showSpinner: false });

export const baseURL = process.env.NODE_ENV === 'production' ? '/api' : 'http://localhost:5000/api';

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
export const forgotPassword = (data) => API.post('/auth/forgot-password', data);
export const resetPassword = (data) => API.post('/auth/reset-password', data);

// Tracker
export const getStatus = () => API.get('/tracker/status');
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
export const addLeavesBatch = (data) => API.post('/leaves/batch', data);
export const deleteLeave = (id) => API.delete(`/leaves/${id}`);
export const getLeaveSummary = (month, year) => API.get('/leaves/summary', { params: { month, year } });

// Tasks
export const getTasks = (date) => API.get('/tasks', { params: { date } });
export const addTask = (data) => API.post('/tasks', data);
export const updateTaskStatus = (id, status) => API.patch(`/tasks/${id}/status`, { status });
export const updateTask = (id, data) => API.put(`/tasks/${id}`, data);
export const deleteTask = (id) => API.delete(`/tasks/${id}`);
export const carryForwardTasks = () => API.post('/tasks/carry-forward');

// Profile
export const getProfile = () => API.get('/profile');
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
export const getOrgDepartments = () => API.get('/org/departments');
export const createDepartment = (data) => API.post('/org/departments', data);
export const updateDepartment = (id, data) => API.put(`/org/departments/${id}`, data);
export const deleteDepartment = (id) => API.delete(`/org/departments/${id}`);
export const getOrgTeams = (params) => API.get('/org/teams', { params });
export const createTeam = (data) => API.post('/org/teams', data);
export const updateTeam = (id, data) => API.put(`/org/teams/${id}`, data);
export const deleteTeam = (id) => API.delete(`/org/teams/${id}`);
export const getOrgChart = () => API.get('/org/chart');

// Admin
export const getAdminOrganizations = () => API.get('/admin/organizations');
export const getAdminOrganization = (id) => API.get(`/admin/organizations/${id}`);
export const createAdminOrganization = (data) => API.post('/admin/organizations', data);
export const updateAdminOrganization = (id, data) => API.put(`/admin/organizations/${id}`, data);
export const deleteAdminOrganization = (id) => API.delete(`/admin/organizations/${id}`);
export const getAdminUsers = (params) => API.get('/admin/users', { params });
export const getAdminUser = (id) => API.get(`/admin/users/${id}`);
export const createAdminUser = (data) => API.post('/admin/users', data);
export const updateUserRole = (id, role) => API.put(`/admin/users/${id}/role`, { role });
export const updateUserAssignment = (id, data) => API.put(`/admin/users/${id}/assignment`, data);
export const toggleUserActive = (id) => API.put(`/admin/users/${id}/deactivate`);
export const deleteAdminUser = (id) => API.delete(`/admin/users/${id}`);
export const adminResetPassword = (id, password) => API.post(`/admin/users/${id}/reset-password`, { new_password: password });
export const getAuditLogs = (params) => API.get('/admin/audit-logs', { params });
export const getAdminStats = () => API.get('/admin/stats');
export const getRegistrationSettings = () => API.get('/admin/registration-settings');
export const updateRegistrationSettings = (mode) => API.put('/admin/registration-settings', { mode });
export const getInviteCodes = () => API.get('/admin/invite-codes');
export const createInviteCode = (data) => API.post('/admin/invite-codes', data);
export const deactivateInviteCode = (id) => API.delete(`/admin/invite-codes/${id}`);
export const getRegistrationMode = () => API.get('/auth/registration-mode');

// Manager Dashboard
export const getTeamAttendance = (date) => API.get('/manager/team-attendance', { params: { date } });
export const getTeamAnalytics = (days) => API.get('/manager/team-analytics', { params: { days } });
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

export default API;
