import React, { useState, useEffect } from 'react';
import { CheckCircle2, Users, Building, UsersRound, Clock, AlarmClock, UserPlus, ScrollText, RefreshCw, Download, DollarSign, Megaphone, Network, Tag, Settings } from 'lucide-react';
import { useAuth } from '../../AuthContext';
import { useSearchParams } from 'react-router-dom';
import { getAdminStats } from '../../api';
import UserManagement from './UserManagement';
import CreateUser from './CreateUser';
import MyOrganization from './MyOrganization';
import AuditLogs from './AuditLogs';
import RoleRequests from './RoleRequests';
import ImportUsers from './ImportUsers';
import PayPeriods from './PayPeriods';
import AnnouncementsTab from './AnnouncementsTab';
import OrgSettings from './OrgSettings';
import TaskLabelsTab from './TaskLabelsTab';
import s from '../Admin.module.css';

export default function AdminPanel() {
    const { user } = useAuth();
    const [searchParams] = useSearchParams();
    const isPlatform = user?.role === 'platform_admin';
    const [tab, setTab] = useState(searchParams.get('tab') || 'users');
    const [stats, setStats] = useState(null);

    // Sync tab when URL changes (e.g. navigated from GlobalSearch)
    useEffect(() => {
        const t = searchParams.get('tab');
        if (t) setTab(t);
    }, [searchParams]);

    useEffect(() => {
        getAdminStats().then(r => setStats(r.data)).catch(e => console.error(e));
    }, []);

    if (!user || !['hr_admin', 'super_admin', 'platform_admin'].includes(user.role)) {
        return <div className={s.adminPage}><div className={s.error}>Access denied. HR Admin, Super Admin, or Platform Admin role required.</div></div>;
    }

    return (
        <div className={s.adminPage}>
            <h1>Admin Panel</h1>

            {stats && (
                <div className={s.statsGrid}>
                    <div className={s.statCard}>
                        <div className={s.statIcon}><CheckCircle2 size={22} /></div>
                        <div className={s.value}>{stats.activeUsers}</div>
                        <div className={s.label}>Active Users</div>
                    </div>
                    <div className={s.statCard}>
                        <div className={s.statIcon}><Users size={22} /></div>
                        <div className={s.value}>{stats.totalUsers}</div>
                        <div className={s.label}>Total Users</div>
                    </div>
                    <div className={s.statCard}>
                        <div className={s.statIcon}><Building size={22} /></div>
                        <div className={s.value}>{stats.departments}</div>
                        <div className={s.label}>Departments</div>
                    </div>
                    <div className={s.statCard}>
                        <div className={s.statIcon}><UsersRound size={22} /></div>
                        <div className={s.value}>{stats.teams}</div>
                        <div className={s.label}>Teams</div>
                    </div>
                    <div className={s.statCard}>
                        <div className={s.statIcon}><Clock size={22} /></div>
                        <div className={s.value}>{stats.pendingApprovals}</div>
                        <div className={s.label}>Pending Approvals</div>
                    </div>
                    <div className={s.statCard}>
                        <div className={s.statIcon}><AlarmClock size={22} /></div>
                        <div className={s.value}>{stats.clockedInToday}</div>
                        <div className={s.label}>Clocked In Today</div>
                    </div>
                </div>
            )}

            <div className={s.tabs}>
                {/* ─── Organization Section ─── */}
                <button className={`${s.tab} ${tab === 'users' ? s.active : ''}`} onClick={() => setTab('users')}>
                    <span><Users size={14} /></span> Users
                </button>
                <button className={`${s.tab} ${tab === 'create' ? s.active : ''}`} onClick={() => setTab('create')}>
                    <span><UserPlus size={14} /></span> Create User
                </button>
                {user.org_id && (
                    <button className={`${s.tab} ${tab === 'structure' ? s.active : ''}`} onClick={() => setTab('structure')}>
                        <span><Network size={14} /></span> Structure
                    </button>
                )}
                <button className={`${s.tab} ${tab === 'audit' ? s.active : ''}`} onClick={() => setTab('audit')}>
                    <span><ScrollText size={14} /></span> Audit Logs
                </button>
                <button className={`${s.tab} ${tab === 'role-requests' ? s.active : ''}`} onClick={() => setTab('role-requests')}>
                    <span><RefreshCw size={14} /></span> Role Requests
                </button>
                <button className={`${s.tab} ${tab === 'import' ? s.active : ''}`} onClick={() => setTab('import')}>
                    <span><Download size={14} /></span> Import Users
                </button>
                <button className={`${s.tab} ${tab === 'payroll' ? s.active : ''}`} onClick={() => setTab('payroll')}>
                    <span><DollarSign size={14} /></span> Payroll
                </button>
                <button className={`${s.tab} ${tab === 'labels' ? s.active : ''}`} onClick={() => setTab('labels')}>
                    <span><Tag size={14} /></span> Task Labels
                </button>
                {(user.role === 'super_admin' || isPlatform) && (
                    <button className={`${s.tab} ${tab === 'announcements' ? s.active : ''}`} onClick={() => setTab('announcements')}>
                        <span><Megaphone size={14} /></span> Announcements
                    </button>
                )}
                {(user.role === 'super_admin' || isPlatform) && (
                    <button className={`${s.tab} ${tab === 'settings' ? s.active : ''}`} onClick={() => setTab('settings')}>
                        <span><Settings size={14} /></span> Settings
                    </button>
                )}
            </div>

            {/* ─── Organization Content ─── */}
            {tab === 'users' && <UserManagement userRole={user.role} />}
            {tab === 'create' && <CreateUser userRole={user.role} onCreated={() => setTab('users')} />}
            {tab === 'structure' && user.org_id && <MyOrganization userRole={user.role} />}
            {tab === 'audit' && <AuditLogs />}
            {tab === 'role-requests' && <RoleRequests userRole={user.role} />}
            {tab === 'import' && <ImportUsers />}
            {tab === 'payroll' && <PayPeriods />}
            {tab === 'labels' && <TaskLabelsTab />}
            {tab === 'announcements' && (user.role === 'super_admin' || isPlatform) && <AnnouncementsTab userRole={user.role} />}
            {tab === 'settings' && (user.role === 'super_admin' || isPlatform) && <OrgSettings />}
        </div>
    );
}
