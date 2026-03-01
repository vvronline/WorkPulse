import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../AuthContext';
import {
    createOrg, getCurrentOrg, updateOrgSettings, getOrgDepartments,
    createDepartment, updateDepartment, deleteDepartment,
    getOrgTeams, createTeam, updateTeam, deleteTeam,
    getOrgMembers, getOrgChart
} from '../api';
import s from './Admin.module.css';

const ROLE_LABELS = { employee: 'Employee', team_lead: 'Team Lead', manager: 'Manager', hr_admin: 'HR Admin', super_admin: 'Super Admin' };

export default function Organization() {
    const { user, updateUser } = useAuth();
    const [org, setOrg] = useState(null);
    const [loading, setLoading] = useState(true);
    const [tab, setTab] = useState('overview');

    const fetchOrg = useCallback(() => {
        getCurrentOrg().then(r => { setOrg(r.data); setLoading(false); }).catch(() => setLoading(false));
    }, []);

    useEffect(() => { fetchOrg(); }, [fetchOrg]);

    if (loading) return <div className={s.adminPage}><div className={s.statCard}>Loading...</div></div>;

    if (!org) return <CreateOrgView onCreated={() => { fetchOrg(); updateUser({ org_id: 1, role: 'super_admin' }); }} />;

    return (
        <div className={s.adminPage}>
            <h1>{org.name}</h1>

            <div className={s.statsGrid}>
                <div className={s.statCard}><div className={s.value}>{org.memberCount}</div><div className={s.label}>Members</div></div>
                <div className={s.statCard}><div className={s.value}>{org.deptCount}</div><div className={s.label}>Departments</div></div>
                <div className={s.statCard}><div className={s.value}>{org.teamCount}</div><div className={s.label}>Teams</div></div>
                <div className={s.statCard}><div className={s.value}>{org.work_hours_per_day}h</div><div className={s.label}>Work Hours/Day</div></div>
            </div>

            <div className={s.tabs}>
                <button className={`${s.tab} ${tab === 'overview' ? s.active : ''}`} onClick={() => setTab('overview')}>Settings</button>
                <button className={`${s.tab} ${tab === 'departments' ? s.active : ''}`} onClick={() => setTab('departments')}>Departments</button>
                <button className={`${s.tab} ${tab === 'teams' ? s.active : ''}`} onClick={() => setTab('teams')}>Teams</button>
                <button className={`${s.tab} ${tab === 'chart' ? s.active : ''}`} onClick={() => setTab('chart')}>Org Chart</button>
            </div>

            {tab === 'overview' && <OrgSettings org={org} onUpdate={fetchOrg} userRole={user.role} />}
            {tab === 'departments' && <Departments orgId={org.id} userRole={user.role} />}
            {tab === 'teams' && <Teams orgId={org.id} userRole={user.role} />}
            {tab === 'chart' && <OrgChartView />}
        </div>
    );
}

function CreateOrgView({ onCreated }) {
    const [name, setName] = useState('');
    const [error, setError] = useState('');

    const handleCreate = async (e) => {
        e.preventDefault();
        try {
            await createOrg(name);
            onCreated();
        } catch (e) { setError(e.response?.data?.error || 'Failed'); }
    };

    return (
        <div className={s.adminPage}>
            <h1>Create Organization</h1>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
                You're not part of any organization yet. Create one to enable enterprise features.
            </p>
            {error && <div className={s.error}>{error}</div>}
            <form onSubmit={handleCreate} style={{ maxWidth: 400 }}>
                <div className={s.formGroup}>
                    <label>Organization Name</label>
                    <input value={name} onChange={e => setName(e.target.value)} required placeholder="e.g. Acme Corp" />
                </div>
                <button type="submit" className={s.btnPrimary}>Create Organization</button>
            </form>
        </div>
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
    const [msg, setMsg] = useState('');
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
        <form onSubmit={handleSave} style={{ maxWidth: 500 }}>
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
    const [showForm, setShowForm] = useState(false);
    const [name, setName] = useState('');
    const [editId, setEditId] = useState(null);
    const [editName, setEditName] = useState('');
    const [msg, setMsg] = useState('');
    const canManage = ['manager', 'hr_admin', 'super_admin'].includes(userRole);

    const fetchDepts = useCallback(() => {
        getOrgDepartments().then(r => setDepartments(r.data)).catch(() => {});
    }, []);

    useEffect(() => { fetchDepts(); }, [fetchDepts]);

    const handleCreate = async (e) => {
        e.preventDefault();
        try {
            await createDepartment({ name });
            setName('');
            setShowForm(false);
            fetchDepts();
        } catch (e) { setMsg(e.response?.data?.error || 'Failed'); }
    };

    const handleUpdate = async (id) => {
        try {
            await updateDepartment(id, { name: editName });
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
                <div style={{ marginBottom: '1rem' }}>
                    {showForm ? (
                        <form onSubmit={handleCreate} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                            <input value={name} onChange={e => setName(e.target.value)} placeholder="Department name" required style={{ padding: '0.5rem', borderRadius: 8, border: '1px solid var(--glass-border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontFamily: 'inherit' }} />
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
                            <td>{editId === d.id ? <input value={editName} onChange={e => setEditName(e.target.value)} style={{ padding: '0.3rem', borderRadius: 6, border: '1px solid var(--glass-border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontFamily: 'inherit' }} /> : d.name}</td>
                            <td>{d.head_name || '—'}</td>
                            <td>{d.member_count}</td>
                            {canManage && (
                                <td>
                                    <div className={s.actions}>
                                        {editId === d.id ? (
                                            <>
                                                <button className={s.btnSmall} style={{ background: 'var(--accent)', color: '#fff' }} onClick={() => handleUpdate(d.id)}>Save</button>
                                                <button className={s.btnSmall} style={{ background: 'var(--border)', color: 'var(--text-primary)' }} onClick={() => setEditId(null)}>Cancel</button>
                                            </>
                                        ) : (
                                            <>
                                                <button className={s.btnSmall} style={{ background: 'var(--accent)', color: '#fff' }} onClick={() => { setEditId(d.id); setEditName(d.name); }}>Edit</button>
                                                <button className={s.btnSmall} style={{ background: '#ef4444', color: '#fff' }} onClick={() => handleDelete(d.id)}>Delete</button>
                                            </>
                                        )}
                                    </div>
                                </td>
                            )}
                        </tr>
                    ))}
                    {departments.length === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>No departments yet</td></tr>}
                </tbody>
            </table>
        </>
    );
}

function Teams({ orgId, userRole }) {
    const [teams, setTeams] = useState([]);
    const [departments, setDepartments] = useState([]);
    const [showForm, setShowForm] = useState(false);
    const [form, setForm] = useState({ name: '', department_id: '' });
    const [msg, setMsg] = useState('');
    const canManage = ['team_lead', 'manager', 'hr_admin', 'super_admin'].includes(userRole);

    const fetchTeams = useCallback(() => {
        getOrgTeams().then(r => setTeams(r.data)).catch(() => {});
        getOrgDepartments().then(r => setDepartments(r.data)).catch(() => {});
    }, []);

    useEffect(() => { fetchTeams(); }, [fetchTeams]);

    const handleCreate = async (e) => {
        e.preventDefault();
        try {
            await createTeam({ name: form.name, department_id: form.department_id || null });
            setForm({ name: '', department_id: '' });
            setShowForm(false);
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
                <div style={{ marginBottom: '1rem' }}>
                    {showForm ? (
                        <form onSubmit={handleCreate} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                            <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Team name" required style={{ padding: '0.5rem', borderRadius: 8, border: '1px solid var(--glass-border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontFamily: 'inherit' }} />
                            <select value={form.department_id} onChange={e => setForm({ ...form, department_id: e.target.value })} style={{ padding: '0.5rem 1.8rem 0.5rem 0.5rem', borderRadius: 8, border: '1px solid var(--glass-border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontFamily: 'inherit' }}>
                                <option value="">No department</option>
                                {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
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
                <thead><tr><th>Name</th><th>Department</th><th>Lead</th><th>Members</th>{canManage && <th>Actions</th>}</tr></thead>
                <tbody>
                    {teams.map(t => (
                        <tr key={t.id}>
                            <td>{t.name}</td>
                            <td>{t.department_name || '—'}</td>
                            <td>{t.lead_name || '—'}</td>
                            <td>{t.member_count}</td>
                            {canManage && (
                                <td><button className={s.btnSmall} style={{ background: '#ef4444', color: '#fff' }} onClick={() => handleDelete(t.id)}>Delete</button></td>
                            )}
                        </tr>
                    ))}
                    {teams.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>No teams yet</td></tr>}
                </tbody>
            </table>
        </>
    );
}

function OrgChartView() {
    const [chart, setChart] = useState(null);

    useEffect(() => {
        getOrgChart().then(r => setChart(r.data)).catch(() => {});
    }, []);

    if (!chart) return <div>Loading...</div>;

    const unassigned = chart.members.filter(m => !m.department_id && !m.team_id);

    return (
        <div>
            {chart.departments.map(dept => {
                const deptTeams = chart.teams.filter(t => t.department_id === dept.id);
                const deptMembers = chart.members.filter(m => m.department_id === dept.id && !m.team_id);
                return (
                    <div key={dept.id} style={{ background: 'var(--card-bg)', borderRadius: 12, padding: '1.25rem', marginBottom: '1rem', border: '1px solid var(--border)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
                            <span style={{ fontSize: '1.3rem' }}>🏢</span>
                            <div>
                                <div style={{ fontWeight: 700, fontSize: '1.1rem' }}>{dept.name}</div>
                                {dept.head_name && <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Head: {dept.head_name}</div>}
                            </div>
                        </div>
                        {deptTeams.map(team => {
                            const tMembers = chart.members.filter(m => m.team_id === team.id);
                            return (
                                <div key={team.id} style={{ marginLeft: '1.5rem', marginBottom: '0.75rem', padding: '0.75rem', background: 'var(--bg-secondary)', borderRadius: 8 }}>
                                    <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>👥 {team.name} {team.lead_name && <span style={{ fontWeight: 400, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>• Lead: {team.lead_name}</span>}</div>
                                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                                        {tMembers.map(m => (
                                            <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem', background: 'var(--card-bg)', padding: '0.3rem 0.6rem', borderRadius: 6 }}>
                                                {m.avatar ? <img src={m.avatar} className={s.miniAvatar} style={{ width: 20, height: 20 }} alt="" /> : <span className={s.initials} style={{ width: 20, height: 20, fontSize: '0.5rem' }}>{m.full_name?.charAt(0)}</span>}
                                                {m.full_name}
                                                <span className={s.badgeRole} data-role={m.role} style={{ fontSize: '0.65rem', padding: '0.1rem 0.4rem' }}>{ROLE_LABELS[m.role]}</span>
                                            </div>
                                        ))}
                                        {tMembers.length === 0 && <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>No members</span>}
                                    </div>
                                </div>
                            );
                        })}
                        {deptMembers.length > 0 && (
                            <div style={{ marginLeft: '1.5rem' }}>
                                <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.3rem' }}>Unassigned to team:</div>
                                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                                    {deptMembers.map(m => (
                                        <div key={m.id} style={{ fontSize: '0.85rem', background: 'var(--bg-secondary)', padding: '0.3rem 0.6rem', borderRadius: 6 }}>{m.full_name}</div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                );
            })}
            {unassigned.length > 0 && (
                <div style={{ background: 'var(--card-bg)', borderRadius: 12, padding: '1.25rem', border: '1px solid var(--border)' }}>
                    <div style={{ fontWeight: 700, marginBottom: '0.75rem' }}>Unassigned Members</div>
                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                        {unassigned.map(m => (
                            <div key={m.id} style={{ fontSize: '0.85rem', background: 'var(--bg-secondary)', padding: '0.3rem 0.6rem', borderRadius: 6 }}>
                                {m.full_name} <span className={s.badgeRole} data-role={m.role} style={{ fontSize: '0.65rem', padding: '0.1rem 0.4rem' }}>{ROLE_LABELS[m.role]}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
