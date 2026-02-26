import axios from 'axios';
import NProgress from 'nprogress';
import 'nprogress/nprogress.css';

NProgress.configure({ showSpinner: false });

const API = axios.create({
    baseURL: '/api',
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

// Attach token and timezone offset to every request
API.interceptors.request.use(config => {
    NProgress.start();
    const token = localStorage.getItem('token');
    if (token) {
        config.headers.Authorization = `Bearer ${token}`;
    }
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
export const deleteEntries = (date) => API.delete(`/tracker/entries/${date}`);
export const getEntries = (date) => API.get(`/tracker/entries/${date}`);

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

export default API;
