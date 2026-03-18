import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { globalSearch } from '../api';
import s from './GlobalSearch.module.css';

const ROLE_LABELS = {
    employee: 'Employee', team_lead: 'Team Lead', manager: 'Manager',
    hr_admin: 'HR Admin', super_admin: 'Super Admin',
};

const ROLE_LEVEL = { employee: 1, team_lead: 2, manager: 3, hr_admin: 4, super_admin: 5 };

// Static navigation / command-palette index.
// minRole: user must be at least this role to see the item.
const NAV_INDEX = [
    { icon: '🏠', title: 'Dashboard',          sub: 'Home overview & time tracker',          path: '/',                         keywords: 'home overview clock tracker' },
    { icon: '📅', title: 'Calendar',            sub: 'Events, reminders & schedules',         path: '/calendar',                 keywords: 'events reminders schedule' },
    { icon: '✅', title: 'Tasks',               sub: 'My tasks & assignments',                path: '/tasks',                    keywords: 'todo assignments work tickets' },
    { icon: '📝', title: 'Notes',               sub: 'Personal notebook',                     path: '/notes',                    keywords: 'notebook journal writing pages' },
    { icon: '💬', title: 'Chat',                sub: 'Team messaging',                        path: '/chat',                     keywords: 'messages messaging team direct' },
    { icon: '🏖️', title: 'Leaves',              sub: 'Leave requests & history',              path: '/leaves',                   keywords: 'vacation time off absence sick holiday request' },
    { icon: '📊', title: 'Analytics',           sub: 'Work hours & productivity stats',       path: '/analytics',                keywords: 'reports hours productivity stats charts' },
    { icon: '✏️', title: 'Manual Entry',        sub: 'Log work hours manually',               path: '/manual-entry',             keywords: 'clock time log entry hours manual' },
    { icon: '🏢', title: 'Organization',        sub: 'Org profile & settings',                path: '/organization',             keywords: 'company settings profile org details' },
    { icon: '📋', title: 'Leave Policy',        sub: 'Leave balances & public holidays',      path: '/leave-policy',             keywords: 'balance quota leave entitlement policy' },
    { icon: '💰', title: 'Leave Balances',      sub: 'My leave balances & quotas',            path: '/leave-policy?tab=balances', keywords: 'quota remaining sick planned balance' },
    { icon: '🎉', title: 'Holidays',            sub: 'Company public holidays',               path: '/leave-policy?tab=holidays', keywords: 'public holiday national bank calendar' },
    { icon: '👥', title: 'Manager Dashboard',   sub: 'Team approvals & reports',              path: '/manager',                  keywords: 'approve team overtime manual reports pending', minRole: 'team_lead' },
    { icon: '🔧', title: 'Admin Panel',         sub: 'User & org management',                 path: '/admin',                    keywords: 'admin manage settings panel',               minRole: 'hr_admin' },
    { icon: '👤', title: 'User Management',     sub: 'View & edit user accounts',             path: '/admin?tab=users',          keywords: 'users employees accounts manage',            minRole: 'hr_admin' },
    { icon: '➕', title: 'Create User',         sub: 'Add a new user account',                path: '/admin?tab=create',         keywords: 'new user create add register',               minRole: 'hr_admin' },
    { icon: '📥', title: 'Import Users',        sub: 'Bulk import from CSV / JSON',           path: '/admin?tab=import',         keywords: 'bulk import csv json users batch',           minRole: 'hr_admin' },
    { icon: '📜', title: 'Audit Logs',          sub: 'System activity history',               path: '/admin?tab=audit',          keywords: 'logs history activity events actions audit', minRole: 'hr_admin' },
    { icon: '🔄', title: 'Role Requests',       sub: 'Pending role change requests',          path: '/admin?tab=role-requests',  keywords: 'role promotion request pending',             minRole: 'hr_admin' },
    { icon: '💰', title: 'Payroll',             sub: 'Pay periods & payroll export',          path: '/admin?tab=payroll',        keywords: 'pay salary export hours period payroll',     minRole: 'hr_admin' },
    { icon: '🏛️', title: 'Organizations',       sub: 'Manage all organizations / tenants',    path: '/admin?tab=organizations',  keywords: 'org tenant company organizations',           minRole: 'super_admin' },
    { icon: '📋', title: 'Leave Policies',      sub: 'Configure leave quotas & accrual',      path: '/leave-policy?tab=policies', keywords: 'policy accrual quota configure sick',      minRole: 'hr_admin' },
    { icon: '👥', title: 'All Leave Balances',  sub: "View all employees' leave balances",    path: '/leave-policy?tab=allBalances', keywords: 'all balances employees leave',            minRole: 'hr_admin' },
];

const LEAVE_STATUS_COLOR = { approved: '#16a34a', pending: '#d97706', rejected: '#dc2626', withdraw_pending: '#7c3aed' };
const SPRINT_STATUS_COLOR = { active: '#16a34a', planned: '#2563eb', completed: '#6b7280' };

export default function GlobalSearch({ onClose }) {
    const { user } = useAuth();
    const [query, setQuery] = useState('');
    const [results, setResults] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [activeIdx, setActiveIdx] = useState(-1);
    const inputRef = useRef(null);
    const navigate = useNavigate();
    const debounceRef = useRef(null);
    const abortCtrlRef = useRef(null);

    const userLevel = ROLE_LEVEL[user?.role] || 1;

    // Filter nav items the user is allowed to see
    const visibleNav = useMemo(() => NAV_INDEX.filter(n =>
        !n.minRole || userLevel >= (ROLE_LEVEL[n.minRole] || 1)
    ), [userLevel]);

    // Client-side nav filter
    const navResults = useMemo(() => {
        if (!query || query.trim().length < 2) return [];
        const lower = query.trim().toLowerCase();
        return visibleNav.filter(n =>
            n.title.toLowerCase().includes(lower) ||
            n.sub.toLowerCase().includes(lower) ||
            n.keywords.toLowerCase().includes(lower)
        ).slice(0, 6);
    }, [query, visibleNav]);

    useEffect(() => { inputRef.current?.focus(); }, []);

    useEffect(() => {
        const handle = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', handle);
        return () => window.removeEventListener('keydown', handle);
    }, [onClose]);

    const doSearch = useCallback(async (q) => {
        if (q.trim().length < 2) { setResults(null); setError(''); return; }
        abortCtrlRef.current?.abort();
        const controller = new AbortController();
        abortCtrlRef.current = controller;
        setLoading(true);
        setError('');
        try {
            const res = await globalSearch(q.trim(), controller.signal);
            setResults(res.data);
            setActiveIdx(-1);
        } catch (err) {
            if (err.name === 'CanceledError' || err.code === 'ERR_CANCELED') return;
            setError('Search failed. Please try again.');
            setResults(null);
        } finally {
            setLoading(false);
        }
    }, []);

    // Abort any pending request and debounce timer on unmount
    useEffect(() => () => {
        clearTimeout(debounceRef.current);
        abortCtrlRef.current?.abort();
    }, []);

    const handleChange = (e) => {
        const val = e.target.value;
        setQuery(val);
        clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => doSearch(val), 350);
    };

    // Flatten all results for keyboard navigation
    const flatItems = [
        ...navResults.map(n => ({ type: 'nav', data: n })),
        ...(results?.tasks  || []).map(t => ({ type: 'task',   data: t })),
        ...(results?.notes  || []).map(n => ({ type: 'note',   data: n })),
        ...(results?.events || []).map(e => ({ type: 'event',  data: e })),
        ...(results?.leaves || []).map(l => ({ type: 'leave',  data: l })),
        ...(results?.sprints|| []).map(sp=> ({ type: 'sprint', data: sp})),
        ...(results?.users  || []).map(u => ({ type: 'user',   data: u })),
        ...(results?.logs   || []).map(l => ({ type: 'log',    data: l })),
    ];

    const handleKeyDown = (e) => {
        if (!flatItems.length) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveIdx(i => Math.min(i + 1, flatItems.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIdx(i => Math.max(i - 1, 0));
        } else if (e.key === 'Enter' && activeIdx >= 0) {
            e.preventDefault();
            navigateToItem(flatItems[activeIdx]);
        }
    };

    const navigateToItem = ({ type, data }) => {
        onClose();
        switch (type) {
            case 'nav':    navigate(data.path); break;
            case 'task':   navigate(`/tasks?taskId=${data.id}`); break;
            case 'note':   navigate(`/notes?pageId=${data.id}`); break;
            case 'event':  navigate('/calendar'); break;
            case 'leave':  navigate('/leaves'); break;
            case 'sprint': navigate('/manager'); break;
            case 'user':   navigate(`/admin?tab=users&userId=${data.id}`); break;
            case 'log':    navigate('/admin?tab=audit'); break;
        }
    };

    const hasResults = navResults.length > 0 || (results && (
        results.tasks?.length || results.notes?.length || results.events?.length ||
        results.leaves?.length || results.sprints?.length ||
        results.users?.length || results.logs?.length
    ));

    let flatIdx = 0;

    return (
        <div className={s.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div className={s.modal} role="dialog" aria-label="Global search">
                <div className={s.inputRow}>
                    <span className={s.icon}>🔍</span>
                    <input
                        ref={inputRef}
                        className={s.input}
                        type="text"
                        value={query}
                        onChange={handleChange}
                        onKeyDown={handleKeyDown}
                        placeholder="Search or jump to any page, task, leave, event…"
                        autoComplete="off"
                        spellCheck={false}
                    />
                    {loading && <span className={s.spinner} aria-label="Searching" />}
                    <button className={s.closeBtn} onClick={onClose} aria-label="Close search">✕</button>
                </div>

                {error && <p className={s.error}>{error}</p>}

                {!hasResults && !loading && query.trim().length < 2 && (
                    <p className={s.hint}>Type at least 2 characters — search tasks, notes, leaves, events, people, or jump to any page</p>
                )}

                {!hasResults && !loading && query.trim().length >= 2 && (
                    <p className={s.hint}>No results for "{query}"</p>
                )}

                {hasResults && (
                    <div className={s.results}>

                        {/* ── Navigation / Pages ── */}
                        {navResults.length > 0 && (
                            <section>
                                <h4 className={s.sectionTitle}>Pages &amp; Features</h4>
                                {navResults.map((n) => {
                                    const idx = flatIdx++;
                                    return (
                                        <button
                                            key={`nav-${n.path}`}
                                            className={`${s.item} ${activeIdx === idx ? s.active : ''}`}
                                            onClick={() => navigateToItem({ type: 'nav', data: n })}
                                            onMouseEnter={() => setActiveIdx(idx)}
                                        >
                                            <span className={s.itemIcon}>{n.icon}</span>
                                            <div className={s.itemBody}>
                                                <span className={s.itemTitle}>{n.title}</span>
                                                <span className={s.snippet}>{n.sub}</span>
                                            </div>
                                            <span className={s.badgeDefault}>Go →</span>
                                        </button>
                                    );
                                })}
                            </section>
                        )}

                        {/* ── Tasks ── */}
                        {results?.tasks?.length > 0 && (
                            <section>
                                <h4 className={s.sectionTitle}>Tasks</h4>
                                {results.tasks.map((t) => {
                                    const idx = flatIdx++;
                                    return (
                                        <button
                                            key={`task-${t.id}`}
                                            className={`${s.item} ${activeIdx === idx ? s.active : ''}`}
                                            onClick={() => navigateToItem({ type: 'task', data: t })}
                                            onMouseEnter={() => setActiveIdx(idx)}
                                        >
                                            <span className={s.itemIcon}>📋</span>
                                            <div className={s.itemBody}>
                                                <span className={s.itemTitle}>{t.title}</span>
                                                {t.snippet && (
                                                    <span
                                                        className={s.snippet}
                                                        dangerouslySetInnerHTML={{ __html: t.snippet }}
                                                    />
                                                )}
                                            </div>
                                            <span className={`${s.badge} ${s[`status-${t.status}`] || s.badgeDefault}`}>
                                                {t.status?.replace(/_/g, ' ')}
                                            </span>
                                        </button>
                                    );
                                })}
                            </section>
                        )}

                        {/* ── Notes ── */}
                        {results?.notes?.length > 0 && (
                            <section>
                                <h4 className={s.sectionTitle}>Notes</h4>
                                {results.notes.map((n) => {
                                    const idx = flatIdx++;
                                    return (
                                        <button
                                            key={`note-${n.id}`}
                                            className={`${s.item} ${activeIdx === idx ? s.active : ''}`}
                                            onClick={() => navigateToItem({ type: 'note', data: n })}
                                            onMouseEnter={() => setActiveIdx(idx)}
                                        >
                                            <span className={s.itemIcon}>📝</span>
                                            <div className={s.itemBody}>
                                                <span className={s.itemTitle}>{n.title}</span>
                                                {n.snippet && <span className={s.snippet}>{n.snippet}</span>}
                                            </div>
                                        </button>
                                    );
                                })}
                            </section>
                        )}

                        {/* ── Calendar Events ── */}
                        {results?.events?.length > 0 && (
                            <section>
                                <h4 className={s.sectionTitle}>Calendar Events</h4>
                                {results.events.map((e) => {
                                    const idx = flatIdx++;
                                    const dateStr = e.all_day
                                        ? new Date(e.start_time).toLocaleDateString()
                                        : `${new Date(e.start_time).toLocaleDateString()} ${new Date(e.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
                                    return (
                                        <button
                                            key={`event-${e.id}`}
                                            className={`${s.item} ${activeIdx === idx ? s.active : ''}`}
                                            onClick={() => navigateToItem({ type: 'event', data: e })}
                                            onMouseEnter={() => setActiveIdx(idx)}
                                        >
                                            <span className={s.itemIcon}>📅</span>
                                            <div className={s.itemBody}>
                                                <span className={s.itemTitle}>{e.title}</span>
                                                <span className={s.snippet}>{dateStr}{e.description ? ` · ${e.description.slice(0, 60)}` : ''}</span>
                                            </div>
                                        </button>
                                    );
                                })}
                            </section>
                        )}

                        {/* ── Leaves ── */}
                        {results?.leaves?.length > 0 && (
                            <section>
                                <h4 className={s.sectionTitle}>Leave Requests</h4>
                                {results.leaves.map((l) => {
                                    const idx = flatIdx++;
                                    return (
                                        <button
                                            key={`leave-${l.id}`}
                                            className={`${s.item} ${activeIdx === idx ? s.active : ''}`}
                                            onClick={() => navigateToItem({ type: 'leave', data: l })}
                                            onMouseEnter={() => setActiveIdx(idx)}
                                        >
                                            <span className={s.itemIcon}>🏖️</span>
                                            <div className={s.itemBody}>
                                                <span className={s.itemTitle}>{l.leave_type.charAt(0).toUpperCase() + l.leave_type.slice(1)} leave — {l.date}</span>
                                                <span className={s.snippet}>{l.duration} day{l.reason ? ` · ${l.reason.slice(0, 60)}` : ''}</span>
                                            </div>
                                            <span className={s.badgeDefault} style={{ color: LEAVE_STATUS_COLOR[l.status] }}>{l.status}</span>
                                        </button>
                                    );
                                })}
                            </section>
                        )}

                        {/* ── Sprints ── */}
                        {results?.sprints?.length > 0 && (
                            <section>
                                <h4 className={s.sectionTitle}>Sprints</h4>
                                {results.sprints.map((sp) => {
                                    const idx = flatIdx++;
                                    return (
                                        <button
                                            key={`sprint-${sp.id}`}
                                            className={`${s.item} ${activeIdx === idx ? s.active : ''}`}
                                            onClick={() => navigateToItem({ type: 'sprint', data: sp })}
                                            onMouseEnter={() => setActiveIdx(idx)}
                                        >
                                            <span className={s.itemIcon}>🚀</span>
                                            <div className={s.itemBody}>
                                                <span className={s.itemTitle}>{sp.name}</span>
                                                <span className={s.snippet}>{sp.start_date} → {sp.end_date}{sp.goal ? ` · ${sp.goal.slice(0, 60)}` : ''}</span>
                                            </div>
                                            <span className={s.badgeDefault} style={{ color: SPRINT_STATUS_COLOR[sp.status] }}>{sp.status}</span>
                                        </button>
                                    );
                                })}
                            </section>
                        )}

                        {/* ── People ── */}
                        {results?.users?.length > 0 && (
                            <section>
                                <h4 className={s.sectionTitle}>People</h4>
                                {results.users.map((u) => {
                                    const idx = flatIdx++;
                                    return (
                                        <button
                                            key={`user-${u.id}`}
                                            className={`${s.item} ${activeIdx === idx ? s.active : ''}`}
                                            onClick={() => navigateToItem({ type: 'user', data: u })}
                                            onMouseEnter={() => setActiveIdx(idx)}
                                        >
                                            {u.avatar
                                                ? <img src={`/uploads/avatars/${u.avatar}`} alt="" className={s.avatar} />
                                                : <span className={s.itemIcon}>👤</span>
                                            }
                                            <div className={s.itemBody}>
                                                <span className={s.itemTitle}>{u.full_name}</span>
                                                <span className={s.snippet}>{u.email}</span>
                                            </div>
                                            <span className={s.badgeDefault}>{ROLE_LABELS[u.role] || u.role}</span>
                                        </button>
                                    );
                                })}
                            </section>
                        )}

                        {/* ── Audit Logs ── */}
                        {results?.logs?.length > 0 && (
                            <section>
                                <h4 className={s.sectionTitle}>Audit Logs</h4>
                                {results.logs.map((l) => {
                                    const idx = flatIdx++;
                                    return (
                                        <button
                                            key={`log-${l.id}`}
                                            className={`${s.item} ${activeIdx === idx ? s.active : ''}`}
                                            onClick={() => navigateToItem({ type: 'log', data: l })}
                                            onMouseEnter={() => setActiveIdx(idx)}
                                        >
                                            <span className={s.itemIcon}>📜</span>
                                            <div className={s.itemBody}>
                                                <span className={s.itemTitle}>{l.action} — {l.entity_type}</span>
                                                <span className={s.snippet}>
                                                    {l.actor_name && `by ${l.actor_name} · `}
                                                    {new Date(l.created_at).toLocaleDateString()}
                                                </span>
                                            </div>
                                        </button>
                                    );
                                })}
                            </section>
                        )}
                    </div>
                )}

                <div className={s.footer}>
                    <span>↑↓ navigate</span>
                    <span>Enter select</span>
                    <span>Esc close</span>
                </div>
            </div>
        </div>
    );
}
