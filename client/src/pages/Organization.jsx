import React, { useState, useEffect, useCallback, Suspense, lazy } from 'react';
import { Building2, Users, GitBranch, Tag, CreditCard } from 'lucide-react';
import { useAutoDismiss } from '../hooks/useAutoDismiss';
import { useAuth } from '../AuthContext';
import { createOrg, getCurrentOrg } from '../api';
import Departments from '../components/organization/Departments';
import Teams from '../components/organization/Teams';
import OrgChartView from '../components/organization/OrgChartView';
import TaskLabelsTab from './admin/TaskLabelsTab';
import PageSkeleton from '../components/common/PageSkeleton';
import s from './Admin.module.css';

const MySalarySlips = lazy(() => import('./attendance/MySalarySlips'));

export default function Organization() {
    const { user, updateUser } = useAuth();
    const isAdmin = ['hr_admin', 'super_admin', 'platform_admin'].includes(user?.role);
    const canManageLabels = !isAdmin && ['manager'].includes(user?.role);
    const [org, setOrg] = useState(null);
    const [loading, setLoading] = useState(true);
    const [tab, setTab] = useState('salary-slips');

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

            <div className={s.tabs}>
                <button className={`${s.tab} ${tab === 'salary-slips' ? s.active : ''}`} onClick={() => setTab('salary-slips')}><span><CreditCard size={14} /></span> Salary Slips</button>
                {!isAdmin && <button className={`${s.tab} ${tab === 'departments' ? s.active : ''}`} onClick={() => setTab('departments')}><span><Building2 size={14} /></span> My Department</button>}
                {!isAdmin && <button className={`${s.tab} ${tab === 'teams' ? s.active : ''}`} onClick={() => setTab('teams')}><span><Users size={14} /></span> My Team</button>}
                {!isAdmin && <button className={`${s.tab} ${tab === 'chart' ? s.active : ''}`} onClick={() => setTab('chart')}><span><GitBranch size={14} /></span> Org Chart</button>}
                {canManageLabels && (
                    <button className={`${s.tab} ${tab === 'labels' ? s.active : ''}`} onClick={() => setTab('labels')}><span><Tag size={14} /></span> Task Labels</button>
                )}
            </div>

            {tab === 'salary-slips' && (
                <Suspense fallback={<PageSkeleton />}>
                    <MySalarySlips />
                </Suspense>
            )}
            {tab === 'departments' && !isAdmin && <Departments orgId={org.id} userRole={user.role} />}
            {tab === 'teams' && !isAdmin && <Teams orgId={org.id} userRole={user.role} />}
            {tab === 'chart' && !isAdmin && <OrgChartView />}
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
