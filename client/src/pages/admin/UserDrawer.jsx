import React, { useEffect, useState, useMemo } from 'react';
import {
    X, KeyRound, Ban, CheckCircle2, Trash2, Save, AlertTriangle, Mail, User as UserIcon,
} from 'lucide-react';
import {
    updateUserRole, updateUserAssignment, toggleUserActive, deleteAdminUser, adminResetPassword,
    cancelRoleChange,
} from '../../api';
import { ROLES, ROLE_LABELS } from './constants';
import s from './UserManagement.module.css';

/**
 * UserDrawer — right-side editor for one user.
 *
 * Replaces inline <select>s scattered across rows + the AssignmentModal +
 * the ResetPasswordModal + the Delete confirm modal — single source of truth.
 *
 * Props:
 *   user            – user object from the list
 *   currentUser     – the logged-in admin (for self-edit guards)
 *   userRole        – current admin's role
 *   organizations   – platform_admin only: org list for re-assigning user
 *   departments     – departments visible to admin
 *   teams           – teams visible to admin
 *   allUsers        – pool for the manager dropdown
 *   pendingRequest  – role-change request currently pending for this user, if any
 *   onClose()
 *   onSaved(message)  – called after a successful change so the parent can refresh
 *   onConfirm(opts)   – ask the parent to render a typed-confirm modal:
 *                       { title, message, hint, confirmLabel, requireText, danger, onConfirm }
 */
export default function UserDrawer({
    user, currentUser, userRole, organizations = [], departments = [], teams = [],
    allUsers = [], pendingRequest, onClose, onSaved, onConfirm,
}) {
    const isPlatform = userRole === 'platform_admin';
    const isSelf = currentUser?.id === user.id;
    const isPlatformTarget = user.role === 'platform_admin';

    const [orgId, setOrgId] = useState(user.org_id || '');
    const [deptId, setDeptId] = useState(user.department_id || '');
    const [teamId, setTeamId] = useState(user.team_id || '');
    const [managerId, setManagerId] = useState(user.manager_id || '');
    const [role, setRole] = useState(user.role || 'employee');
    const [roleReason, setRoleReason] = useState('');
    const [pw, setPw] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        setOrgId(user.org_id || '');
        setDeptId(user.department_id || '');
        setTeamId(user.team_id || '');
        setManagerId(user.manager_id || '');
        setRole(user.role || 'employee');
        setRoleReason('');
        setPw('');
        setError('');
    }, [user.id]); // eslint-disable-line react-hooks/exhaustive-deps

    // Filter dropdown options against the (possibly newly-selected) org
    const filteredDepts = useMemo(() => {
        return departments.filter(d => !orgId || d.org_id === Number(orgId));
    }, [departments, orgId]);

    const filteredTeams = useMemo(() => {
        return teams.filter(t => (!orgId || t.org_id === Number(orgId)) &&
                                 (!deptId || t.department_id === Number(deptId)));
    }, [teams, orgId, deptId]);

    const managerOptions = useMemo(() => {
        return (allUsers || []).filter(u =>
            u.id !== user.id && u.is_active && (!orgId || u.org_id === Number(orgId)));
    }, [allUsers, user.id, orgId]);

    const assignmentDirty = (
        String(orgId || '') !== String(user.org_id || '') ||
        String(deptId || '') !== String(user.department_id || '') ||
        String(teamId || '') !== String(user.team_id || '') ||
        String(managerId || '') !== String(user.manager_id || '')
    );

    const roleDirty = role !== user.role;

    // ─── Action handlers ─────────────────────────────────────────────────
    const safeCall = async (fn, successMsg) => {
        setBusy(true); setError('');
        try {
            const r = await fn();
            const msg = r?.data?.message || successMsg;
            onSaved?.(msg || 'Saved');
        } catch (e) {
            setError(e.response?.data?.error || 'Action failed');
        } finally {
            setBusy(false);
        }
    };

    const handleSaveAssignment = () => {
        const payload = {
            department_id: deptId || null,
            team_id: teamId || null,
            manager_id: managerId || null,
        };
        if (isPlatform) payload.org_id = orgId || null;
        return safeCall(() => updateUserAssignment(user.id, payload), 'Assignment updated');
    };

    const handleSaveRole = () => {
        if (!role || role === user.role) return;
        return safeCall(
            () => updateUserRole(user.id, role, roleReason || undefined),
            (isPlatform || userRole === 'super_admin')
                ? 'Role updated'
                : 'Role change request submitted',
        );
    };

    const handleResetPassword = () => {
        if (pw.length < 8) { setError('Password must be at least 8 characters'); return; }
        safeCall(() => adminResetPassword(user.id, pw), 'Password reset');
    };

    const handleToggleActive = () => {
        const action = user.is_active ? 'Deactivate' : 'Activate';
        onConfirm?.({
            title: `${action} user`,
            message: `${action} ${user.full_name}?`,
            hint: user.is_active
                ? 'They will be signed out immediately and unable to log in until reactivated.'
                : 'They will be able to log in again.',
            confirmLabel: action,
            danger: user.is_active,
            onConfirm: () => safeCall(() => toggleUserActive(user.id), `User ${action.toLowerCase()}d`),
        });
    };

    const handleDelete = () => {
        onConfirm?.({
            title: 'Delete user permanently',
            message: `This will permanently delete ${user.full_name} (@${user.username}) along with all their time entries, leaves, planner items, and other data.`,
            hint: 'This action cannot be undone. Type the username to confirm.',
            confirmLabel: 'Delete permanently',
            requireText: user.username,
            danger: true,
            onConfirm: () => safeCall(() => deleteAdminUser(user.id), 'User deleted'),
        });
    };

    const handleCancelPendingRoleRequest = () => {
        if (!pendingRequest) return;
        safeCall(() => cancelRoleChange(pendingRequest.id), 'Role change request cancelled');
    };

    const canAssignRole = !isPlatformTarget && !isSelf;
    const canDelete = !isSelf && !isPlatformTarget && (userRole === 'super_admin' || userRole === 'platform_admin');

    return (
        <>
            <div className={s.drawerScrim} onClick={onClose} aria-hidden="true" />
            <aside className={s.drawer} aria-label={`Edit ${user.full_name}`}>
                {/* Header */}
                <div className={s.drawerHeader}>
                    {user.avatar
                        ? <img src={user.avatar} alt="" className={s.avatar} style={{ width: 40, height: 40 }} />
                        : <div className={s.initials} style={{ width: 40, height: 40 }}>{(user.full_name || '?').charAt(0).toUpperCase()}</div>}
                    <div style={{ minWidth: 0, flex: 1 }}>
                        <div className={s.drawerTitle}>{user.full_name}</div>
                        <div className={s.drawerSub}>@{user.username} · {user.email || 'no email'}</div>
                    </div>
                    <button className={s.drawerClose} onClick={onClose} aria-label="Close">
                        <X size={16} />
                    </button>
                </div>

                {/* Body */}
                <div className={s.drawerBody}>
                    {error && (
                        <div style={{
                            background: 'color-mix(in srgb, var(--danger) 15%, transparent)',
                            color: 'var(--danger)',
                            border: '1px solid color-mix(in srgb, var(--danger) 30%, transparent)',
                            borderRadius: 8, padding: '0.55rem 0.75rem', fontSize: 13,
                        }}>{error}</div>
                    )}

                    {pendingRequest && (
                        <div style={{
                            background: 'color-mix(in srgb, var(--warning) 12%, transparent)',
                            border: '1px solid color-mix(in srgb, var(--warning) 28%, transparent)',
                            borderRadius: 10, padding: '0.7rem 0.85rem', display: 'flex',
                            alignItems: 'center', gap: '0.55rem', flexWrap: 'wrap',
                        }}>
                            <AlertTriangle size={16} color="var(--warning)" />
                            <span style={{ fontSize: 13 }}>
                                Pending role change: <strong>{ROLE_LABELS[pendingRequest.from_role || pendingRequest.current_role]}</strong> →{' '}
                                <strong>{ROLE_LABELS[pendingRequest.requested_role || pendingRequest.to_role]}</strong>
                            </span>
                            <button
                                className={`${s.btn} ${s.secondary}`}
                                style={{ marginLeft: 'auto' }}
                                onClick={handleCancelPendingRoleRequest}
                                disabled={busy}
                            >
                                Cancel request
                            </button>
                        </div>
                    )}

                    {/* ─── Role ─── */}
                    <div className={s.section}>
                        <h4 className={s.sectionTitle}>Role</h4>
                        {canAssignRole ? (
                            <>
                                <div className={s.field}>
                                    <select value={role} onChange={e => setRole(e.target.value)} disabled={busy || !!pendingRequest}>
                                        {ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                                    </select>
                                </div>
                                {roleDirty && userRole !== 'super_admin' && userRole !== 'platform_admin' && (
                                    <div className={s.field}>
                                        <label>Reason (will be shown to approvers)</label>
                                        <input
                                            value={roleReason}
                                            onChange={e => setRoleReason(e.target.value)}
                                            placeholder="Why this change?"
                                        />
                                    </div>
                                )}
                                {roleDirty && (
                                    <div className={s.actionsRow}>
                                        <button
                                            className={s.btn}
                                            onClick={handleSaveRole}
                                            disabled={busy || !!pendingRequest}
                                        >
                                            <Save size={14} />
                                            {(userRole === 'super_admin' || userRole === 'platform_admin')
                                                ? 'Update role'
                                                : 'Submit role request'}
                                        </button>
                                    </div>
                                )}
                            </>
                        ) : (
                            <div className={s.lockedField}>
                                {ROLE_LABELS[user.role] || user.role}
                                {isSelf && <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.8 }}>(you can't change your own role)</span>}
                                {isPlatformTarget && <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.8 }}>(platform admin)</span>}
                            </div>
                        )}
                    </div>

                    {/* ─── Assignment ─── */}
                    <div className={s.section}>
                        <h4 className={s.sectionTitle}>Assignment</h4>
                        {isPlatform && (
                            <div className={s.field}>
                                <label>Organization</label>
                                <select
                                    value={orgId}
                                    onChange={e => { setOrgId(e.target.value); setDeptId(''); setTeamId(''); setManagerId(''); }}
                                    disabled={busy}
                                >
                                    <option value="">— None —</option>
                                    {organizations.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                                </select>
                            </div>
                        )}
                        <div className={s.field}>
                            <label>Department</label>
                            <select
                                value={deptId}
                                onChange={e => { setDeptId(e.target.value); setTeamId(''); }}
                                disabled={busy || (isPlatform && !orgId)}
                            >
                                <option value="">— None —</option>
                                {filteredDepts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                            </select>
                        </div>
                        <div className={s.field}>
                            <label>Team</label>
                            <select
                                value={teamId}
                                onChange={e => setTeamId(e.target.value)}
                                disabled={busy || (isPlatform && !orgId)}
                            >
                                <option value="">— None —</option>
                                {filteredTeams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                            </select>
                        </div>
                        {!isPlatformTarget && (
                            <div className={s.field}>
                                <label>Manager</label>
                                <select
                                    value={managerId}
                                    onChange={e => setManagerId(e.target.value)}
                                    disabled={busy || (isPlatform && !orgId)}
                                >
                                    <option value="">— None —</option>
                                    {managerOptions.map(m => (
                                        <option key={m.id} value={m.id}>
                                            {m.full_name} ({ROLE_LABELS[m.role] || m.role})
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}
                        {assignmentDirty && (
                            <div className={s.actionsRow}>
                                <button className={s.btn} onClick={handleSaveAssignment} disabled={busy}>
                                    <Save size={14} />Save assignment
                                </button>
                            </div>
                        )}
                    </div>

                    {/* ─── Reset password ─── */}
                    <div className={s.section}>
                        <h4 className={s.sectionTitle}>Reset password</h4>
                        <div className={s.field}>
                            <label>New password (min 8 chars)</label>
                            <input
                                type="password"
                                value={pw}
                                onChange={e => setPw(e.target.value)}
                                placeholder="Minimum 8 characters"
                                disabled={busy}
                            />
                        </div>
                        <div className={s.actionsRow}>
                            <button
                                className={`${s.btn} ${s.warning}`}
                                onClick={handleResetPassword}
                                disabled={busy || pw.length < 8}
                            >
                                <KeyRound size={14} />Reset password
                            </button>
                        </div>
                    </div>

                    {/* ─── Danger zone ─── */}
                    {(canDelete || !isSelf) && (
                        <div className={s.danger}>
                            <h4 className={s.dangerTitle}>Danger zone</h4>
                            <div className={s.actionsRow}>
                                {!isSelf && (
                                    <button
                                        className={`${s.btn} ${user.is_active ? s.danger : s.success}`}
                                        onClick={handleToggleActive}
                                        disabled={busy}
                                    >
                                        {user.is_active
                                            ? <><Ban size={14} />Deactivate</>
                                            : <><CheckCircle2 size={14} />Activate</>}
                                    </button>
                                )}
                                {canDelete && (
                                    <button className={`${s.btn} ${s.danger}`} onClick={handleDelete} disabled={busy}>
                                        <Trash2 size={14} />Delete user
                                    </button>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                {/* Footer (close action) */}
                <div className={s.drawerFooter}>
                    <button className={`${s.btn} ${s.secondary}`} onClick={onClose} disabled={busy}>Close</button>
                </div>
            </aside>
        </>
    );
}