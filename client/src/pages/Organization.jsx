import React, { useState, useEffect, useCallback } from 'react';
import { Navigate } from 'react-router-dom';
import { Settings, Building2, Users, GitBranch, Tag } from 'lucide-react';
import { useAutoDismiss } from '../hooks/useAutoDismiss';
import { useAuth } from '../AuthContext';
import { createOrg, getCurrentOrg } from '../api';
import OrgSettings from '../components/organization/OrgSettings';
import Departments from '../components/organization/Departments';
import Teams from '../components/organization/Teams';
import OrgChartView from '../components/organization/OrgChartView';
import TaskLabelsTab from './admin/TaskLabelsTab';
import s from './Admin.module.css';

export default function Organization() {
    const { user, updateUser } = useAuth();
    const isAdmin = ['hr_admin', 'super_admin', 'platform_admin'].includes(user?.role);
    const canManageLabels = ['manager', 'hr_admin', 'super_admin', 'platform_admin'].includes(user?.role);
    const [org, setOrg] = useState(null);
    const [loading, setLoading] = useState(true);
    const [tab, setTab] = useState(isAdmin ? 'overview' : 'departments');

    const fetchOrg = useCallback(() => {
        getCurrentOrg().then(r => { setOrg(r.data); setLoading(false); }).catch(() => setLoading(false));
    }, []);

    useEffect(() => { fetchOrg(); }, [fetchOrg]);

    if (loading) return <div className={s.adminPage}><div className={s.statCard}>Loading...</div></div>;

    if (!org) {
        if (user?.role === 'super_admin') {
            return <CreateOrgView onCreated={(orgId) => { fetchOrg(); updateUser({ org_id: orgId, role: 'super_admin' }); }} />;
        }
        if (user?.role === 'platform_admin') {
            return <Navigate to="/admin?tab=tenants" replace />;
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

            {isAdmin && (
                <div className={s.statsGrid}>
                    <div className={s.statCard}><div className={s.value}>{org.memberCount}</div><div className={s.label}>Members</div></div>
                    <div className={s.statCard}><div className={s.value}>{org.deptCount}</div><div className={s.label}>Departments</div></div>
                    <div className={s.statCard}><div className={s.value}>{org.teamCount}</div><div className={s.label}>Teams</div></div>
                    {user?.role === 'super_admin' && <div className={s.statCard}><div className={s.value}>{org.work_hours_per_day}h</div><div className={s.label}>Work Hours/Day</div></div>}
                </div>
            )}

            <div className={s.tabs}>
                {isAdmin && <button className={`${s.tab} ${tab === 'overview' ? s.active : ''}`} onClick={() => setTab('overview')}><span><Settings size={14} /></span> Settings</button>}
                <button className={`${s.tab} ${tab === 'departments' ? s.active : ''}`} onClick={() => setTab('departments')}><span><Building2 size={14} /></span> {isAdmin ? 'Departments' : 'My Department'}</button>
                <button className={`${s.tab} ${tab === 'teams' ? s.active : ''}`} onClick={() => setTab('teams')}><span><Users size={14} /></span> {isAdmin ? 'Teams' : 'My Team'}</button>
                <button className={`${s.tab} ${tab === 'chart' ? s.active : ''}`} onClick={() => setTab('chart')}><span><GitBranch size={14} /></span> Org Chart</button>
                {canManageLabels && (
                    <button className={`${s.tab} ${tab === 'labels' ? s.active : ''}`} onClick={() => setTab('labels')}><span><Tag size={14} /></span> Task Labels</button>
                )}
            </div>

            {tab === 'overview' && <OrgSettings org={org} onUpdate={fetchOrg} userRole={user.role} />}
            {tab === 'departments' && <Departments orgId={org.id} userRole={user.role} />}
            {tab === 'teams' && <Teams orgId={org.id} userRole={user.role} />}
            {tab === 'chart' && <OrgChartView />}
            {tab === 'labels' && canManageLabels && <TaskLabelsTab />}
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
