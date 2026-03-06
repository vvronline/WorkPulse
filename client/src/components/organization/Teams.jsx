import React, { useState, useEffect, useCallback } from 'react';
import { useAutoDismiss } from '../../hooks/useAutoDismiss';
import {
    getOrgTeams, getOrgDepartments, getOrgMembers, createTeam, updateTeam, deleteTeam,
    getTeamSprintConfig, updateTeamSprintConfig
} from '../../api';
import s from '../../pages/Admin.module.css';
import tc from './TeamsConfig.module.css';
import sf from '../../pages/admin/AdminForms.module.css';
import su from '../../pages/admin/AdminUtils.module.css';

export default function Teams({ orgId, userRole }) {
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
                <div className={su['form-toolbar']}>
                    {showForm ? (
                        <form onSubmit={handleCreate} className={su['inline-form']}>
                            <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Team name" required className={su['form-inline-input']} />
                            <select value={form.department_id} onChange={e => setForm({ ...form, department_id: e.target.value })} className={su['form-inline-input']}>
                                <option value="">No department</option>
                                {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                            </select>
                            <select value={form.lead_id} onChange={e => setForm({ ...form, lead_id: e.target.value })} className={su['form-inline-input']}>
                                <option value="">No Lead</option>
                                {members.map(m => <option key={m.id} value={m.id}>{m.full_name || m.username}</option>)}
                            </select>
                            <button type="submit" className={s.btnPrimary}>Add</button>
                            <button type="button" className={sf.btnCancel} onClick={() => setShowForm(false)}>Cancel</button>
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
                                <td>{editId === t.id ? <input value={editForm.name} onChange={e => setEditForm({ ...editForm, name: e.target.value })} className={su['edit-inline-input']} /> : t.name}</td>
                                <td>{editId === t.id ? (
                                    <select value={editForm.department_id} onChange={e => setEditForm({ ...editForm, department_id: e.target.value })} className={su['edit-inline-input']}>
                                        <option value="">No department</option>
                                        {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                                    </select>
                                ) : (t.department_name || '—')}</td>
                                <td>{editId === t.id ? (
                                    <select value={editForm.lead_id} onChange={e => setEditForm({ ...editForm, lead_id: e.target.value })} className={su['edit-inline-input']}>
                                        <option value="">No Lead</option>
                                        {members.map(m => <option key={m.id} value={m.id}>{m.full_name || m.username}</option>)}
                                    </select>
                                ) : (t.lead_name || '—')}</td>
                                <td>{t.member_count}</td>
                                <td className={su['text-muted-sm']}>
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
                                <tr className={tc['sprint-edit-row']}>
                                    <td colSpan={canManage ? 7 : 6} className={tc['sprint-edit-cell']}>
                                        <div className={tc['sprint-config-form']}>
                                            <div className={tc['sprint-field']}>
                                                <label className={tc['field-label']}>🏃 Sprint Duration (weeks)</label>
                                                <input
                                                    type="number" min="1" max="8"
                                                    value={editForm.sprint_duration_weeks || 2}
                                                    onChange={e => setEditForm({ ...editForm, sprint_duration_weeks: parseInt(e.target.value) || 2 })}
                                                    className={su['edit-inline-input']}
                                                    placeholder="2"
                                                />
                                                <small className={tc['field-hint']}>Length of each sprint (1-8 weeks)</small>
                                            </div>
                                            <div className={tc['sprint-field']}>
                                                <label className={tc['field-label']}>📅 Sprint Start Date</label>
                                                <input
                                                    type="date"
                                                    value={editForm.sprint_start_date || ''}
                                                    onChange={e => setEditForm({ ...editForm, sprint_start_date: e.target.value })}
                                                    className={su['edit-inline-input']}
                                                />
                                                <small className={tc['field-hint']}>First sprint's start date (sprints auto-calculated from this)</small>
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
