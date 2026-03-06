import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useAutoDismiss } from '../../hooks/useAutoDismiss';
import {
    getAdminUsers, updateUserRole, updateUserAssignment, toggleUserActive, deleteAdminUser,
    getOrgDepartments, getOrgTeams, getAdminOrganizations
} from '../../api';
import { ROLES, ROLE_LABELS } from './constants';
import AssignmentModal from './AssignmentModal';
import ResetPasswordModal from './ResetPasswordModal';
import s from '../Admin.module.css';
import sf from './AdminForms.module.css';
import su from './AdminUtils.module.css';

export default function UserManagement({ userRole }) {
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
                                        <div className={su['font-bold']}>{u.full_name}</div>
                                        <div className={s['text-muted-xs']}>@{u.username} • {u.email}</div>
                                    </div>
                                </div>
                            </td>
                            <td style={{ fontSize: '0.85rem', color: u.org_name ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{u.org_name || '—'}</td>
                            <td>
                                <select value={u.role} onChange={e => handleRoleChange(u.id, e.target.value)} className={sf.inlineSelect}>
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
                <div className={sf.modalOverlay} onClick={() => setDeletingUser(null)}>
                    <div className={sf.modal} onClick={e => e.stopPropagation()}>
                        <h2>Delete User</h2>
                        <p>Are you sure you want to permanently delete <strong>{deletingUser.full_name}</strong> (@{deletingUser.username})?</p>
                        <p className={su['delete-warning']}>⚠️ This will remove all their time entries, leaves, planner items, and other data. This action cannot be undone.</p>
                        <div className={sf.formActions}>
                            <button className={sf.btnCancel} onClick={() => setDeletingUser(null)}>Cancel</button>
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
