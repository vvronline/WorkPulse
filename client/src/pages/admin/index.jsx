import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
    Home, Users, UserPlus, Building, UsersRound, GitBranch, ScrollText,
    RefreshCw, Download, DollarSign, Megaphone, Tag, Settings as SettingsIcon,
    Menu, X, ChevronDown
} from 'lucide-react';
import { useAuth } from '../../AuthContext';
import { useSearchParams } from 'react-router-dom';
import { getRoleChangeRequests, getCurrentOrg } from '../../api';
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
import AdminHome from './AdminHome';
import Departments from '../../components/organization/Departments';
import Teams from '../../components/organization/Teams';
import OrgChartView from '../../components/organization/OrgChartView';
import OrgGeneralSettings from '../../components/organization/OrgSettings';
import s from './AdminLayout.module.css';

// ─── Section registry ─────────────────────────────────────────────────────
//
// Each section: { key, label, icon, group, requires?, hidden?, badge? }
//   requires: 'orgId' | 'super_admin' | 'platform_admin' | function(user) => boolean
//
// Groups are rendered in the order they appear here.

const SECTIONS = [
    { key: 'home',           label: 'Home',              icon: Home,         group: 'Overview' },

    { key: 'users',          label: 'Users',             icon: Users,        group: 'People' },
    { key: 'create',         label: 'Add User',          icon: UserPlus,     group: 'People' },
    { key: 'import',         label: 'Import Users',      icon: Download,     group: 'People' },
    { key: 'role-requests',  label: 'Role Requests',     icon: RefreshCw,    group: 'People', badgeKey: 'roleRequests' },

    { key: 'departments',    label: 'Departments',       icon: Building,     group: 'Structure', requires: 'orgId' },
    { key: 'teams',          label: 'Teams',             icon: UsersRound,   group: 'Structure', requires: 'orgId' },
    { key: 'org-chart',      label: 'Org Chart',         icon: GitBranch,    group: 'Structure', requires: 'orgId' },

    { key: 'payroll',        label: 'Payroll Periods',   icon: DollarSign,   group: 'Operations' },
    { key: 'labels',         label: 'Task Labels',       icon: Tag,          group: 'Operations' },

    { key: 'audit',          label: 'Audit Logs',        icon: ScrollText,   group: 'Compliance' },
    { key: 'org-settings',   label: 'Org Settings',      icon: SettingsIcon, group: 'Compliance', requires: 'orgId' },
    { key: 'settings',       label: 'Registration',      icon: SettingsIcon, group: 'Compliance', requires: 'super' },

    { key: 'announcements',  label: 'Announcements',     icon: Megaphone,    group: 'Platform', requires: 'super' },
    // Legacy/back-compat key — accepts ?tab=structure and routes to departments
];

// Back-compat alias map (old ?tab= values → new section keys)
const TAB_ALIASES = {
    structure: 'departments',
};

const GROUP_ORDER = ['Overview', 'People', 'Structure', 'Operations', 'Compliance', 'Platform'];

// Determine which sections this user is allowed to see
function isAllowed(section, user) {
    if (!section.requires) return true;
    if (section.requires === 'orgId') return !!user?.org_id;
    if (section.requires === 'super') {
        return user?.role === 'super_admin' || user?.role === 'platform_admin';
    }
    if (typeof section.requires === 'function') return section.requires(user);
    return true;
}

export default function AdminPanel() {
    const { user } = useAuth();
    const [searchParams, setSearchParams] = useSearchParams();
    const isPlatform = user?.role === 'platform_admin';

    // Resolve current section from URL (back-compat with old ?tab= values)
    const initialSection = (() => {
        const t = searchParams.get('tab') || 'home';
        return TAB_ALIASES[t] || t;
    })();
    const [section, setSection] = useState(initialSection);

    // Sidebar group collapsed state (persisted)
    const [collapsed, setCollapsed] = useState(() => {
        try {
            const raw = localStorage.getItem('admin_groups_collapsed');
            return raw ? JSON.parse(raw) : {};
        } catch { return {}; }
    });
    useEffect(() => {
        try { localStorage.setItem('admin_groups_collapsed', JSON.stringify(collapsed)); } catch {}
    }, [collapsed]);

    // Mobile drawer
    const [mobileOpen, setMobileOpen] = useState(false);

    // Badges (pending counts)
    const [badges, setBadges] = useState({ roleRequests: 0 });
    const refreshBadges = useCallback(() => {
        getRoleChangeRequests({ status: 'pending' })
            .then(r => setBadges(b => ({ ...b, roleRequests: (r.data || []).length })))
            .catch(() => {});
    }, []);
    useEffect(() => { refreshBadges(); }, [refreshBadges]);

    // Org-id for structure sub-pages — single fetch shared across them
    const [orgId, setOrgId] = useState(null);
    useEffect(() => {
        if (!user?.org_id) { setOrgId(null); return; }
        getCurrentOrg().then(r => setOrgId(r.data?.id || user.org_id)).catch(() => setOrgId(user.org_id));
    }, [user?.org_id]);

    // Sync with URL changes from outside (GlobalSearch etc.)
    useEffect(() => {
        const t = searchParams.get('tab');
        if (!t) return;
        const resolved = TAB_ALIASES[t] || t;
        if (resolved !== section) setSection(resolved);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchParams]);

    const navigate = useCallback((key) => {
        setSection(key);
        setMobileOpen(false);
        const next = new URLSearchParams(searchParams);
        if (key === 'home') next.delete('tab');
        else next.set('tab', key);
        setSearchParams(next, { replace: true });
        // refresh role-request badge after returning from that section
        if (key === 'home' || key === 'role-requests' || key === 'users') refreshBadges();
    }, [searchParams, setSearchParams, refreshBadges]);

    // Build allowed nav grouped by group label
    const navGroups = useMemo(() => {
        const groups = new Map();
        for (const sec of SECTIONS) {
            if (!isAllowed(sec, user)) continue;
            if (!groups.has(sec.group)) groups.set(sec.group, []);
            groups.get(sec.group).push(sec);
        }
        // return in GROUP_ORDER
        return GROUP_ORDER.filter(g => groups.has(g)).map(g => ({ name: g, items: groups.get(g) }));
    }, [user]);

    const currentSection = SECTIONS.find(sec => sec.key === section) || SECTIONS[0];
    const currentTitle = currentSection.label === 'Home' ? 'Admin Panel' : currentSection.label;

    // Access guard
    if (!user || !['hr_admin', 'super_admin', 'platform_admin'].includes(user.role)) {
        return (
            <div className={s.shell}>
                <div className={s.content}>
                    <h1>Admin Panel</h1>
                    <div className={s.accessDenied}>
                        Access denied. HR Admin, Super Admin, or Platform Admin role required.
                    </div>
                </div>
            </div>
        );
    }

    const toggleGroup = (groupName) => {
        setCollapsed(c => ({ ...c, [groupName]: !c[groupName] }));
    };

    // ─── Section renderer ────────────────────────────────────────────────
    const renderSection = () => {
        switch (section) {
            case 'home':
                return <AdminHome user={user} onNavigate={navigate} />;
            case 'users':
                return <UserManagement userRole={user.role} />;
            case 'create':
                return <CreateUser userRole={user.role} onCreated={() => navigate('users')} />;
            case 'role-requests':
                return <RoleRequests userRole={user.role} />;
            case 'import':
                return <ImportUsers />;
            case 'payroll':
                return <PayPeriods />;
            case 'labels':
                return <TaskLabelsTab />;
            case 'audit':
                return <AuditLogs />;
            case 'departments':
                return user.org_id && orgId
                    ? <Departments orgId={orgId} userRole={user.role} />
                    : <p>You are not assigned to an organization.</p>;
            case 'teams':
                return user.org_id && orgId
                    ? <Teams orgId={orgId} userRole={user.role} />
                    : <p>You are not assigned to an organization.</p>;
            case 'org-chart':
                return user.org_id ? <OrgChartView /> : <p>You are not assigned to an organization.</p>;
            case 'org-settings':
                // The OrganizationSettings (general: timezone, work hours, holidays) lives in components/organization
                return user.org_id
                    ? <OrgSettingsWrapper userRole={user.role} />
                    : <p>You are not assigned to an organization.</p>;
            case 'settings':
                return (user.role === 'super_admin' || isPlatform)
                    ? <OrgSettings />
                    : <div className={s.accessDenied}>Insufficient permissions.</div>;
            case 'announcements':
                return (user.role === 'super_admin' || isPlatform)
                    ? <AnnouncementsTab userRole={user.role} />
                    : <div className={s.accessDenied}>Insufficient permissions.</div>;
            // Back-compat: old MyOrganization view (departments + teams + chart + general)
            case 'my-org':
                return user.org_id ? <MyOrganization userRole={user.role} /> : null;
            default:
                return <AdminHome user={user} onNavigate={navigate} />;
        }
    };

    return (
        <div className={s.shell}>
            {/* Mobile top bar */}
            <div className={s.mobileBar}>
                <button className={s.mobileToggle} onClick={() => setMobileOpen(true)} aria-label="Open admin menu">
                    <Menu size={16} /> Menu
                </button>
                <div className={s.mobileTitle}>{currentTitle}</div>
                <span style={{ width: 70 }} />
            </div>

            {/* Mobile scrim */}
            <div
                className={`${s.scrim} ${mobileOpen ? s.open : ''}`}
                onClick={() => setMobileOpen(false)}
                aria-hidden="true"
            />

            {/* ─── Sidebar ─── */}
            <aside className={`${s.sidebar} ${mobileOpen ? s.open : ''}`} aria-label="Admin navigation">
                <div className={s.brandRow}>
                    <SettingsIcon size={18} />
                    <div>
                        <div className={s.brandTitle}>Admin Panel</div>
                        <div className={s.brandSubtitle}>
                            {user.role === 'platform_admin' ? 'Platform Admin'
                                : user.role === 'super_admin' ? 'Super Admin' : 'HR Admin'}
                        </div>
                    </div>
                    <button
                        className={s.mobileToggle}
                        style={{ marginLeft: 'auto', padding: '0.25rem 0.4rem', display: 'none' }}
                        onClick={() => setMobileOpen(false)}
                        aria-label="Close menu"
                        // shown via CSS only when needed; harmless on desktop
                    >
                        <X size={14} />
                    </button>
                </div>

                {navGroups.map(group => {
                    const isCollapsed = !!collapsed[group.name];
                    // 'Overview' is single-item; render without group label for cleanliness
                    if (group.items.length === 1 && group.name === 'Overview') {
                        const item = group.items[0];
                        const Icon = item.icon;
                        const isActive = section === item.key;
                        return (
                            <div className={s.groupItems} key={group.name}>
                                <button
                                    className={`${s.navItem} ${isActive ? s.active : ''}`}
                                    onClick={() => navigate(item.key)}
                                >
                                    <span className={s.navIcon}><Icon size={16} /></span>
                                    <span className={s.navLabel}>{item.label}</span>
                                </button>
                            </div>
                        );
                    }

                    return (
                        <div className={s.group} key={group.name}>
                            <button
                                type="button"
                                className={`${s.groupLabel} ${isCollapsed ? s.collapsed : ''}`}
                                onClick={() => toggleGroup(group.name)}
                            >
                                <span>{group.name}</span>
                                <ChevronDown size={12} className={s.chev} />
                            </button>
                            {!isCollapsed && (
                                <div className={s.groupItems}>
                                    {group.items.map(item => {
                                        const Icon = item.icon;
                                        const isActive = section === item.key;
                                        const badge = item.badgeKey ? badges[item.badgeKey] : 0;
                                        return (
                                            <button
                                                key={item.key}
                                                className={`${s.navItem} ${isActive ? s.active : ''}`}
                                                onClick={() => navigate(item.key)}
                                            >
                                                <span className={s.navIcon}><Icon size={16} /></span>
                                                <span className={s.navLabel}>{item.label}</span>
                                                {badge > 0 && (
                                                    <span className={`${s.navBadge} ${s.warning}`}>{badge}</span>
                                                )}
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    );
                })}
            </aside>

            {/* ─── Content ─── */}
            <main className={s.content}>
                <div className={s.contentHeader}>
                    <div>
                        <h1 className={s.contentTitle}>{currentTitle}</h1>
                        {currentSection.key === 'home' && (
                            <p className={s.contentDesc}>
                                Welcome back, {user.full_name || user.username}. Here's what needs your attention.
                            </p>
                        )}
                    </div>
                </div>
                {renderSection()}
            </main>
        </div>
    );
}

/**
 * Thin wrapper that loads the current org and renders the general OrgSettings
 * component (timezone / work hours / fiscal year) without the full
 * MyOrganization sub-tab strip.
 */
function OrgSettingsWrapper({ userRole }) {
    const [org, setOrg] = useState(null);
    const [loading, setLoading] = useState(true);

    const fetchOrg = useCallback(() => {
        setLoading(true);
        getCurrentOrg().then(r => { setOrg(r.data); setLoading(false); }).catch(() => setLoading(false));
    }, []);

    useEffect(() => { fetchOrg(); }, [fetchOrg]);

    if (loading) return <div>Loading…</div>;
    if (!org) return <p>You are not assigned to any organization yet.</p>;

    return <OrgGeneralSettings org={org} onUpdate={fetchOrg} userRole={userRole} />;
}