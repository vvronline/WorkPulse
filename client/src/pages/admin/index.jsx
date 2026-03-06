import React, { useState, useEffect } from 'react';
import { useAuth } from '../../AuthContext';
import { getAdminStats } from '../../api';
import UserManagement from './UserManagement';
import CreateUser from './CreateUser';
import OrganizationsTab from './OrganizationsTab';
import TaskLabelsTab from './TaskLabelsTab';
import AuditLogs from './AuditLogs';
import s from '../Admin.module.css';

export default function AdminPanel() {
    const { user } = useAuth();
    const [tab, setTab] = useState('users');
    const [stats, setStats] = useState(null);

    useEffect(() => {
        getAdminStats().then(r => setStats(r.data)).catch(e => console.error(e));
    }, []);

    if (!user || !['hr_admin', 'super_admin'].includes(user.role)) {
        return <div className={s.adminPage}><div className={s.error}>Access denied. HR Admin or Super Admin role required.</div></div>;
    }

    return (
        <div className={s.adminPage}>
            <h1>Admin Panel</h1>

            {stats && (
                <div className={s.statsGrid}>
                    <div className={s.statCard}>
                        <div className={s.statIcon}>✓</div>
                        <div className={s.value}>{stats.activeUsers}</div>
                        <div className={s.label}>Active Users</div>
                    </div>
                    <div className={s.statCard}>
                        <div className={s.statIcon}>👥</div>
                        <div className={s.value}>{stats.totalUsers}</div>
                        <div className={s.label}>Total Users</div>
                    </div>
                    <div className={s.statCard}>
                        <div className={s.statIcon}>🏛️</div>
                        <div className={s.value}>{stats.departments}</div>
                        <div className={s.label}>Departments</div>
                    </div>
                    <div className={s.statCard}>
                        <div className={s.statIcon}>👨‍👩‍👧‍👦</div>
                        <div className={s.value}>{stats.teams}</div>
                        <div className={s.label}>Teams</div>
                    </div>
                    <div className={s.statCard}>
                        <div className={s.statIcon}>⏳</div>
                        <div className={s.value}>{stats.pendingApprovals}</div>
                        <div className={s.label}>Pending Approvals</div>
                    </div>
                    <div className={s.statCard}>
                        <div className={s.statIcon}>⏰</div>
                        <div className={s.value}>{stats.clockedInToday}</div>
                        <div className={s.label}>Clocked In Today</div>
                    </div>
                </div>
            )}

            <div className={s.tabs}>
                <button className={`${s.tab} ${tab === 'users' ? s.active : ''}`} onClick={() => setTab('users')}>
                    <span>👥</span> Users
                </button>
                <button className={`${s.tab} ${tab === 'create' ? s.active : ''}`} onClick={() => setTab('create')}>
                    <span>➕</span> Create User
                </button>
                {(user.role === 'super_admin' || user.org_id) && (
                    <button className={`${s.tab} ${tab === 'organizations' ? s.active : ''}`} onClick={() => setTab('organizations')}>
                        <span>🏢</span> Organizations
                    </button>
                )}
                {(user.role === 'super_admin' || user.org_id) && (
                    <button className={`${s.tab} ${tab === 'labels' ? s.active : ''}`} onClick={() => setTab('labels')}>
                        <span>🏷️</span> Task Labels
                    </button>
                )}
                <button className={`${s.tab} ${tab === 'audit' ? s.active : ''}`} onClick={() => setTab('audit')}>
                    <span>📋</span> Audit Logs
                </button>
            </div>

            {tab === 'users' && <UserManagement userRole={user.role} />}
            {tab === 'create' && <CreateUser userRole={user.role} onCreated={() => setTab('users')} />}
            {tab === 'organizations' && (user.role === 'super_admin' || user.org_id) && <OrganizationsTab userRole={user.role} hasOrgId={!!user.org_id} />}
            {tab === 'labels' && (user.role === 'super_admin' || user.org_id) && <TaskLabelsTab />}
            {tab === 'audit' && <AuditLogs />}
        </div>
    );
}
