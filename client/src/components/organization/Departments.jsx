import React, { useState, useEffect, useCallback } from 'react';
import { useAutoDismiss } from '../../hooks/useAutoDismiss';
import {
    getOrgDepartments, getOrgMembers, createDepartment, updateDepartment, deleteDepartment
} from '../../api';
import s from '../../pages/Admin.module.css';
import su from '../../pages/admin/AdminUtils.module.css';

export default function Departments({ orgId, userRole }) {
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
                <div className={su['form-toolbar']}>
                    {showForm ? (
                        <form onSubmit={handleCreate} className={su['inline-form']}>
                            <input value={name} onChange={e => setName(e.target.value)} placeholder="Department name" required className={su['form-inline-input']} />
                            <select value={headId} onChange={e => setHeadId(e.target.value)} className={su['form-inline-input']}>
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
                            <td>{editId === d.id ? <input value={editName} onChange={e => setEditName(e.target.value)} className={su['edit-inline-input']} /> : d.name}</td>
                            <td>{editId === d.id ? (
                                <select value={editHeadId} onChange={e => setEditHeadId(e.target.value)} className={su['edit-inline-input']}>
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
