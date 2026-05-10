import React, { useEffect, useState, useMemo } from 'react';
import {
    AlertTriangle, RefreshCw, ClipboardList, UserPlus, Users, Building, UsersRound,
    Clock, AlarmClock, ArrowRight, CheckCircle2, Circle, Megaphone, Network, Tag,
    DollarSign, Download, ScrollText, Settings as SettingsIcon
} from 'lucide-react';
import {
    getAdminStats, getRoleChangeRequests, getApprovals, getCurrentOrg, getOrgDepartments,
    getOrgTeams, getLeavePolicies
} from '../../api';
import s from './AdminLayout.module.css';

/**
 * AdminHome — attention-first dashboard.
 *
 * Shows:
 *  - Attention cards (pending role requests, pending approvals, etc.)
 *  - Compact org stats grid (active users, depts, teams, clocked-in today)
 *  - Quick actions row
 *  - Setup checklist for new orgs (timezone, dept, team, leave policy)
 *
 * Props:
 *   user            – auth user
 *   onNavigate(key) – call to switch to a section in the parent shell
 */
export default function AdminHome({ user, onNavigate }) {
    const [stats, setStats] = useState(null);
    const [pendingRoleRequests, setPendingRoleRequests] = useState(0);
    const [pendingApprovals, setPendingApprovals] = useState(0);
    const [setup, setSetup] = useState({ tzSet: false, hasDept: false, hasTeam: false, hasPolicy: false, loaded: false });

    useEffect(() => {
        let alive = true;
        getAdminStats().then(r => { if (alive) setStats(r.data); }).catch(() => {});
        getRoleChangeRequests({ status: 'pending' })
            .then(r => { if (alive) setPendingRoleRequests((r.data || []).length); })
            .catch(() => {});
        getApprovals({ status: 'pending' })
            .then(r => { if (alive) setPendingApprovals((r.data?.data || r.data || []).length); })
            .catch(() => {});
        return () => { alive = false; };
    }, []);

    // Setup checklist (silent failures – best-effort signals only)
    useEffect(() => {
        if (!user?.org_id) return;
        let alive = true;
        Promise.allSettled([
            getCurrentOrg(),
            getOrgDepartments(),
            getOrgTeams(),
            getLeavePolicies(),
        ]).then(([orgR, deptR, teamR, polR]) => {
            if (!alive) return;
            const org = orgR.status === 'fulfilled' ? orgR.value.data : null;
            const depts = deptR.status === 'fulfilled' ? (deptR.value.data || []) : [];
            const teams = teamR.status === 'fulfilled' ? (teamR.value.data || []) : [];
            const pols = polR.status === 'fulfilled' ? (polR.value.data || []) : [];
            setSetup({
                tzSet: !!(org && org.timezone && org.timezone !== 'UTC'),
                hasDept: depts.length > 0,
                hasTeam: teams.length > 0,
                hasPolicy: pols.length > 0,
                loaded: true,
            });
        });
        return () => { alive = false; };
    }, [user?.org_id]);

    const checklist = useMemo(() => ([
        { key: 'tzSet',     label: 'Set organization timezone & work hours', target: 'org-settings', done: setup.tzSet },
        { key: 'hasDept',   label: 'Create at least one department',         target: 'departments',  done: setup.hasDept },
        { key: 'hasTeam',   label: 'Create at least one team',               target: 'teams',        done: setup.hasTeam },
        { key: 'hasPolicy', label: 'Define a leave policy',                  target: 'org-settings', done: setup.hasPolicy },
    ]), [setup]);

    const setupComplete = checklist.every(c => c.done);
    const setupProgress = checklist.filter(c => c.done).length;

    // ─── Attention cards ──────────────────────────────────────────────────
    const attention = [];
    if (pendingRoleRequests > 0) {
        attention.push({
            key: 'role-requests',
            icon: <RefreshCw size={18} />,
            iconClass: 'warning',
            value: pendingRoleRequests,
            label: pendingRoleRequests === 1 ? 'role change request needs review' : 'role change requests need review',
            action: 'Review now',
            target: 'role-requests',
        });
    }
    if (pendingApprovals > 0) {
        attention.push({
            key: 'approvals',
            icon: <ClipboardList size={18} />,
            iconClass: 'warning',
            value: pendingApprovals,
            label: pendingApprovals === 1 ? 'leave / overtime approval pending' : 'leave / overtime approvals pending',
            action: 'Open queue',
            target: '__manager__', // navigate outside admin to /manager
        });
    }
    if (stats && stats.pendingApprovals > 0 && pendingApprovals === 0) {
        // Fallback if /manager/approvals isn't accessible (HR-only role)
        attention.push({
            key: 'pending-stats',
            icon: <AlertTriangle size={18} />,
            iconClass: 'warning',
            value: stats.pendingApprovals,
            label: 'pending approvals across the organization',
            action: null,
            target: null,
        });
    }
    if (!setupComplete && setup.loaded && user?.org_id) {
        attention.push({
            key: 'setup',
            icon: <SettingsIcon size={18} />,
            iconClass: 'success',
            value: `${setupProgress}/${checklist.length}`,
            label: 'organization setup steps completed',
            action: 'Finish setup',
            target: '__setup__',
        });
    }

    const goto = (target) => {
        if (!target) return;
        if (target === '__manager__') {
            window.location.assign('/manager');
            return;
        }
        if (target === '__setup__') {
            // Scroll the checklist into view
            document.getElementById('admin-setup-checklist')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
        }
        onNavigate?.(target);
    };

    return (
        <div className={s.homeWrap}>
            {/* ─── Attention strip ─── */}
            {attention.length > 0 && (
                <div className={s.attentionGrid}>
                    {attention.map(a => (
                        <button
                            key={a.key}
                            type="button"
                            className={s.attnCard}
                            onClick={() => goto(a.target)}
                            disabled={!a.target}
                            style={!a.target ? { cursor: 'default' } : undefined}
                        >
                            <div className={`${s.attnIcon} ${s[a.iconClass] || ''}`}>{a.icon}</div>
                            <div className={s.attnBody}>
                                <div className={s.attnValue}>{a.value}</div>
                                <div className={s.attnLabel}>{a.label}</div>
                                {a.action && (
                                    <div className={s.attnAction}>
                                        {a.action} <ArrowRight size={12} />
                                    </div>
                                )}
                            </div>
                        </button>
                    ))}
                </div>
            )}

            {/* ─── Compact stats ─── */}
            {stats && (
                <div className={s.statsRow}>
                    <div className={s.miniStat}>
                        <CheckCircle2 size={20} className={s.miniIcon} />
                        <div>
                            <div className={s.miniVal}>{stats.activeUsers ?? 0}</div>
                            <div className={s.miniLabel}>Active users</div>
                        </div>
                    </div>
                    <div className={s.miniStat}>
                        <Users size={20} className={s.miniIcon} />
                        <div>
                            <div className={s.miniVal}>{stats.totalUsers ?? 0}</div>
                            <div className={s.miniLabel}>Total users</div>
                        </div>
                    </div>
                    <div className={s.miniStat}>
                        <Building size={20} className={s.miniIcon} />
                        <div>
                            <div className={s.miniVal}>{stats.departments ?? 0}</div>
                            <div className={s.miniLabel}>Departments</div>
                        </div>
                    </div>
                    <div className={s.miniStat}>
                        <UsersRound size={20} className={s.miniIcon} />
                        <div>
                            <div className={s.miniVal}>{stats.teams ?? 0}</div>
                            <div className={s.miniLabel}>Teams</div>
                        </div>
                    </div>
                    <div className={s.miniStat}>
                        <AlarmClock size={20} className={s.miniIcon} />
                        <div>
                            <div className={s.miniVal}>{stats.clockedInToday ?? 0}</div>
                            <div className={s.miniLabel}>Clocked-in today</div>
                        </div>
                    </div>
                </div>
            )}

            {/* ─── Quick actions + setup checklist ─── */}
            <div className={s.sectionRow}>
                <div className={s.panel}>
                    <h3 className={s.panelTitle}><UserPlus size={16} />Quick actions</h3>
                    <div className={s.quickRow}>
                        <button className={s.quickBtn} onClick={() => onNavigate('add')}><UserPlus size={14} />Add people</button>
                        {user?.org_id && (
                            <button className={s.quickBtn} onClick={() => onNavigate('departments')}><Building size={14} />New department</button>
                        )}
                        {user?.org_id && (
                            <button className={s.quickBtn} onClick={() => onNavigate('teams')}><UsersRound size={14} />New team</button>
                        )}
                        <button className={s.quickBtn} onClick={() => onNavigate('payroll')}><DollarSign size={14} />Lock pay period</button>
                        <button className={s.quickBtn} onClick={() => onNavigate('labels')}><Tag size={14} />Manage labels</button>
                        <button className={s.quickBtn} onClick={() => onNavigate('audit')}><ScrollText size={14} />View audit logs</button>
                    </div>
                </div>

                {user?.org_id && (
                    <div className={s.panel} id="admin-setup-checklist">
                        <h3 className={s.panelTitle}>
                            <Network size={16} />Setup checklist
                            <span className={s.ckHint} style={{ marginLeft: 'auto' }}>{setupProgress}/{checklist.length} done</span>
                        </h3>
                        <ul className={s.checklist}>
                            {checklist.map(item => (
                                <li key={item.key} style={{ listStyle: 'none' }}>
                                    <button
                                        type="button"
                                        className={`${s.checklistItem} ${item.done ? s.done : ''}`}
                                        onClick={() => goto(item.target)}
                                    >
                                        {item.done
                                            ? <CheckCircle2 size={16} className={s.ckIcon} color="var(--success)" />
                                            : <Circle size={16} className={s.ckIcon} />}
                                        <span className={s.ckLabel}>{item.label}</span>
                                        {!item.done && <ArrowRight size={13} />}
                                    </button>
                                </li>
                            ))}
                        </ul>
                        {setupComplete && setup.loaded && (
                            <div className={s.ckHint} style={{ marginTop: 8 }}>
                                <CheckCircle2 size={13} color="var(--success)" style={{ verticalAlign: 'middle', marginRight: 4 }} />
                                Your organization is fully set up.
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}