import React, { useState, useEffect, useCallback } from 'react';
import { useAutoDismiss } from '../hooks/useAutoDismiss';
import { useAuth } from '../AuthContext';
import { createOrg, getCurrentOrg } from '../api';
import OrgSettings from '../components/organization/OrgSettings';
import Departments from '../components/organization/Departments';
import Teams from '../components/organization/Teams';
import OrgChartView from '../components/organization/OrgChartView';
import s from './Admin.module.css';

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
