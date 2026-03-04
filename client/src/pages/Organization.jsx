import React, { useState, useEffect, useCallback } from 'react';
import { useAutoDismiss } from '../hooks/useAutoDismiss';
import { useAuth } from '../AuthContext';
import {
    createOrg, getCurrentOrg, updateOrgSettings, getOrgDepartments,
    createDepartment, updateDepartment, deleteDepartment,
    getOrgTeams, createTeam, updateTeam, deleteTeam,
    getOrgMembers, getOrgChart, getTeamSprintConfig, updateTeamSprintConfig
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

    if (!org) {
        if (user?.role === 'super_admin') {
            return <CreateOrgView onCreated={(orgId) => { fetchOrg(); updateUser({ org_id: orgId, role: 'super_admin' }); }} />;
        }
        return (
            <div className={s.adminPage}>
                <h1>Organization</h1>
                <p style={{ color: 'var(--text-secondary)', marginTop: '1rem' }}>
                    You are not assigned to any organization yet. Please contact your administrator.
                </p>
            </div>
        );
    }

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
    const [error, setError] = useAutoDismiss('');

    const handleCreate = async (e) => {
        e.preventDefault();
        try {
            const res = await createOrg(name);
            onCreated(res.data.id);
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
                <div style={{ marginBottom: '1rem' }}>
                    {showForm ? (
                        <form onSubmit={handleCreate} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                            <input value={name} onChange={e => setName(e.target.value)} placeholder="Department name" required style={{ padding: '0.5rem', borderRadius: 8, border: '1px solid var(--glass-border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontFamily: 'inherit' }} />
                            <select value={headId} onChange={e => setHeadId(e.target.value)} style={{ padding: '0.5rem', borderRadius: 8, border: '1px solid var(--glass-border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontFamily: 'inherit' }}>
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
                            <td>{editId === d.id ? <input value={editName} onChange={e => setEditName(e.target.value)} style={{ padding: '0.3rem', borderRadius: 6, border: '1px solid var(--glass-border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontFamily: 'inherit' }} /> : d.name}</td>
                            <td>{editId === d.id ? (
                                <select value={editHeadId} onChange={e => setEditHeadId(e.target.value)} style={{ padding: '0.3rem', borderRadius: 6, border: '1px solid var(--glass-border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontFamily: 'inherit' }}>
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
                                                <button className={s.btnSmall} style={{ background: 'var(--accent)', color: '#fff' }} onClick={() => handleUpdate(d.id)}>Save</button>
                                                <button className={s.btnSmall} style={{ background: 'var(--border)', color: 'var(--text-primary)' }} onClick={() => setEditId(null)}>Cancel</button>
                                            </>
                                        ) : (
                                            <>
                                                <button className={s.btnSmall} style={{ background: 'var(--accent)', color: '#fff' }} onClick={() => { setEditId(d.id); setEditName(d.name); setEditHeadId(d.head_id || ''); }}>Edit</button>
                                                <button className={s.btnSmall} style={{ background: 'var(--danger)', color: '#fff' }} onClick={() => handleDelete(d.id)}>Delete</button>
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
            // Update sprint config if changed
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

    const inputStyle = { padding: '0.5rem', borderRadius: 8, border: '1px solid var(--glass-border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontFamily: 'inherit' };
    const editInputStyle = { padding: '0.3rem', borderRadius: 6, border: '1px solid var(--glass-border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontFamily: 'inherit' };

    return (
        <>
            {msg && <div className={s.success}>{msg}</div>}
            {canManage && (
                <div style={{ marginBottom: '1rem' }}>
                    {showForm ? (
                        <form onSubmit={handleCreate} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                            <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Team name" required style={inputStyle} />
                            <select value={form.department_id} onChange={e => setForm({ ...form, department_id: e.target.value })} style={inputStyle}>
                                <option value="">No department</option>
                                {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                            </select>
                            <select value={form.lead_id} onChange={e => setForm({ ...form, lead_id: e.target.value })} style={inputStyle}>
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
                                <td>{editId === t.id ? <input value={editForm.name} onChange={e => setEditForm({ ...editForm, name: e.target.value })} style={editInputStyle} /> : t.name}</td>
                                <td>{editId === t.id ? (
                                    <select value={editForm.department_id} onChange={e => setEditForm({ ...editForm, department_id: e.target.value })} style={editInputStyle}>
                                        <option value="">No department</option>
                                        {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                                    </select>
                                ) : (t.department_name || '—')}</td>
                                <td>{editId === t.id ? (
                                    <select value={editForm.lead_id} onChange={e => setEditForm({ ...editForm, lead_id: e.target.value })} style={editInputStyle}>
                                        <option value="">No Lead</option>
                                        {members.map(m => <option key={m.id} value={m.id}>{m.full_name || m.username}</option>)}
                                    </select>
                                ) : (t.lead_name || '—')}</td>
                                <td>{t.member_count}</td>
                                <td style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                                    {t.sprint_duration_weeks ? `${t.sprint_duration_weeks} week${t.sprint_duration_weeks > 1 ? 's' : ''}` : 'Not configured'}
                                    {t.sprint_start_date && ` (from ${t.sprint_start_date})`}
                                </td>
                            {canManage && (
                                <td>
                                    <div className={s.actions}>
                                        {editId === t.id ? (
                                            <>
                                                <button className={s.btnSmall} style={{ background: 'var(--accent)', color: '#fff' }} onClick={() => handleUpdate(t.id)}>Save</button>
                                                <button className={s.btnSmall} style={{ background: 'var(--border)', color: 'var(--text-primary)' }} onClick={() => setEditId(null)}>Cancel</button>
                                            </>
                                        ) : (
                                            <>
                                                <button className={s.btnSmall} style={{ background: 'var(--accent)', color: '#fff' }} onClick={async () => {
                                                    setEditId(t.id);
                                                    setEditForm({ name: t.name, department_id: t.department_id || '', lead_id: t.lead_id || '', sprint_duration_weeks: 2, sprint_start_date: '' });
                                                    // Load sprint config
                                                    try {
                                                        const sprintRes = await getTeamSprintConfig(t.id);
                                                        setEditForm(prev => ({
                                                            ...prev,
                                                            sprint_duration_weeks: sprintRes.data.sprintDurationWeeks || 2,
                                                            sprint_start_date: sprintRes.data.sprintStartDate || ''
                                                        }));
                                                    } catch (err) {
                                                        console.error('Failed to load sprint config:', err);
                                                    }
                                                }}>Edit</button>
                                                <button className={s.btnSmall} style={{ background: 'var(--danger)', color: '#fff' }} onClick={() => handleDelete(t.id)}>Delete</button>
                                            </>
                                        )}
                                    </div>
                                </td>
                            )}
                        </tr>
                        {editId === t.id && (
                            <tr style={{ background: 'var(--bg-secondary)' }}>
                                <td colSpan={canManage ? 6 : 5} style={{ padding: '1rem' }}>
                                    <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
                                        <div style={{ flex: '1 1 200px' }}>
                                            <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.85rem', fontWeight: 600 }}>🏃 Sprint Duration (weeks)</label>
                                            <input
                                                type="number"
                                                min="1"
                                                max="8"
                                                value={editForm.sprint_duration_weeks || 2}
                                                onChange={e => setEditForm({ ...editForm, sprint_duration_weeks: parseInt(e.target.value) || 2 })}
                                                style={editInputStyle}
                                                placeholder="2"
                                            />
                                            <small style={{ display: 'block', marginTop: '0.25rem', color: 'var(--text-secondary)', fontSize: '0.75rem' }}>Length of each sprint (1-8 weeks)</small>
                                        </div>
                                        <div style={{ flex: '1 1 200px' }}>
                                            <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.85rem', fontWeight: 600 }}>📅 Sprint Start Date</label>
                                            <input
                                                type="date"
                                                value={editForm.sprint_start_date || ''}
                                                onChange={e => setEditForm({ ...editForm, sprint_start_date: e.target.value })}
                                                style={editInputStyle}
                                            />
                                            <small style={{ display: 'block', marginTop: '0.25rem', color: 'var(--text-secondary)', fontSize: '0.75rem' }}>First sprint's start date (sprints auto-calculated from this)</small>
                                        </div>
                                    </div>
                                </td>
                            </tr>
                        )}
                    </React.Fragment>
                    ))}
                    {teams.length === 0 && <tr><td colSpan={canManage ? 6 : 5} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>No teams yet</td></tr>}
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
