import React, { useState, useEffect, useCallback } from 'react';
import { useAutoDismiss } from '../../hooks/useAutoDismiss';
import {
    getAdminOrganizations, createAdminOrganization, updateAdminOrganization, deleteAdminOrganization
} from '../../api';
import OrgModal from './OrgModal';
import s from '../Admin.module.css';
import sf from './AdminForms.module.css';
import su from './AdminUtils.module.css';

export default function OrganizationsManagement({ onOrgChange }) {
    const [orgs, setOrgs] = useState([]);
    const [creating, setCreating] = useState(false);
    const [editing, setEditing] = useState(null);
    const [deleting, setDeleting] = useState(null);
    const [msg, setMsg] = useAutoDismiss('');

    const fetchOrgs = useCallback(() => {
        getAdminOrganizations().then(r => setOrgs(r.data.data || r.data)).catch(e => console.error(e));
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
            <h2 className={su.sectionHeading}>🏢 All Organizations</h2>
            <p className={su.sectionDesc}>Manage all organizations in the system</p>
            {msg && <div className={s.success}>{msg}</div>}
            <div className={s.toolbar}>
                <button className={s.btnPrimary} onClick={() => setCreating(true)}>➕ Create Organization</button>
            </div>

            <table className={s.table}>
                <thead>
                    <tr>
                        <th>Name</th><th>Slug</th><th>Timezone</th><th>Work Hours</th><th>Work Days</th><th>Members</th><th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    {orgs.map(o => (
                        <tr key={o.id}>
                            <td className={su['font-bold']}>{o.name}</td>
                            <td><code className={su['text-muted-xs']}>{o.slug}</code></td>
                            <td className={su['text-sm']}>{o.timezone || 'UTC'}</td>
                            <td>{o.work_hours_per_day || 8}h</td>
                            <td className={su['text-sm']}>{o.work_days || '1,2,3,4,5'}</td>
                            <td>{o.member_count}</td>
                            <td>
                                <div className={s.actions}>
                                    <button className={`${s.btnSmall} ${s.btnAccent}`} onClick={() => setEditing(o)}>✏️ Edit</button>
                                    <button className={`${s.btnSmall} ${s.btnDanger}`} onClick={() => setDeleting(o)}>🗑️ Delete</button>
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
                <div className={sf.modalOverlay} onClick={() => setDeleting(null)}>
                    <div className={sf.modal} onClick={e => e.stopPropagation()}>
                        <h2>Delete Organization</h2>
                        <p>Are you sure you want to delete <strong>{deleting.name}</strong>?</p>
                        <p className={su['org-delete-info']}>
                            This will remove all departments, teams, and clear org assignments for inactive users.
                            Organizations with active users cannot be deleted.
                        </p>
                        <div className={sf.formActions}>
                            <button className={sf.btnCancel} onClick={() => setDeleting(null)}>Cancel</button>
                            <button className={`${s.btnPrimary} ${s.btnDanger}`} onClick={() => handleDelete(deleting.id)}>Delete Organization</button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
