import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../AuthContext';
import { getCurrentOrg } from '../../api';
import OrgSettings from '../../components/organization/OrgSettings';
import Departments from '../../components/organization/Departments';
import Teams from '../../components/organization/Teams';
import OrgChartView from '../../components/organization/OrgChartView';
import s from '../Admin.module.css';
import su from './AdminUtils.module.css';

export default function MyOrganization({ userRole, refreshKey }) {
    const { updateUser } = useAuth();
    const [org, setOrg] = useState(null);
    const [loading, setLoading] = useState(true);
    const [tab, setTab] = useState('departments');

    const fetchOrg = useCallback(() => {
        getCurrentOrg().then(r => { setOrg(r.data); setLoading(false); }).catch(() => setLoading(false));
    }, []);

    useEffect(() => { fetchOrg(); }, [fetchOrg, refreshKey]);

    if (loading) return <div>Loading...</div>;

    if (!org) {
        return (
            <div>
                <p className={su['no-org-msg']}>
                    You are not assigned to any organization yet. Please contact your administrator.
                </p>
            </div>
        );
    }

    return (
        <>
            <h2 className={su.sectionHeading}>🏛️ My Organization</h2>
            <h3 className={su['org-subtitle']}>{org.name}</h3>

            <div className={`${s.statsGrid} ${su['stats-compact']}`}>
                <div className={s.statCard}>
                    <div className={s.statIcon}>👥</div>
                    <div className={s.value}>{org.memberCount}</div>
                    <div className={s.label}>Members</div>
                </div>
                <div className={s.statCard}>
                    <div className={s.statIcon}>🏛️</div>
                    <div className={s.value}>{org.deptCount}</div>
                    <div className={s.label}>Departments</div>
                </div>
                <div className={s.statCard}>
                    <div className={s.statIcon}>👨‍👩‍👧‍👦</div>
                    <div className={s.value}>{org.teamCount}</div>
                    <div className={s.label}>Teams</div>
                </div>
                <div className={s.statCard}>
                    <div className={s.statIcon}>⏰</div>
                    <div className={s.value}>{org.work_hours_per_day}h</div>
                    <div className={s.label}>Work Hours/Day</div>
                </div>
            </div>

            <div className={s.tabs}>
                <button className={`${s.tab} ${tab === 'departments' ? s.active : ''}`} onClick={() => setTab('departments')}>
                    <span>🏛️</span> Departments
                </button>
                <button className={`${s.tab} ${tab === 'teams' ? s.active : ''}`} onClick={() => setTab('teams')}>
                    <span>👨‍👩‍👧‍👦</span> Teams
                </button>
                <button className={`${s.tab} ${tab === 'chart' ? s.active : ''}`} onClick={() => setTab('chart')}>
                    <span>🌳</span> Org Chart
                </button>
                <button className={`${s.tab} ${tab === 'overview' ? s.active : ''}`} onClick={() => setTab('overview')}>
                    <span>⚙️</span> Settings
                </button>
            </div>

            <div className={su['tab-content']}>
                {tab === 'overview' && <OrgSettings org={org} onUpdate={fetchOrg} userRole={userRole} />}
                {tab === 'departments' && <Departments orgId={org.id} userRole={userRole} />}
                {tab === 'teams' && <Teams orgId={org.id} userRole={userRole} />}
                {tab === 'chart' && <OrgChartView />}
            </div>
        </>
    );
}
