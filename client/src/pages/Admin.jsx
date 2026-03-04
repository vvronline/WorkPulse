import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAutoDismiss } from '../hooks/useAutoDismiss';
import { useAuth } from '../AuthContext';
import {
    getAdminUsers, createAdminUser, updateUserRole, updateUserAssignment,
    toggleUserActive, deleteAdminUser, adminResetPassword, getAuditLogs, getAdminStats,
    getOrgDepartments, getOrgTeams, getAdminOrganizations, getAdminOrganization,
    createAdminOrganization, updateAdminOrganization, deleteAdminOrganization,
    getCurrentOrg, updateOrgSettings, createDepartment, updateDepartment, deleteDepartment,
    createTeam, updateTeam, deleteTeam, getOrgMembers, getOrgChart,
    getAdminTaskLabels, createAdminTaskLabel, updateAdminTaskLabel, deleteAdminTaskLabel,
    getTeamSprintConfig, updateTeamSprintConfig
} from '../api';
import s from './Admin.module.css';

const ROLES = ['employee', 'team_lead', 'manager', 'hr_admin', 'super_admin'];
const ROLE_LABELS = { employee: 'Employee', team_lead: 'Team Lead', manager: 'Manager', hr_admin: 'HR Admin', super_admin: 'Super Admin' };

export default function AdminPanel() {
    const { user } = useAuth();
    const [tab, setTab] = useState('users');
    const [stats, setStats] = useState(null);

    useEffect(() => {
        getAdminStats().then(r => setStats(r.data)).catch(e => console.error(e));
    }, []);

    if (!user || !['hr_admin', 'super_admin'].includes(user.role)) {
        return <div className={s.adminPage}><div className={s.error}>Access denied. HR Admin or Super Admin role required.</div></div>;
    }

    return (
        <div className={s.adminPage}>
            <h1>Admin Panel</h1>

            {stats && (
                <div className={s.statsGrid}>
                    <div className={s.statCard}>
                        <div className={s.statIcon}>✓</div>
                        <div className={s.value}>{stats.activeUsers}</div>
                        <div className={s.label}>Active Users</div>
                    </div>
                    <div className={s.statCard}>
                        <div className={s.statIcon}>👥</div>
                        <div className={s.value}>{stats.totalUsers}</div>
                        <div className={s.label}>Total Users</div>
                    </div>
                    <div className={s.statCard}>
                        <div className={s.statIcon}>🏛️</div>
                        <div className={s.value}>{stats.departments}</div>
                        <div className={s.label}>Departments</div>
                    </div>
                    <div className={s.statCard}>
                        <div className={s.statIcon}>👨‍👩‍👧‍👦</div>
                        <div className={s.value}>{stats.teams}</div>
                        <div className={s.label}>Teams</div>
                    </div>
                    <div className={s.statCard}>
                        <div className={s.statIcon}>⏳</div>
                        <div className={s.value}>{stats.pendingApprovals}</div>
                        <div className={s.label}>Pending Approvals</div>
                    </div>
                    <div className={s.statCard}>
                        <div className={s.statIcon}>⏰</div>
                        <div className={s.value}>{stats.clockedInToday}</div>
                        <div className={s.label}>Clocked In Today</div>
                    </div>
                </div>
            )}

            <div className={s.tabs}>
                <button className={`${s.tab} ${tab === 'users' ? s.active : ''}`} onClick={() => setTab('users')}>
                    <span>👥</span> Users
                </button>
                <button className={`${s.tab} ${tab === 'create' ? s.active : ''}`} onClick={() => setTab('create')}>
                    <span>➕</span> Create User
                </button>
                {(user.role === 'super_admin' || user.org_id) && (
                    <button className={`${s.tab} ${tab === 'organizations' ? s.active : ''}`} onClick={() => setTab('organizations')}>
                        <span>🏢</span> Organizations
                    </button>
                )}
                {(user.role === 'super_admin' || user.org_id) && (
                    <button className={`${s.tab} ${tab === 'labels' ? s.active : ''}`} onClick={() => setTab('labels')}>
                        <span>🏷️</span> Task Labels
                    </button>
                )}
                <button className={`${s.tab} ${tab === 'audit' ? s.active : ''}`} onClick={() => setTab('audit')}>
                    <span>📋</span> Audit Logs
                </button>
            </div>

            {tab === 'users' && <UserManagement userRole={user.role} />}
            {tab === 'create' && <CreateUser userRole={user.role} onCreated={() => setTab('users')} />}
            {tab === 'organizations' && (user.role === 'super_admin' || user.org_id) && <OrganizationsTab userRole={user.role} hasOrgId={!!user.org_id} />}
            {tab === 'labels' && (user.role === 'super_admin' || user.org_id) && <TaskLabelsTab />}
            {tab === 'audit' && <AuditLogs />}
        </div>
    );
}

function UserManagement({ userRole }) {
    const [users, setUsers] = useState([]);
    const [search, setSearch] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const searchTimerRef = useRef(null);
    const [filterRole, setFilterRole] = useState('');
    const [filterActive, setFilterActive] = useState('');
    const [departments, setDepartments] = useState([]);
    const [teams, setTeams] = useState([]);
    const [organizations, setOrganizations] = useState([]);
    const [editingUser, setEditingUser] = useState(null);
    const [resetPwUser, setResetPwUser] = useState(null);
    const [deletingUser, setDeletingUser] = useState(null);
    const [msg, setMsg] = useAutoDismiss('');

    // Debounce search input by 300ms
    useEffect(() => {
        if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
        searchTimerRef.current = setTimeout(() => setDebouncedSearch(search), 300);
        return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
    }, [search]);

    const fetchUsers = useCallback(() => {
        const params = {};
        if (debouncedSearch) params.search = debouncedSearch;
        if (filterRole) params.role = filterRole;
        if (filterActive) params.is_active = filterActive;
        getAdminUsers(params).then(r => setUsers(r.data?.data ?? r.data)).catch(e => console.error(e));
    }, [debouncedSearch, filterRole, filterActive]);

    useEffect(() => { fetchUsers(); }, [fetchUsers]);
    useEffect(() => {
        getOrgDepartments().then(r => setDepartments(r.data)).catch(e => console.error(e));
        getOrgTeams().then(r => setTeams(r.data)).catch(e => console.error(e));
        if (userRole === 'super_admin') {
            getAdminOrganizations().then(r => setOrganizations(r.data)).catch(e => console.error(e));
        }
    }, [userRole]);

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

    const handleAssignment = async (userId, orgId, deptId, teamId, managerId) => {
        try {
            await updateUserAssignment(userId, { org_id: orgId !== undefined ? (orgId || null) : undefined, department_id: deptId || null, team_id: teamId || null, manager_id: managerId || null });
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
                        <th>Organization</th>
                        <th>Role</th>
                        <th>Department</th>
                        <th>Team</th>
                        <th>Manager</th>
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
                                        <div className={s['font-bold']}>{u.full_name}</div>
                                        <div className={s['text-muted-xs']}>@{u.username} • {u.email}</div>
                                    </div>
                                </div>
                            </td>
                            <td style={{ fontSize: '0.85rem', color: u.org_name ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{u.org_name || '—'}</td>
                            <td>
                                <select value={u.role} onChange={e => handleRoleChange(u.id, e.target.value)} className={s.inlineSelect}>
                                    {ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                                </select>
                            </td>
                            <td>{u.department_name || '—'}</td>
                            <td>{u.team_name || '—'}</td>
                            <td>{u.manager_name || '—'}</td>
                            <td>
                                {u.is_active ? <span className={s.badgeActive}>Active</span> : <span className={s.badgeInactive}>Inactive</span>}
                            </td>
                            <td>
                                <div className={s.actions}>
                                    <button className={`${s.btnSmall} ${s.btnAccent}`} onClick={() => setEditingUser(u)} title="Assign to organization/department/team">
                                        ✏️ Assign
                                    </button>
                                    <button className={`${s.btnSmall} ${u.is_active ? s.btnDanger : s.btnSuccess}`} onClick={() => handleToggleActive(u.id)} title={u.is_active ? 'Deactivate user' : 'Activate user'}>
                                        {u.is_active ? '🚫 Deactivate' : '✅ Activate'}
                                    </button>
                                    <button className={`${s.btnSmall} ${s.btnWarning}`} onClick={() => setResetPwUser(u)} title="Reset user password">
                                        🔑 Reset
                                    </button>
                                    {userRole === 'super_admin' && u.role !== 'super_admin' && (
                                        <button className={`${s.btnSmall} ${s.btnDanger}`} onClick={() => setDeletingUser(u)} title="Permanently delete user">
                                            🗑️ Delete
                                        </button>
                                    )}
                                </div>
                            </td>
                        </tr>
                    ))}
                    {users.length === 0 && (
                        <tr><td colSpan={8} className={s.emptyRow}>No users found</td></tr>
                    )}
                </tbody>
            </table>

            {editingUser && (
                <AssignmentModal user={editingUser} departments={departments} teams={teams} organizations={organizations} userRole={userRole} allUsers={users} onClose={() => setEditingUser(null)} onSave={handleAssignment} />
            )}
            {resetPwUser && (
                <ResetPasswordModal user={resetPwUser} onClose={() => setResetPwUser(null)} onDone={(msg) => { setMsg(msg); setResetPwUser(null); }} />
            )}
            {deletingUser && (
                <div className={s.modalOverlay} onClick={() => setDeletingUser(null)}>
                    <div className={s.modal} onClick={e => e.stopPropagation()}>
                        <h2>Delete User</h2>
                        <p>Are you sure you want to permanently delete <strong>{deletingUser.full_name}</strong> (@{deletingUser.username})?</p>
                        <p className={s['delete-warning']}>⚠️ This will remove all their time entries, leaves, planner items, and other data. This action cannot be undone.</p>
                        <div className={s.formActions}>
                            <button className={s.btnCancel} onClick={() => setDeletingUser(null)}>Cancel</button>
                            <button className={`${s.btnPrimary} ${s.btnDanger}`} onClick={async () => {
                                try {
                                    const r = await deleteAdminUser(deletingUser.id);
                                    setMsg(r.data.message);
                                    setDeletingUser(null);
                                    fetchUsers();
                                } catch (e) { setMsg(e.response?.data?.error || 'Failed to delete user'); }
                            }}>Delete Permanently</button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}

function AssignmentModal({ user, departments, teams, organizations, userRole, allUsers, onClose, onSave }) {
    const [orgId, setOrgId] = useState(user.org_id || '');
    const [deptId, setDeptId] = useState(user.department_id || '');
    const [teamId, setTeamId] = useState(user.team_id || '');
    const [managerId, setManagerId] = useState(user.manager_id || '');

    const managerOptions = (allUsers || []).filter(u => u.id !== user.id && u.is_active);
    const isSuperAdmin = userRole === 'super_admin';

    return (
        <div className={s.modalOverlay} onClick={onClose}>
            <div className={s.modal} onClick={e => e.stopPropagation()}>
                <h2>Assign {user.full_name}</h2>
                {isSuperAdmin && (
                    <div className={s.formGroup}>
                        <label>Organization</label>
                        <select value={orgId} onChange={e => { setOrgId(e.target.value); setDeptId(''); setTeamId(''); setManagerId(''); }}>
                            <option value="">None</option>
                            {organizations.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                        </select>
                    </div>
                )}
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
                <div className={s.formGroup}>
                    <label>Manager</label>
                    <select value={managerId} onChange={e => setManagerId(e.target.value)}>
                        <option value="">None</option>
                        {managerOptions.map(u => <option key={u.id} value={u.id}>{u.full_name} ({ROLE_LABELS[u.role] || u.role})</option>)}
                    </select>
                </div>
                <div className={s.formActions}>
                    <button className={s.btnCancel} onClick={onClose}>Cancel</button>
                    <button className={s.btnPrimary} onClick={() => onSave(user.id, isSuperAdmin ? orgId : undefined, deptId || null, teamId || null, managerId || null)}>Save</button>
                </div>
            </div>
        </div>
    );
}

function ResetPasswordModal({ user, onClose, onDone }) {
    const [pw, setPw] = useState('');
    const [error, setError] = useAutoDismiss('');

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

function CreateUser({ userRole, onCreated }) {
    const [form, setForm] = useState({ username: '', password: '', full_name: '', email: '', role: 'employee', org_id: '', department_id: '', team_id: '', manager_id: '' });
    const [error, setError] = useAutoDismiss('');
    const [success, setSuccess] = useAutoDismiss('');
    const [organizations, setOrganizations] = useState([]);
    const [departments, setDepartments] = useState([]);
    const [teams, setTeams] = useState([]);
    const [users, setUsers] = useState([]);

    useEffect(() => {
        if (userRole === 'super_admin') {
            getAdminOrganizations().then(r => setOrganizations(r.data)).catch(e => console.error(e));
        }
        getOrgDepartments().then(r => setDepartments(r.data)).catch(e => console.error(e));
        getOrgTeams().then(r => setTeams(r.data)).catch(e => console.error(e));
        getAdminUsers({}).then(r => setUsers(r.data?.data ?? r.data)).catch(e => console.error(e));
    }, [userRole]);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setSuccess('');
        try {
            const payload = { ...form };
            // Clean up empty strings to null/undefined
            if (!payload.org_id) delete payload.org_id;
            if (!payload.department_id) delete payload.department_id;
            if (!payload.team_id) delete payload.team_id;
            if (!payload.manager_id) delete payload.manager_id;
            const r = await createAdminUser(payload);
            setSuccess(r.data.message + ' (User must change password on first login)');
            setForm({ username: '', password: '', full_name: '', email: '', role: 'employee', org_id: '', department_id: '', team_id: '', manager_id: '' });
            setTimeout(onCreated, 2000);
        } catch (e) { setError(e.response?.data?.error || 'Failed to create user'); }
    };

    const isSuperAdmin = userRole === 'super_admin';
    const filteredTeams = form.department_id ? teams.filter(t => t.department_id === Number(form.department_id)) : teams;
    const managerOptions = users.filter(u => u.is_active);

    return (
        <div className={s['form-container']}>
            <h2 className={s['section-heading']}>➕ Create New User</h2>
            <p className={s['section-subtitle']}>
                Create a new user account. The user will be required to change their password on first login.
            </p>
            <form onSubmit={handleSubmit} className={s.createUserForm}>
                {error && <div className={s.error}>{error}</div>}
                {success && <div className={s.success}>{success}</div>}
                
                <div className={s.formSection}>
                    <h3 className={s.sectionTitle}>📋 Basic Information</h3>
                    <div className={s.formGroup}>
                        <label>Full Name</label>
                        <input required value={form.full_name} onChange={e => setForm({ ...form, full_name: e.target.value })} placeholder="e.g. John Doe" />
                    </div>
                    <div className={s.formGroup}>
                        <label>Username</label>
                        <input required value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} placeholder="e.g. johndoe" />
                    </div>
                    <div className={s.formGroup}>
                        <label>Email</label>
                        <input type="email" required value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="e.g. john@example.com" />
                    </div>
                    <div className={s.formGroup}>
                        <label>Initial Password</label>
                        <input type="password" required minLength={8} value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} placeholder="Minimum 8 characters" />
                        <small className={s.hint}>💡 User will be required to change this on first login</small>
                    </div>
                </div>
                
                <div className={s.formSection}>
                    <h3 className={s.sectionTitle}>👥 Role & Organization</h3>
                    <div className={s.formGroup}>
                        <label>Role</label>
                        <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}>
                            {ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                        </select>
                    </div>
                    {isSuperAdmin && (
                        <div className={s.formGroup}>
                            <label>Organization</label>
                            <select value={form.org_id} onChange={e => { setForm({ ...form, org_id: e.target.value, department_id: '', team_id: '', manager_id: '' }); }}>
                                <option value="">None</option>
                                {organizations.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                            </select>
                        </div>
                    )}
                </div>
                
                <div className={s.formSection}>
                    <h3 className={s.sectionTitle}>🏛️ Assignment</h3>
                    <div className={s.formGroup}>
                        <label>Department</label>
                        <select value={form.department_id} onChange={e => setForm({ ...form, department_id: e.target.value, team_id: '' })}>
                            <option value="">None</option>
                            {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                        </select>
                    </div>
                    <div className={s.formGroup}>
                        <label>Team</label>
                        <select value={form.team_id} onChange={e => setForm({ ...form, team_id: e.target.value })}>
                            <option value="">None</option>
                            {filteredTeams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </select>
                    </div>
                    <div className={s.formGroup}>
                        <label>Manager</label>
                        <select value={form.manager_id} onChange={e => setForm({ ...form, manager_id: e.target.value })}>
                            <option value="">None</option>
                            {managerOptions.map(u => <option key={u.id} value={u.id}>{u.full_name} ({ROLE_LABELS[u.role] || u.role})</option>)}
                        </select>
                    </div>
                </div>
            
            <div className={s['form-footer']}>
                <button type="submit" className={`${s.btnPrimary} ${s['btn-submit']}`}>
                    ✅ Create User Account
                </button>
            </div>
            </form>
        </div>
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
        getAuditLogs(params).then(r => { setLogs(r.data.logs); setTotal(r.data.total); }).catch(e => console.error(e));
    }, [page, filters]);

    useEffect(() => { fetchLogs(); }, [fetchLogs]);

    const totalPages = Math.ceil(total / pageSize);

    return (
        <>
            <h2 className={s['section-heading']}>📋 Audit Logs</h2>
            <p className={s['section-desc']}>
                Track all administrative actions and system events
            </p>
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
                <span className={s['text-muted-sm']}>{total} log(s)</span>
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
                            <td className={s['audit-time']}>{new Date(log.created_at + 'Z').toLocaleString()}</td>
                            <td>{log.actor_name || log.actor_username || `User #${log.actor_id}`}</td>
                            <td><span className={`${s.badge} ${s['badge-accent']}`}>{log.action}</span></td>
                            <td>{log.entity_type}{log.entity_id ? ` #${log.entity_id}` : ''}</td>
                            <td className={s['audit-details']}>
                                {log.details ? JSON.stringify(JSON.parse(log.details)) : '—'}
                            </td>
                            <td className={s['text-xs']}>{log.ip_address || '—'}</td>
                        </tr>
                    ))}
                    {logs.length === 0 && (
                        <tr><td colSpan={6} className={s.emptyRow}>No logs found</td></tr>
                    )}
                </tbody>
            </table>

            {totalPages > 1 && (
                <div className={s.pagination}>
                    <button disabled={page === 0} onClick={() => setPage(p => p - 1)}>Previous</button>
                    <span className={s['text-muted-sm']}>Page {page + 1} of {totalPages}</span>
                    <button disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>Next</button>
                </div>
            )}
        </>
    );
}

function OrganizationsTab({ userRole, hasOrgId }) {
    const isSuperAdmin = userRole === 'super_admin';
    const [orgRefreshKey, setOrgRefreshKey] = useState(0);

    return (
        <>
            {isSuperAdmin && (
                <>
                    <h2 className={s['heading-mb']}>All Organizations</h2>
                    <OrganizationsManagement onOrgChange={() => setOrgRefreshKey(k => k + 1)} />
                </>
            )}
            {hasOrgId && (
                <>
                    {isSuperAdmin && <hr className={s['section-divider']} />}
                    <MyOrganization userRole={userRole} refreshKey={orgRefreshKey} />
                </>
            )}
        </>
    );
}

function OrganizationsManagement({ onOrgChange }) {
    const [orgs, setOrgs] = useState([]);
    const [creating, setCreating] = useState(false);
    const [editing, setEditing] = useState(null);
    const [deleting, setDeleting] = useState(null);
    const [msg, setMsg] = useAutoDismiss('');

    const fetchOrgs = useCallback(() => {
        getAdminOrganizations().then(r => setOrgs(r.data)).catch(e => console.error(e));
    }, []);

    useEffect(() => { fetchOrgs(); }, [fetchOrgs]);

    const handleCreate = async (data) => {
        try {
            await createAdminOrganization(data);
            setMsg('Organization created successfully');
            setCreating(false);
            fetchOrgs();
            onOrgChange?.();
        } catch (e) { setMsg(e.response?.data?.error || 'Failed to create organization'); }
    };

    const handleUpdate = async (id, data) => {
        try {
            await updateAdminOrganization(id, data);
            setMsg('Organization updated successfully');
            setEditing(null);
            fetchOrgs();
            onOrgChange?.();
        } catch (e) { setMsg(e.response?.data?.error || 'Failed to update organization'); }
    };

    const handleDelete = async (id) => {
        try {
            const result = await deleteAdminOrganization(id);
            setMsg(result.data.message);
            setDeleting(null);
            fetchOrgs();
            onOrgChange?.();
        } catch (e) { setMsg(e.response?.data?.error || 'Failed to delete organization'); }
    };

    return (
        <>
            <h2 className={s.sectionHeading}>🏢 All Organizations</h2>
            <p className={s.sectionDesc}>Manage all organizations in the system</p>
            {msg && <div className={s.success}>{msg}</div>}
            <div className={s.toolbar}>
                <button className={s.btnPrimary} onClick={() => setCreating(true)}>➕ Create Organization</button>
            </div>

            <table className={s.table}>
                <thead>
                    <tr>
                        <th>Name</th>
                        <th>Slug</th>
                        <th>Timezone</th>
                        <th>Work Hours</th>
                        <th>Work Days</th>
                        <th>Members</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    {orgs.map(o => (
                        <tr key={o.id}>
                            <td className={s['font-bold']}>{o.name}</td>
                            <td><code className={s['text-muted-xs']}>{o.slug}</code></td>
                            <td className={s['text-sm']}>{o.timezone || 'UTC'}</td>
                            <td>{o.work_hours_per_day || 8}h</td>
                            <td className={s['text-sm']}>{o.work_days || '1,2,3,4,5'}</td>
                            <td>{o.member_count}</td>
                            <td>
                                <div className={s.actions}>
                                    <button className={`${s.btnSmall} ${s.btnAccent}`} onClick={() => setEditing(o)} title="Edit organization">✏️ Edit</button>
                                    <button className={`${s.btnSmall} ${s.btnDanger}`} onClick={() => setDeleting(o)} title="Delete organization">🗑️ Delete</button>
                                </div>
                            </td>
                        </tr>
                    ))}
                    {orgs.length === 0 && (
                        <tr><td colSpan={7} className={s.emptyRow}>No organizations found</td></tr>
                    )}
                </tbody>
            </table>

            {creating && <OrgModal onClose={() => setCreating(false)} onSave={handleCreate} />}
            {editing && <OrgModal org={editing} onClose={() => setEditing(null)} onSave={(data) => handleUpdate(editing.id, data)} />}
            {deleting && (
                <div className={s.modalOverlay} onClick={() => setDeleting(null)}>
                    <div className={s.modal} onClick={e => e.stopPropagation()}>
                        <h2>Delete Organization</h2>
                        <p>Are you sure you want to delete <strong>{deleting.name}</strong>?</p>
                        <p className={s['org-delete-info']}>
                            This will remove all departments, teams, and clear org assignments for inactive users. 
                            Organizations with active users cannot be deleted.
                        </p>
                        <div className={s.formActions}>
                            <button className={s.btnCancel} onClick={() => setDeleting(null)}>Cancel</button>
                            <button className={`${s.btnPrimary} ${s.btnDanger}`} onClick={() => handleDelete(deleting.id)}>Delete Organization</button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}

function OrgModal({ org, onClose, onSave }) {
    const [form, setForm] = useState({
        name: org?.name || '',
        work_hours_per_day: org?.work_hours_per_day ?? 8,
        work_days: org?.work_days || '1,2,3,4,5',
        timezone: org?.timezone || 'UTC',
        fiscal_year_start: org?.fiscal_year_start ?? 1
    });
    const [error, setError] = useAutoDismiss('');

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        try {
            await onSave(form);
        } catch (e) { setError(e.response?.data?.error || 'Failed'); }
    };

    return (
        <div className={s.modalOverlay} onClick={onClose}>
            <div className={s.modal} onClick={e => e.stopPropagation()}>
                <h2>{org ? 'Edit Organization' : 'Create Organization'}</h2>
                {error && <div className={s.error}>{error}</div>}
                <form onSubmit={handleSubmit}>
                    <div className={s.formGroup}>
                        <label>Organization Name</label>
                        <input required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Acme Corp" disabled={!!org} />
                        {org && <small className={s.hint}>Name cannot be changed after creation</small>}
                    </div>
                    <div className={s.formGroup}>
                        <label>Work Hours Per Day</label>
                        <input type="number" min="1" max="24" step="0.5" value={form.work_hours_per_day} onChange={e => setForm({ ...form, work_hours_per_day: e.target.value })} />
                    </div>
                    <div className={s.formGroup}>
                        <label>Work Days (comma-separated, 0=Sun, 6=Sat)</label>
                        <input value={form.work_days} onChange={e => setForm({ ...form, work_days: e.target.value })} placeholder="1,2,3,4,5" />
                        <small className={s.hint}>Example: 1,2,3,4,5 for Mon-Fri</small>
                    </div>
                    <div className={s.formGroup}>
                        <label>Timezone</label>
                        <input value={form.timezone} onChange={e => setForm({ ...form, timezone: e.target.value })} placeholder="UTC" />
                    </div>
                    <div className={s.formGroup}>
                        <label>Fiscal Year Start Month (1-12)</label>
                        <input type="number" min="1" max="12" value={form.fiscal_year_start} onChange={e => setForm({ ...form, fiscal_year_start: e.target.value })} />
                    </div>
                    <div className={s.formActions}>
                        <button type="button" className={s.btnCancel} onClick={onClose}>Cancel</button>
                        <button type="submit" className={s.btnPrimary}>{org ? 'Update' : 'Create'}</button>
                    </div>
                </form>
            </div>
        </div>
    );
}

// ==================== MY ORGANIZATION ====================

function MyOrganization({ userRole, refreshKey }) {
    const { updateUser } = useAuth();
    const [org, setOrg] = useState(null);
    const [loading, setLoading] = useState(true);
    const [tab, setTab] = useState('departments');

    const fetchOrg = useCallback(() => {
        getCurrentOrg().then(r => { setOrg(r.data); setLoading(false); }).catch(() => setLoading(false));
    }, []);

    useEffect(() => { fetchOrg(); }, [fetchOrg, refreshKey]);

    if (loading) return <div>Loading...</div>;

    if (!org) {
        return (
            <div>
                <p className={s['no-org-msg']}>
                    You are not assigned to any organization yet. Please contact your administrator.
                </p>
            </div>
        );
    }

    return (
        <>
            <h2 className={s.sectionHeading}>🏛️ My Organization</h2>
            <h3 className={s['org-subtitle']}>{org.name}</h3>

            <div className={`${s.statsGrid} ${s['stats-compact']}`}>
                <div className={s.statCard}>
                    <div className={s.statIcon}>👥</div>
                    <div className={s.value}>{org.memberCount}</div>
                    <div className={s.label}>Members</div>
                </div>
                <div className={s.statCard}>
                    <div className={s.statIcon}>🏛️</div>
                    <div className={s.value}>{org.deptCount}</div>
                    <div className={s.label}>Departments</div>
                </div>
                <div className={s.statCard}>
                    <div className={s.statIcon}>👨‍👩‍👧‍👦</div>
                    <div className={s.value}>{org.teamCount}</div>
                    <div className={s.label}>Teams</div>
                </div>
                <div className={s.statCard}>
                    <div className={s.statIcon}>⏰</div>
                    <div className={s.value}>{org.work_hours_per_day}h</div>
                    <div className={s.label}>Work Hours/Day</div>
                </div>
            </div>

            <div className={s.tabs}>
                <button className={`${s.tab} ${tab === 'departments' ? s.active : ''}`} onClick={() => setTab('departments')}>
                    <span>🏛️</span> Departments
                </button>
                <button className={`${s.tab} ${tab === 'teams' ? s.active : ''}`} onClick={() => setTab('teams')}>
                    <span>👨‍👩‍👧‍👦</span> Teams
                </button>
                <button className={`${s.tab} ${tab === 'chart' ? s.active : ''}`} onClick={() => setTab('chart')}>
                    <span>🌳</span> Org Chart
                </button>
                <button className={`${s.tab} ${tab === 'overview' ? s.active : ''}`} onClick={() => setTab('overview')}>
                    <span>⚙️</span> Settings
                </button>
            </div>

            <div className={s['tab-content']}>
                {tab === 'overview' && <OrgSettings org={org} onUpdate={fetchOrg} userRole={userRole} />}
                {tab === 'departments' && <Departments orgId={org.id} userRole={userRole} />}
                {tab === 'teams' && <Teams orgId={org.id} userRole={userRole} />}
                {tab === 'chart' && <OrgChartView />}
            </div>
        </>
    );
}

function OrgSettings({ org, onUpdate, userRole }) {
    const [form, setForm] = useState({
        name: org.name,
        work_hours_per_day: org.work_hours_per_day,
        work_days: org.work_days,
        timezone: org.timezone,
        fiscal_year_start: org.fiscal_year_start
    });
    const [msg, setMsg] = useAutoDismiss('');
    const canEdit = ['hr_admin', 'super_admin'].includes(userRole);

    const handleSave = async (e) => {
        e.preventDefault();
        try {
            await updateOrgSettings(form);
            setMsg('Settings saved');
            onUpdate();
        } catch (e) { setMsg(e.response?.data?.error || 'Failed'); }
    };

    return (
        <form onSubmit={handleSave} className={s['form-container-sm']}>
            {msg && <div className={s.success}>{msg}</div>}
            <div className={s.formGroup}>
                <label>Organization Name</label>
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} disabled={!canEdit} />
            </div>
            <div className={s.formGroup}>
                <label>Work Hours Per Day</label>
                <input type="number" step="0.5" min="1" max="24" value={form.work_hours_per_day} onChange={e => setForm({ ...form, work_hours_per_day: e.target.value })} disabled={!canEdit} />
            </div>
            <div className={s.formGroup}>
                <label>Work Days (comma-separated: 1=Mon, 7=Sun)</label>
                <input value={form.work_days} onChange={e => setForm({ ...form, work_days: e.target.value })} placeholder="1,2,3,4,5" disabled={!canEdit} />
            </div>
            <div className={s.formGroup}>
                <label>Timezone</label>
                <input value={form.timezone} onChange={e => setForm({ ...form, timezone: e.target.value })} disabled={!canEdit} />
            </div>
            <div className={s.formGroup}>
                <label>Fiscal Year Start Month (1-12)</label>
                <input type="number" min="1" max="12" value={form.fiscal_year_start} onChange={e => setForm({ ...form, fiscal_year_start: e.target.value })} disabled={!canEdit} />
            </div>
            {canEdit && <button type="submit" className={s.btnPrimary}>Save Settings</button>}
        </form>
    );
}

function Departments({ orgId, userRole }) {
    const [departments, setDepartments] = useState([]);
    const [members, setMembers] = useState([]);
    const [showForm, setShowForm] = useState(false);
    const [name, setName] = useState('');
    const [headId, setHeadId] = useState('');
    const [editId, setEditId] = useState(null);
    const [editName, setEditName] = useState('');
    const [editHeadId, setEditHeadId] = useState('');
    const [msg, setMsg] = useAutoDismiss('');
    const canManage = ['manager', 'hr_admin', 'super_admin'].includes(userRole);

    const fetchDepts = useCallback(() => {
        getOrgDepartments().then(r => setDepartments(r.data)).catch(e => console.error(e));
    }, []);

    useEffect(() => { fetchDepts(); }, [fetchDepts]);

    useEffect(() => {
        if (canManage) {
            getOrgMembers({ is_active: true }).then(r => setMembers(r.data?.data ?? r.data)).catch(e => console.error(e));
        }
    }, [canManage]);

    const handleCreate = async (e) => {
        e.preventDefault();
        try {
            await createDepartment({ name, head_id: headId || null });
            setName('');
            setHeadId('');
            setShowForm(false);
            fetchDepts();
        } catch (e) { setMsg(e.response?.data?.error || 'Failed'); }
    };

    const handleUpdate = async (id) => {
        try {
            await updateDepartment(id, { name: editName, head_id: editHeadId || null });
            setEditId(null);
            fetchDepts();
        } catch (e) { setMsg(e.response?.data?.error || 'Failed'); }
    };

    const handleDelete = async (id) => {
        if (!confirm('Delete this department? Members will be unassigned.')) return;
        try {
            await deleteDepartment(id);
            fetchDepts();
        } catch (e) { setMsg(e.response?.data?.error || 'Failed'); }
    };

    return (
        <>
            {msg && <div className={s.success}>{msg}</div>}
            {canManage && (
                <div className={s['form-toolbar']}>
                    {showForm ? (
                        <form onSubmit={handleCreate} className={s['inline-form']}>
                            <input value={name} onChange={e => setName(e.target.value)} placeholder="Department name" required className={s['form-inline-input']} />
                            <select value={headId} onChange={e => setHeadId(e.target.value)} className={s['form-inline-input']}>
                                <option value="">No Head</option>
                                {members.map(m => <option key={m.id} value={m.id}>{m.full_name || m.username}</option>)}
                            </select>
                            <button type="submit" className={s.btnPrimary}>Add</button>
                            <button type="button" className={s.btnCancel} onClick={() => setShowForm(false)}>Cancel</button>
                        </form>
                    ) : (
                        <button className={s.btnPrimary} onClick={() => setShowForm(true)}>+ Add Department</button>
                    )}
                </div>
            )}
            <table className={s.table}>
                <thead><tr><th>Name</th><th>Head</th><th>Members</th>{canManage && <th>Actions</th>}</tr></thead>
                <tbody>
                    {departments.map(d => (
                        <tr key={d.id}>
                            <td>{editId === d.id ? <input value={editName} onChange={e => setEditName(e.target.value)} className={s['edit-inline-input']} /> : d.name}</td>
                            <td>{editId === d.id ? (
                                <select value={editHeadId} onChange={e => setEditHeadId(e.target.value)} className={s['edit-inline-input']}>
                                    <option value="">No Head</option>
                                    {members.map(m => <option key={m.id} value={m.id}>{m.full_name || m.username}</option>)}
                                </select>
                            ) : (d.head_name || '—')}</td>
                            <td>{d.member_count}</td>
                            {canManage && (
                                <td>
                                    <div className={s.actions}>
                                        {editId === d.id ? (
                                            <>
                                                <button className={`${s.btnSmall} ${s.btnAccent}`} onClick={() => handleUpdate(d.id)}>Save</button>
                                                <button className={`${s.btnSmall} ${s.btnSecondary}`} onClick={() => setEditId(null)}>Cancel</button>
                                            </>
                                        ) : (
                                            <>
                                                <button className={`${s.btnSmall} ${s.btnAccent}`} onClick={() => { setEditId(d.id); setEditName(d.name); setEditHeadId(d.head_id || ''); }}>Edit</button>
                                                <button className={`${s.btnSmall} ${s.btnDanger}`} onClick={() => handleDelete(d.id)}>Delete</button>
                                            </>
                                        )}
                                    </div>
                                </td>
                            )}
                        </tr>
                    ))}
                    {departments.length === 0 && <tr><td colSpan={4} className={s.emptyRow}>No departments yet</td></tr>}
                </tbody>
            </table>
        </>
    );
}

function Teams({ orgId, userRole }) {
    const [teams, setTeams] = useState([]);
    const [departments, setDepartments] = useState([]);
    const [members, setMembers] = useState([]);
    const [showForm, setShowForm] = useState(false);
    const [form, setForm] = useState({ name: '', department_id: '', lead_id: '' });
    const [editId, setEditId] = useState(null);
    const [editForm, setEditForm] = useState({ name: '', department_id: '', lead_id: '', sprint_duration_weeks: 2, sprint_start_date: '' });
    const [msg, setMsg] = useAutoDismiss('');
    const canManage = ['team_lead', 'manager', 'hr_admin', 'super_admin'].includes(userRole);

    const fetchTeams = useCallback(() => {
        getOrgTeams().then(r => setTeams(r.data)).catch(e => console.error(e));
        getOrgDepartments().then(r => setDepartments(r.data)).catch(e => console.error(e));
    }, []);

    useEffect(() => { fetchTeams(); }, [fetchTeams]);

    useEffect(() => {
        if (canManage) {
            getOrgMembers({ is_active: true }).then(r => setMembers(r.data?.data ?? r.data)).catch(e => console.error(e));
        }
    }, [canManage]);

    const handleCreate = async (e) => {
        e.preventDefault();
        try {
            await createTeam({ name: form.name, department_id: form.department_id || null, lead_id: form.lead_id || null });
            setForm({ name: '', department_id: '', lead_id: '' });
            setShowForm(false);
            fetchTeams();
        } catch (e) { setMsg(e.response?.data?.error || 'Failed'); }
    };

    const handleUpdate = async (id) => {
        try {
            await updateTeam(id, { name: editForm.name, department_id: editForm.department_id || null, lead_id: editForm.lead_id || null });
            if (editForm.sprint_duration_weeks || editForm.sprint_start_date) {
                await updateTeamSprintConfig(id, {
                    sprint_duration_weeks: editForm.sprint_duration_weeks || 2,
                    sprint_start_date: editForm.sprint_start_date || null
                });
            }
            setEditId(null);
            fetchTeams();
        } catch (e) { setMsg(e.response?.data?.error || 'Failed'); }
    };

    const handleDelete = async (id) => {
        if (!confirm('Delete this team? Members will be unassigned.')) return;
        try { await deleteTeam(id); fetchTeams(); } catch (e) { setMsg(e.response?.data?.error || 'Failed'); }
    };

    return (
        <>
            {msg && <div className={s.success}>{msg}</div>}
            {canManage && (
                <div className={s['form-toolbar']}>
                    {showForm ? (
                        <form onSubmit={handleCreate} className={s['inline-form']}>
                            <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Team name" required className={s['form-inline-input']} />
                            <select value={form.department_id} onChange={e => setForm({ ...form, department_id: e.target.value })} className={s['form-inline-input']}>
                                <option value="">No department</option>
                                {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                            </select>
                            <select value={form.lead_id} onChange={e => setForm({ ...form, lead_id: e.target.value })} className={s['form-inline-input']}>
                                <option value="">No Lead</option>
                                {members.map(m => <option key={m.id} value={m.id}>{m.full_name || m.username}</option>)}
                            </select>
                            <button type="submit" className={s.btnPrimary}>Add</button>
                            <button type="button" className={s.btnCancel} onClick={() => setShowForm(false)}>Cancel</button>
                        </form>
                    ) : (
                        <button className={s.btnPrimary} onClick={() => setShowForm(true)}>+ Add Team</button>
                    )}
                </div>
            )}
            <table className={s.table}>
                <thead><tr><th>Name</th><th>Department</th><th>Lead</th><th>Members</th><th>Sprint Config</th>{canManage && <th>Actions</th>}</tr></thead>
                <tbody>
                    {teams.map(t => (
                        <React.Fragment key={t.id}>
                        <tr>
                            <td>{editId === t.id ? <input value={editForm.name} onChange={e => setEditForm({ ...editForm, name: e.target.value })} className={s['edit-inline-input']} /> : t.name}</td>
                            <td>{editId === t.id ? (
                                <select value={editForm.department_id} onChange={e => setEditForm({ ...editForm, department_id: e.target.value })} className={s['edit-inline-input']}>
                                    <option value="">No department</option>
                                    {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                                </select>
                            ) : (t.department_name || '—')}</td>
                            <td>{editId === t.id ? (
                                <select value={editForm.lead_id} onChange={e => setEditForm({ ...editForm, lead_id: e.target.value })} className={s['edit-inline-input']}>
                                    <option value="">No Lead</option>
                                    {members.map(m => <option key={m.id} value={m.id}>{m.full_name || m.username}</option>)}
                                </select>
                            ) : (t.lead_name || '—')}</td>
                            <td>{t.member_count}</td>
                            <td className={s['text-muted-sm']}>
                                {t.sprint_duration_weeks ? `${t.sprint_duration_weeks} week${t.sprint_duration_weeks > 1 ? 's' : ''}` : 'Not set'}
                                {t.sprint_start_date && ` (from ${t.sprint_start_date})`}
                            </td>
                            {canManage && (
                                <td>
                                    <div className={s.actions}>
                                        {editId === t.id ? (
                                            <>
                                                <button className={`${s.btnSmall} ${s.btnAccent}`} onClick={() => handleUpdate(t.id)}>Save</button>
                                                <button className={`${s.btnSmall} ${s.btnSecondary}`} onClick={() => setEditId(null)}>Cancel</button>
                                            </>
                                        ) : (
                                            <>
                                                <button className={`${s.btnSmall} ${s.btnAccent}`} onClick={async () => {
                                                    setEditId(t.id);
                                                    setEditForm({ name: t.name, department_id: t.department_id || '', lead_id: t.lead_id || '', sprint_duration_weeks: 2, sprint_start_date: '' });
                                                    try {
                                                        const sprintRes = await getTeamSprintConfig(t.id);
                                                        setEditForm(prev => ({
                                                            ...prev,
                                                            sprint_duration_weeks: sprintRes.data.sprintDurationWeeks || 2,
                                                            sprint_start_date: sprintRes.data.sprintStartDate || ''
                                                        }));
                                                    } catch (err) { console.error('Failed to load sprint config:', err); }
                                                }}>Edit</button>
                                                <button className={`${s.btnSmall} ${s.btnDanger}`} onClick={() => handleDelete(t.id)}>Delete</button>
                                            </>
                                        )}
                                    </div>
                                </td>
                            )}
                        </tr>
                        {editId === t.id && (
                            <tr className={s['sprint-edit-row']}>
                                <td colSpan={canManage ? 7 : 6} className={s['sprint-edit-cell']}>
                                    <div className={s['sprint-config-form']}>
                                        <div className={s['sprint-field']}>
                                            <label className={s['field-label']}>🏃 Sprint Duration (weeks)</label>
                                            <input
                                                type="number"
                                                min="1"
                                                max="8"
                                                value={editForm.sprint_duration_weeks || 2}
                                                onChange={e => setEditForm({ ...editForm, sprint_duration_weeks: parseInt(e.target.value) || 2 })}
                                                className={s['edit-inline-input']}
                                                placeholder="2"
                                            />
                                            <small className={s['field-hint']}>Length of each sprint (1-8 weeks)</small>
                                        </div>
                                        <div className={s['sprint-field']}>
                                            <label className={s['field-label']}>📅 Sprint Start Date</label>
                                            <input
                                                type="date"
                                                value={editForm.sprint_start_date || ''}
                                                onChange={e => setEditForm({ ...editForm, sprint_start_date: e.target.value })}
                                                className={s['edit-inline-input']}
                                            />
                                            <small className={s['field-hint']}>First sprint's start date (sprints auto-calculated from this)</small>
                                        </div>
                                    </div>
                                </td>
                            </tr>
                        )}
                        </React.Fragment>
                    ))}
                    {teams.length === 0 && <tr><td colSpan={canManage ? 7 : 6} className={s.emptyRow}>No teams yet</td></tr>}
                </tbody>
            </table>
        </>
    );
}

function OrgChartView() {
    const [chart, setChart] = useState(null);

    useEffect(() => {
        getOrgChart().then(r => setChart(r.data)).catch(e => console.error(e));
    }, []);

    if (!chart) return <div>Loading...</div>;

    const unassigned = chart.members.filter(m => !m.department_id && !m.team_id);

    return (
        <div>
            {chart.departments.map(dept => {
                const deptTeams = chart.teams.filter(t => t.department_id === dept.id);
                const deptMembers = chart.members.filter(m => m.department_id === dept.id && !m.team_id);
                return (
                    <div key={dept.id} className={s['card-panel']}>
                        <div className={s['dept-header']}>
                            <span className={s['dept-icon']}>🏢</span>
                            <div>
                                <div className={s['dept-name']}>{dept.name}</div>
                                {dept.head_name && <div className={s['text-muted-xs']}>Head: {dept.head_name}</div>}
                            </div>
                        </div>
                        {deptTeams.map(team => {
                            const tMembers = chart.members.filter(m => m.team_id === team.id);
                            return (
                                <div key={team.id} className={s['team-card']}>
                                    <div className={s['team-title']}>👥 {team.name} {team.lead_name && <span className={s['team-lead-label']}>• Lead: {team.lead_name}</span>}</div>
                                    <div className={s['flex-wrap']}>
                                        {tMembers.map(m => (
                                            <div key={m.id} className={s['member-chip']}>
                                                {m.avatar ? <img src={m.avatar} className={`${s.miniAvatar} ${s['mini-avatar-sm']}`} alt="" /> : <span className={`${s.initials} ${s['mini-initials-sm']}`}>{m.full_name?.charAt(0)}</span>}
                                                {m.full_name}
                                                <span className={`${s.badgeRole} ${s['badge-sm']}`} data-role={m.role}>{ROLE_LABELS[m.role]}</span>
                                            </div>
                                        ))}
                                        {tMembers.length === 0 && <span className={s['text-muted-xs']}>No members</span>}
                                    </div>
                                </div>
                            );
                        })}
                        {deptMembers.length > 0 && (
                            <div className={s['unassigned-section']}>
                                <div className={s['unassigned-label']}>Unassigned to team:</div>
                                <div className={s['flex-wrap']}>
                                    {deptMembers.map(m => (
                                        <div key={m.id} className={s['member-chip-simple']}>{m.full_name}</div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                );
            })}
            {unassigned.length > 0 && (
                <div className={s['card-panel']}>
                    <div className={s['bold-heading']}>Unassigned Members</div>
                    <div className={s['flex-wrap']}>
                        {unassigned.map(m => (
                            <div key={m.id} className={s['member-chip-simple']}>
                                {m.full_name} <span className={`${s.badgeRole} ${s['badge-sm']}`} data-role={m.role}>{ROLE_LABELS[m.role]}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

// ─── Task Labels Management ─────────────────────────────────────────────
function TaskLabelsTab() {
    const [labels, setLabels] = useState([]);
    const [loading, setLoading] = useState(true);
    const [name, setName] = useState('');
    const [color, setColor] = useState('#6366f1');
    const [editId, setEditId] = useState(null);
    const [editName, setEditName] = useState('');
    const [editColor, setEditColor] = useState('#6366f1');
    const [error, setError] = useAutoDismiss('');
    const [success, setSuccess] = useAutoDismiss('');

    const PRESET_COLORS = ['#6366f1', '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#64748b'];

    const fetchLabels = useCallback(async () => {
        try {
            const res = await getAdminTaskLabels();
            setLabels(res.data);
        } catch { setError('Failed to load labels'); }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { fetchLabels(); }, [fetchLabels]);

    const handleCreate = async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        try {
            await createAdminTaskLabel({ name, color });
            setName('');
            setColor('#6366f1');
            setSuccess('Label created');
            fetchLabels();
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to create label');
        }
    };

    const startEdit = (label) => {
        setEditId(label.id);
        setEditName(label.name);
        setEditColor(label.color);
    };

    const saveEdit = async () => {
        if (!editName.trim()) return;
        try {
            await updateAdminTaskLabel(editId, { name: editName, color: editColor });
            setEditId(null);
            setSuccess('Label updated');
            fetchLabels();
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to update label');
        }
    };

    const handleDelete = async (id) => {
        if (!confirm('Delete this label? It will be removed from all tasks.')) return;
        try {
            await deleteAdminTaskLabel(id);
            setSuccess('Label deleted');
            fetchLabels();
        } catch {
            setError('Failed to delete label');
        }
    };

    if (loading) return <div className="loading-spinner"><div className="spinner" /></div>;

    return (
        <div className={s.section}>
            <h3 className={s.sectionTitle}>🏷️ Task Labels</h3>
            <p className={s['section-desc-muted']}>
                Create labels that members of your organization can use to categorize tasks.
            </p>

            {error && <div className="error-msg error-msg-mb">{error}</div>}
            {success && <div className={`success-msg ${s['mb-1']}`}>{success}</div>}

            {/* Create Label Form */}
            <form onSubmit={handleCreate} className={s['label-form']}>
                <div className={`form-group ${s['label-form-group']}`}>
                    <label>Label Name</label>
                    <input
                        type="text"
                        value={name}
                        onChange={e => setName(e.target.value)}
                        placeholder="e.g. Bug, Feature, Urgent"
                        maxLength={30}
                        required
                    />
                </div>
                <div className={`form-group ${s['form-group-compact']}`}>
                    <label>Color</label>
                    <div className={s['color-picker-row']}>
                        {PRESET_COLORS.map(c => (
                            <button
                                key={c}
                                type="button"
                                onClick={() => setColor(c)}
                                className={s['color-swatch']}
                                style={{
                                    border: color === c ? '2px solid var(--text)' : '2px solid transparent',
                                    background: c
                                }}
                            />
                        ))}
                        <input type="color" value={color} onChange={e => setColor(e.target.value)} className={s['color-input']} />
                    </div>
                </div>
                <button type="submit" className={`btn btn-primary ${s['btn-add-label']}`}>
                    Add Label
                </button>
            </form>

            {/* Labels Table */}
            {labels.length === 0 ? (
                <p className={s['empty-message']}>No labels yet. Create one above!</p>
            ) : (
                <div className={s['overflow-auto']}>
                    <table className={s.table}>
                        <thead>
                            <tr>
                                <th>Label</th>
                                <th>Created By</th>
                                <th className={s['col-actions']}>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {labels.map(label => (
                                <tr key={label.id}>
                                    <td>
                                        {editId === label.id ? (
                                            <div className={s['edit-label-row']}>
                                                <input
                                                    type="text"
                                                    value={editName}
                                                    onChange={e => setEditName(e.target.value)}
                                                    maxLength={30}
                                                    className={s['edit-label-input']}
                                                />
                                                <input type="color" value={editColor} onChange={e => setEditColor(e.target.value)} className={s['color-input']} />
                                            </div>
                                        ) : (
                                            <span className={s['label-display']}>
                                                <span className={s['label-badge']} style={{ background: label.color }}>{label.name}</span>
                                            </span>
                                        )}
                                    </td>
                                    <td className={s['text-sm-muted']}>
                                        {label.created_by_username || '—'}
                                    </td>
                                    <td>
                                        {editId === label.id ? (
                                            <div className={s['actions-row']}>
                                                <button className="btn btn-primary btn-sm" onClick={saveEdit}>Save</button>
                                                <button className="btn btn-secondary btn-sm" onClick={() => setEditId(null)}>Cancel</button>
                                            </div>
                                        ) : (
                                            <div className={s['actions-row']}>
                                                <button className="btn btn-secondary btn-sm" onClick={() => startEdit(label)}>Edit</button>
                                                <button className="btn btn-danger btn-sm" onClick={() => handleDelete(label.id)}>Delete</button>
                                            </div>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

