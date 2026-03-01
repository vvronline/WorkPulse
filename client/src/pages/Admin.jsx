import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../AuthContext';
import {
    getAdminUsers, createAdminUser, updateUserRole, updateUserAssignment,
    toggleUserActive, adminResetPassword, getAuditLogs, getAdminStats,
    getOrgDepartments, getOrgTeams
} from '../api';
import s from './Admin.module.css';

const ROLES = ['employee', 'team_lead', 'manager', 'hr_admin', 'super_admin'];
const ROLE_LABELS = { employee: 'Employee', team_lead: 'Team Lead', manager: 'Manager', hr_admin: 'HR Admin', super_admin: 'Super Admin' };

export default function AdminPanel() {
    const { user } = useAuth();
    const [tab, setTab] = useState('users');
    const [stats, setStats] = useState(null);

    useEffect(() => {
        getAdminStats().then(r => setStats(r.data)).catch(() => {});
    }, []);

    if (!user || !['hr_admin', 'super_admin'].includes(user.role)) {
        return <div className={s.adminPage}><div className={s.error}>Access denied. HR Admin or Super Admin role required.</div></div>;
    }

    return (
        <div className={s.adminPage}>
            <h1>Admin Panel</h1>

            {stats && (
                <div className={s.statsGrid}>
                    <div className={s.statCard}><div className={s.value}>{stats.activeUsers}</div><div className={s.label}>Active Users</div></div>
                    <div className={s.statCard}><div className={s.value}>{stats.totalUsers}</div><div className={s.label}>Total Users</div></div>
                    <div className={s.statCard}><div className={s.value}>{stats.departments}</div><div className={s.label}>Departments</div></div>
                    <div className={s.statCard}><div className={s.value}>{stats.teams}</div><div className={s.label}>Teams</div></div>
                    <div className={s.statCard}><div className={s.value}>{stats.pendingApprovals}</div><div className={s.label}>Pending Approvals</div></div>
                    <div className={s.statCard}><div className={s.value}>{stats.clockedInToday}</div><div className={s.label}>Clocked In Today</div></div>
                </div>
            )}

            <div className={s.tabs}>
                <button className={`${s.tab} ${tab === 'users' ? s.active : ''}`} onClick={() => setTab('users')}>Users</button>
                <button className={`${s.tab} ${tab === 'create' ? s.active : ''}`} onClick={() => setTab('create')}>Create User</button>
                <button className={`${s.tab} ${tab === 'audit' ? s.active : ''}`} onClick={() => setTab('audit')}>Audit Logs</button>
            </div>

            {tab === 'users' && <UserManagement userRole={user.role} />}
            {tab === 'create' && <CreateUser onCreated={() => setTab('users')} />}
            {tab === 'audit' && <AuditLogs />}
        </div>
    );
}

function UserManagement({ userRole }) {
    const [users, setUsers] = useState([]);
    const [search, setSearch] = useState('');
    const [filterRole, setFilterRole] = useState('');
    const [filterActive, setFilterActive] = useState('');
    const [departments, setDepartments] = useState([]);
    const [teams, setTeams] = useState([]);
    const [editingUser, setEditingUser] = useState(null);
    const [resetPwUser, setResetPwUser] = useState(null);
    const [msg, setMsg] = useState('');

    const fetchUsers = useCallback(() => {
        const params = {};
        if (search) params.search = search;
        if (filterRole) params.role = filterRole;
        if (filterActive) params.is_active = filterActive;
        getAdminUsers(params).then(r => setUsers(r.data)).catch(() => {});
    }, [search, filterRole, filterActive]);

    useEffect(() => { fetchUsers(); }, [fetchUsers]);
    useEffect(() => {
        getOrgDepartments().then(r => setDepartments(r.data)).catch(() => {});
        getOrgTeams().then(r => setTeams(r.data)).catch(() => {});
    }, []);

    const handleRoleChange = async (id, role) => {
        try {
            await updateUserRole(id, role);
            setMsg('Role updated');
            fetchUsers();
        } catch (e) { setMsg(e.response?.data?.error || 'Failed'); }
    };

    const handleToggleActive = async (id) => {
        try {
            await toggleUserActive(id);
            fetchUsers();
        } catch (e) { setMsg(e.response?.data?.error || 'Failed'); }
    };

    const handleAssignment = async (userId, deptId, teamId) => {
        try {
            await updateUserAssignment(userId, { department_id: deptId || null, team_id: teamId || null });
            setMsg('Assignment updated');
            setEditingUser(null);
            fetchUsers();
        } catch (e) { setMsg(e.response?.data?.error || 'Failed'); }
    };

    return (
        <>
            {msg && <div className={s.success}>{msg}</div>}
            <div className={s.toolbar}>
                <input placeholder="Search users..." value={search} onChange={e => setSearch(e.target.value)} />
                <select value={filterRole} onChange={e => setFilterRole(e.target.value)}>
                    <option value="">All Roles</option>
                    {ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                </select>
                <select value={filterActive} onChange={e => setFilterActive(e.target.value)}>
                    <option value="">All Status</option>
                    <option value="true">Active</option>
                    <option value="false">Inactive</option>
                </select>
            </div>

            <table className={s.table}>
                <thead>
                    <tr>
                        <th>User</th>
                        <th>Role</th>
                        <th>Department</th>
                        <th>Team</th>
                        <th>Status</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    {users.map(u => (
                        <tr key={u.id}>
                            <td>
                                <div className={s.userCell}>
                                    {u.avatar ? <img src={u.avatar} className={s.miniAvatar} alt="" /> : <div className={s.initials}>{u.full_name?.charAt(0)}</div>}
                                    <div>
                                        <div style={{ fontWeight: 600 }}>{u.full_name}</div>
                                        <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>@{u.username} • {u.email}</div>
                                    </div>
                                </div>
                            </td>
                            <td>
                                <select value={u.role} onChange={e => handleRoleChange(u.id, e.target.value)} style={{ padding: '0.3rem 1.8rem 0.3rem 0.5rem', borderRadius: 6, border: '1px solid var(--glass-border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '0.8rem', fontFamily: 'inherit' }}>
                                    {ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                                </select>
                            </td>
                            <td>{u.department_name || '—'}</td>
                            <td>{u.team_name || '—'}</td>
                            <td>
                                {u.is_active ? <span className={s.badgeActive}>Active</span> : <span className={s.badgeInactive}>Inactive</span>}
                            </td>
                            <td>
                                <div className={s.actions}>
                                    <button className={s.btnSmall} style={{ background: 'var(--accent)', color: '#fff' }} onClick={() => setEditingUser(u)}>Assign</button>
                                    <button className={s.btnSmall} style={{ background: u.is_active ? '#ef4444' : '#10b981', color: '#fff' }} onClick={() => handleToggleActive(u.id)}>
                                        {u.is_active ? 'Deactivate' : 'Activate'}
                                    </button>
                                    <button className={s.btnSmall} style={{ background: '#f59e0b', color: '#fff' }} onClick={() => setResetPwUser(u)}>Reset PW</button>
                                </div>
                            </td>
                        </tr>
                    ))}
                    {users.length === 0 && (
                        <tr><td colSpan={6} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>No users found</td></tr>
                    )}
                </tbody>
            </table>

            {editingUser && (
                <AssignmentModal user={editingUser} departments={departments} teams={teams} onClose={() => setEditingUser(null)} onSave={handleAssignment} />
            )}
            {resetPwUser && (
                <ResetPasswordModal user={resetPwUser} onClose={() => setResetPwUser(null)} onDone={(msg) => { setMsg(msg); setResetPwUser(null); }} />
            )}
        </>
    );
}

function AssignmentModal({ user, departments, teams, onClose, onSave }) {
    const [deptId, setDeptId] = useState(user.department_id || '');
    const [teamId, setTeamId] = useState(user.team_id || '');

    return (
        <div className={s.modalOverlay} onClick={onClose}>
            <div className={s.modal} onClick={e => e.stopPropagation()}>
                <h2>Assign {user.full_name}</h2>
                <div className={s.formGroup}>
                    <label>Department</label>
                    <select value={deptId} onChange={e => setDeptId(e.target.value)}>
                        <option value="">None</option>
                        {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                </div>
                <div className={s.formGroup}>
                    <label>Team</label>
                    <select value={teamId} onChange={e => setTeamId(e.target.value)}>
                        <option value="">None</option>
                        {teams.filter(t => !deptId || t.department_id === Number(deptId)).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                </div>
                <div className={s.formActions}>
                    <button className={s.btnCancel} onClick={onClose}>Cancel</button>
                    <button className={s.btnPrimary} onClick={() => onSave(user.id, deptId || null, teamId || null)}>Save</button>
                </div>
            </div>
        </div>
    );
}

function ResetPasswordModal({ user, onClose, onDone }) {
    const [pw, setPw] = useState('');
    const [error, setError] = useState('');

    const handleReset = async () => {
        if (pw.length < 8) { setError('Password must be at least 8 characters'); return; }
        try {
            const r = await adminResetPassword(user.id, pw);
            onDone(r.data.message);
        } catch (e) { setError(e.response?.data?.error || 'Failed'); }
    };

    return (
        <div className={s.modalOverlay} onClick={onClose}>
            <div className={s.modal} onClick={e => e.stopPropagation()}>
                <h2>Reset Password for {user.full_name}</h2>
                {error && <div className={s.error}>{error}</div>}
                <div className={s.formGroup}>
                    <label>New Password</label>
                    <input type="password" value={pw} onChange={e => setPw(e.target.value)} placeholder="Minimum 8 characters" />
                </div>
                <div className={s.formActions}>
                    <button className={s.btnCancel} onClick={onClose}>Cancel</button>
                    <button className={s.btnPrimary} onClick={handleReset}>Reset Password</button>
                </div>
            </div>
        </div>
    );
}

function CreateUser({ onCreated }) {
    const [form, setForm] = useState({ username: '', password: '', full_name: '', email: '', role: 'employee' });
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setSuccess('');
        try {
            const r = await createAdminUser(form);
            setSuccess(r.data.message);
            setForm({ username: '', password: '', full_name: '', email: '', role: 'employee' });
            setTimeout(onCreated, 1500);
        } catch (e) { setError(e.response?.data?.error || 'Failed to create user'); }
    };

    return (
        <form onSubmit={handleSubmit} style={{ maxWidth: 500 }}>
            {error && <div className={s.error}>{error}</div>}
            {success && <div className={s.success}>{success}</div>}
            <div className={s.formGroup}>
                <label>Full Name</label>
                <input required value={form.full_name} onChange={e => setForm({ ...form, full_name: e.target.value })} />
            </div>
            <div className={s.formGroup}>
                <label>Username</label>
                <input required value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} />
            </div>
            <div className={s.formGroup}>
                <label>Email</label>
                <input type="email" required value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
            </div>
            <div className={s.formGroup}>
                <label>Password</label>
                <input type="password" required minLength={8} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} />
            </div>
            <div className={s.formGroup}>
                <label>Role</label>
                <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}>
                    {ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                </select>
            </div>
            <button type="submit" className={s.btnPrimary}>Create User</button>
        </form>
    );
}

function AuditLogs() {
    const [logs, setLogs] = useState([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(0);
    const [filters, setFilters] = useState({ entity_type: '', action: '' });
    const pageSize = 50;

    const fetchLogs = useCallback(() => {
        const params = { limit: pageSize, offset: page * pageSize };
        if (filters.entity_type) params.entity_type = filters.entity_type;
        if (filters.action) params.action = filters.action;
        getAuditLogs(params).then(r => { setLogs(r.data.logs); setTotal(r.data.total); }).catch(() => {});
    }, [page, filters]);

    useEffect(() => { fetchLogs(); }, [fetchLogs]);

    const totalPages = Math.ceil(total / pageSize);

    return (
        <>
            <div className={s.toolbar}>
                <select value={filters.entity_type} onChange={e => { setFilters({ ...filters, entity_type: e.target.value }); setPage(0); }}>
                    <option value="">All Entities</option>
                    {['user', 'leave', 'time_entry', 'task', 'team', 'department', 'organization', 'leave_policy', 'holiday', 'approval_request'].map(t => (
                        <option key={t} value={t}>{t}</option>
                    ))}
                </select>
                <select value={filters.action} onChange={e => { setFilters({ ...filters, action: e.target.value }); setPage(0); }}>
                    <option value="">All Actions</option>
                    {['create', 'update', 'delete', 'approve', 'reject', 'login', 'update_role', 'deactivate', 'reactivate', 'admin_create', 'admin_reset_password', 'invite', 'remove_member'].map(a => (
                        <option key={a} value={a}>{a}</option>
                    ))}
                </select>
                <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{total} log(s)</span>
            </div>

            <table className={s.table}>
                <thead>
                    <tr>
                        <th>Time</th>
                        <th>Actor</th>
                        <th>Action</th>
                        <th>Entity</th>
                        <th>Details</th>
                        <th>IP</th>
                    </tr>
                </thead>
                <tbody>
                    {logs.map(log => (
                        <tr key={log.id}>
                            <td style={{ whiteSpace: 'nowrap', fontSize: '0.8rem' }}>{new Date(log.created_at + 'Z').toLocaleString()}</td>
                            <td>{log.actor_name || log.actor_username || `User #${log.actor_id}`}</td>
                            <td><span className={s.badge} style={{ background: 'var(--accent-light)', color: 'var(--accent)' }}>{log.action}</span></td>
                            <td>{log.entity_type}{log.entity_id ? ` #${log.entity_id}` : ''}</td>
                            <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.8rem' }}>
                                {log.details ? JSON.stringify(JSON.parse(log.details)) : '—'}
                            </td>
                            <td style={{ fontSize: '0.8rem' }}>{log.ip_address || '—'}</td>
                        </tr>
                    ))}
                    {logs.length === 0 && (
                        <tr><td colSpan={6} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>No logs found</td></tr>
                    )}
                </tbody>
            </table>

            {totalPages > 1 && (
                <div className={s.pagination}>
                    <button disabled={page === 0} onClick={() => setPage(p => p - 1)}>Previous</button>
                    <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Page {page + 1} of {totalPages}</span>
                    <button disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>Next</button>
                </div>
            )}
        </>
    );
}
