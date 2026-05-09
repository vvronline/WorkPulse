import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
    MoreHorizontal, Filter, Ban, CheckCircle2, X as XIcon,
} from 'lucide-react';
import {
    getAdminUsers, toggleUserActive, updateUserAssignment,
    getOrgDepartments, getOrgTeams, getAdminOrganizations, getRoleChangeRequests,
} from '../../api';
import { useAuth } from '../../AuthContext';
import { ROLES, ROLE_LABELS } from './constants';
import UserDrawer from './UserDrawer';
import TypedConfirm from './TypedConfirm';
import s from './UserManagement.module.css';

/**
 * Saved views — pre-built filter combos shown as chips above the list.
 * Each predicate runs after the server-side filter (search/role/active).
 */
const SAVED_VIEWS = [
    { key: 'all',         label: 'All',          test: () => true },
    { key: 'inactive',    label: 'Inactive',     test: u => u.is_active === false },
    { key: 'no-team',     label: 'No team',      test: u => !u.team_id },
    { key: 'no-manager',  label: 'No manager',   test: u => !u.manager_id && u.role !== 'platform_admin' },
    { key: 'pending',     label: 'Role pending', test: (u, ctx) => !!ctx.pendingByUser[u.id] },
    { key: 'admins',      label: 'Admins',       test: u => ['hr_admin','super_admin','platform_admin'].includes(u.role) },
];

export default function UserManagement({ userRole }) {
    const { user: currentUser } = useAuth();

    // ─── Server-side filter state ────────────────────────────────────────
    const [search, setSearch] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    const searchTimerRef = useRef(null);
    const [filterRole, setFilterRole] = useState('');
    const [filterActive, setFilterActive] = useState('');

    useEffect(() => {
        if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
        searchTimerRef.current = setTimeout(() => setDebouncedSearch(search), 300);
        return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
    }, [search]);

    // ─── Data ────────────────────────────────────────────────────────────
    const [users, setUsers] = useState([]);
    const [departments, setDepartments] = useState([]);
    const [teams, setTeams] = useState([]);
    const [organizations, setOrganizations] = useState([]);
    const [pendingByUser, setPendingByUser] = useState({});
    const [loading, setLoading] = useState(false);

    const fetchUsers = useCallback(() => {
        const params = {};
        if (debouncedSearch) params.search = debouncedSearch;
        if (filterRole) params.role = filterRole;
        if (filterActive) params.is_active = filterActive;
        setLoading(true);
        getAdminUsers(params)
            .then(r => setUsers(r.data?.data ?? r.data ?? []))
            .catch(e => console.error('fetchUsers', e))
            .finally(() => setLoading(false));
    }, [debouncedSearch, filterRole, filterActive]);

    const fetchPending = useCallback(() => {
        getRoleChangeRequests({ status: 'pending' }).then(r => {
            const map = {};
            (r.data || []).forEach(rr => { map[rr.target_user_id] = rr; });
            setPendingByUser(map);
        }).catch(() => {});
    }, []);

    useEffect(() => { fetchUsers(); fetchPending(); }, [fetchUsers, fetchPending]);

    useEffect(() => {
        if (userRole === 'platform_admin') {
            getAdminOrganizations()
                .then(r => setOrganizations(r.data?.data || r.data || []))
                .catch(() => setOrganizations([]));
        }
    }, [userRole]);

    // Re-fetch dept/team list scoped to whichever orgs the visible users span
    useEffect(() => {
        if (users.length === 0) { setDepartments([]); setTeams([]); return; }
        const orgIds = [...new Set(users.map(u => u.org_id).filter(Boolean))];
        if (orgIds.length === 0) { setDepartments([]); setTeams([]); return; }

        const deptCalls = orgIds.map(oid =>
            getOrgDepartments(userRole === 'platform_admin' ? { org_id: oid } : {})
                .then(r => r.data || []).catch(() => []));
        const teamCalls = orgIds.map(oid =>
            getOrgTeams(userRole === 'platform_admin' ? { org_id: oid } : {})
                .then(r => r.data || []).catch(() => []));

        Promise.all(deptCalls).then(arr => {
            const flat = arr.flat();
            const uniq = [...new Map(flat.map(d => [d.id, d])).values()];
            setDepartments(uniq);
        });
        Promise.all(teamCalls).then(arr => {
            const flat = arr.flat();
            const uniq = [...new Map(flat.map(t => [t.id, t])).values()];
            setTeams(uniq);
        });
    }, [users, userRole]);

    // ─── Saved views ─────────────────────────────────────────────────────
    const [view, setView] = useState('all');
    const visibleUsers = useMemo(() => {
        const v = SAVED_VIEWS.find(x => x.key === view);
        if (!v) return users;
        return users.filter(u => v.test(u, { pendingByUser }));
    }, [users, view, pendingByUser]);

    const viewCounts = useMemo(() => {
        const out = {};
        for (const v of SAVED_VIEWS) {
            out[v.key] = users.filter(u => v.test(u, { pendingByUser })).length;
        }
        return out;
    }, [users, pendingByUser]);

    // ─── Selection / bulk ────────────────────────────────────────────────
    const [selected, setSelected] = useState(() => new Set());
    const allVisibleSelected = visibleUsers.length > 0 && visibleUsers.every(u => selected.has(u.id));

    const toggleOne = (id) => {
        setSelected(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };
    const clearSelection = () => setSelected(new Set());
    const toggleAll = () => {
        if (allVisibleSelected) clearSelection();
        else setSelected(new Set(visibleUsers.map(u => u.id)));
    };

    const selectedUsers = useMemo(() => users.filter(u => selected.has(u.id)), [users, selected]);
    const selectableCount = selectedUsers.filter(u => u.id !== currentUser?.id && u.role !== 'platform_admin').length;

    // ─── Toast / message ────────────────────────────────────────────────
    const [toast, setToast] = useState('');
    useEffect(() => {
        if (!toast) return;
        const t = setTimeout(() => setToast(''), 3500);
        return () => clearTimeout(t);
    }, [toast]);

    // ─── Drawer ──────────────────────────────────────────────────────────
    const [drawerUser, setDrawerUser] = useState(null);
    const openDrawer = (u) => setDrawerUser(u);
    const closeDrawer = () => setDrawerUser(null);

    const onUserSaved = (msg) => {
        setToast(msg);
        fetchUsers();
        fetchPending();
    };

    // ─── Generic confirm dialog ──────────────────────────────────────────
    const [confirmOpts, setConfirmOpts] = useState(null);

    // ─── Bulk actions ────────────────────────────────────────────────────
    const runBulk = async (label, fn) => {
        const targets = selectedUsers.filter(u => u.id !== currentUser?.id && u.role !== 'platform_admin');
        if (targets.length === 0) return;
        let ok = 0, fail = 0;
        for (const u of targets) {
            try { await fn(u); ok++; } catch { fail++; }
        }
        setToast(`${label}: ${ok} succeeded${fail ? `, ${fail} failed` : ''}`);
        clearSelection();
        fetchUsers();
        fetchPending();
    };

    const bulkActivate = () => {
        setConfirmOpts({
            title: 'Activate users',
            message: `Activate ${selectableCount} selected user${selectableCount === 1 ? '' : 's'}?`,
            confirmLabel: 'Activate',
            onConfirm: () => runBulk('Activate', u => u.is_active ? Promise.resolve() : toggleUserActive(u.id)),
        });
    };
    const bulkDeactivate = () => {
        setConfirmOpts({
            title: 'Deactivate users',
            message: `Deactivate ${selectableCount} selected user${selectableCount === 1 ? '' : 's'}?`,
            hint: 'They will be signed out immediately and unable to log in until reactivated.',
            confirmLabel: 'Deactivate',
            danger: true,
            onConfirm: () => runBulk('Deactivate', u => !u.is_active ? Promise.resolve() : toggleUserActive(u.id)),
        });
    };
    const bulkClearTeam = () => {
        setConfirmOpts({
            title: 'Remove from team',
            message: `Clear team assignment for ${selectableCount} selected user${selectableCount === 1 ? '' : 's'}?`,
            hint: 'Department and manager assignments are preserved.',
            confirmLabel: 'Clear team',
            onConfirm: () => runBulk('Clear team', u => updateUserAssignment(u.id, {
                department_id: u.department_id || null,
                team_id: null,
                manager_id: u.manager_id || null,
            })),
        });
    };

    // ─── Render ──────────────────────────────────────────────────────────
    return (
        <div className={s.wrap}>
            {toast && (
                <div style={{
                    background: 'color-mix(in srgb, var(--success) 14%, transparent)',
                    color: 'var(--success)',
                    border: '1px solid color-mix(in srgb, var(--success) 30%, transparent)',
                    borderRadius: 8, padding: '0.55rem 0.85rem', fontSize: 13,
                }}>{toast}</div>
            )}

            {/* Toolbar: search + role/status filters */}
            <div className={s.toolbar}>
                <input
                    className={s.search}
                    placeholder="Search users by name, username, or email..."
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                />
                <select value={filterRole} onChange={e => setFilterRole(e.target.value)} aria-label="Role filter">
                    <option value="">All roles</option>
                    {ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                    <option value="platform_admin">{ROLE_LABELS.platform_admin}</option>
                </select>
                <select value={filterActive} onChange={e => setFilterActive(e.target.value)} aria-label="Status filter">
                    <option value="">All status</option>
                    <option value="true">Active</option>
                    <option value="false">Inactive</option>
                </select>
                {(filterRole || filterActive || search) && (
                    <button
                        className={s.viewChip}
                        onClick={() => { setSearch(''); setFilterRole(''); setFilterActive(''); }}
                        title="Clear filters"
                    >
                        <XIcon size={12} />Clear
                    </button>
                )}
            </div>

            {/* Saved views */}
            <div className={s.viewsRow}>
                <span className={s.viewsLabel}><Filter size={11} style={{ verticalAlign: 'middle', marginRight: 3 }} />Views</span>
                {SAVED_VIEWS.map(v => (
                    <button
                        key={v.key}
                        className={`${s.viewChip} ${view === v.key ? s.active : ''}`}
                        onClick={() => setView(v.key)}
                    >
                        {v.label}
                        {viewCounts[v.key] > 0 && <span className={s.count}>{viewCounts[v.key]}</span>}
                    </button>
                ))}
            </div>

            {/* Bulk action bar */}
            {selected.size > 0 && (
                <div className={s.bulkBar}>
                    <span className={s.bulkLabel}>
                        {selected.size} selected{selectableCount !== selected.size && ` (${selectableCount} actionable)`}
                    </span>
                    <button className={`${s.bulkAction} ${s.success}`} onClick={bulkActivate} disabled={selectableCount === 0}>
                        <CheckCircle2 size={13} />Activate
                    </button>
                    <button className={`${s.bulkAction} ${s.danger}`} onClick={bulkDeactivate} disabled={selectableCount === 0}>
                        <Ban size={13} />Deactivate
                    </button>
                    <button className={`${s.bulkAction} ${s.secondary}`} onClick={bulkClearTeam} disabled={selectableCount === 0}>
                        Clear team
                    </button>
                    <button className={`${s.bulkAction} ${s.secondary}`} onClick={clearSelection}>
                        <XIcon size={13} />Clear
                    </button>
                </div>
            )}

            {/* List */}
            <div className={s.list} role="table" aria-label="Users">
                <div className={s.listHeader} role="row">
                    <div className={s.checkCell}>
                        <input
                            type="checkbox"
                            className={s.checkbox}
                            checked={allVisibleSelected}
                            onChange={toggleAll}
                            aria-label="Select all visible"
                        />
                    </div>
                    <div>User</div>
                    <div>Role</div>
                    <div>Department · Team</div>
                    <div>Manager</div>
                    <div>Status</div>
                    <div></div>
                </div>

                {visibleUsers.length === 0 ? (
                    <div className={s.empty}>
                        {loading ? 'Loading…' : 'No users match the current filters.'}
                    </div>
                ) : visibleUsers.map(u => {
                    const isSelected = selected.has(u.id);
                    const pending = pendingByUser[u.id];
                    return (
                        <div
                            key={u.id}
                            className={`${s.row} ${isSelected ? s.selected : ''}`}
                            role="row"
                            onClick={() => openDrawer(u)}
                        >
                            <div
                                className={s.checkCell}
                                onClick={e => { e.stopPropagation(); toggleOne(u.id); }}
                            >
                                <input
                                    type="checkbox"
                                    className={s.checkbox}
                                    checked={isSelected}
                                    onChange={() => {}}
                                    aria-label={`Select ${u.full_name}`}
                                    onClick={e => e.stopPropagation()}
                                />
                            </div>
                            <div className={s.userCell}>
                                {u.avatar
                                    ? <img src={u.avatar} alt="" className={s.avatar} />
                                    : <div className={s.initials}>{(u.full_name || '?').charAt(0).toUpperCase()}</div>}
                                <div className={s.userMeta}>
                                    <div className={s.userName}>
                                        {u.full_name}
                                        {pending && <span className={s.pendingPill}>role pending</span>}
                                    </div>
                                    <div className={s.userSub}>@{u.username} · {u.email || 'no email'}</div>
                                </div>
                            </div>
                            <div>
                                <span className={s.roleBadge} data-role={u.role}>
                                    {ROLE_LABELS[u.role] || u.role}
                                </span>
                            </div>
                            <div className={s.cellText}>
                                {u.department_name || <em className={s.cellMuted}>no dept</em>}
                                {u.team_name && <> · <span style={{ opacity: 0.85 }}>{u.team_name}</span></>}
                            </div>
                            <div className={s.cellText}>
                                {u.manager_name || <em className={s.cellMuted}>—</em>}
                            </div>
                            <div>
                                <span className={`${s.statusDot} ${u.is_active ? '' : s.inactive}`}>
                                    {u.is_active ? 'Active' : 'Inactive'}
                                </span>
                            </div>
                            <div onClick={e => e.stopPropagation()}>
                                <button
                                    className={s.kebab}
                                    onClick={() => openDrawer(u)}
                                    aria-label={`Edit ${u.full_name}`}
                                    title="Edit user"
                                >
                                    <MoreHorizontal size={16} />
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Drawer */}
            {drawerUser && (
                <UserDrawer
                    user={drawerUser}
                    currentUser={currentUser}
                    userRole={userRole}
                    organizations={organizations}
                    departments={departments}
                    teams={teams}
                    allUsers={users}
                    pendingRequest={pendingByUser[drawerUser.id]}
                    onClose={closeDrawer}
                    onSaved={(msg) => { onUserSaved(msg); /* keep drawer open so user can keep editing */ }}
                    onConfirm={(opts) => setConfirmOpts(opts)}
                />
            )}

            {/* Generic typed-confirm modal */}
            {confirmOpts && (
                <TypedConfirm
                    {...confirmOpts}
                    onCancel={() => setConfirmOpts(null)}
                />
            )}
        </div>
    );
}