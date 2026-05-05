import React, { Suspense, lazy, useState, useMemo, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { CalendarDays, Palmtree, FileEdit, BarChart3 } from 'lucide-react';
import AttendanceCalendar from './attendance/AttendanceCalendar';
import PageSkeleton from '../components/common/PageSkeleton';
import s from './Attendance.module.css';

/* Lazy-load child tabs so they only load when first opened */
const Leaves = lazy(() => import('./Leaves'));
const ManualEntry = lazy(() => import('./ManualEntry'));
const Analytics = lazy(() => import('./analytics'));

const TABS = [
    { id: 'overview', label: 'Overview', icon: CalendarDays, hash: '' },
    { id: 'leaves', label: 'Leaves', icon: Palmtree, hash: '#leaves' },
    { id: 'manual', label: 'Manual Entry', icon: FileEdit, hash: '#manual-entry' },
    { id: 'analytics', label: 'Analytics', icon: BarChart3, hash: '#analytics' },
];

export default function Attendance() {
    const location = useLocation();
    const navigate = useNavigate();

    /* Determine active tab from URL hash; defaults to overview */
    const initialTab = useMemo(() => {
        const h = (location.hash || '').replace('#', '');
        const found = TABS.find(t => t.hash.replace('#', '') === h);
        return found ? found.id : 'overview';
    }, [location.hash]);

    const [active, setActive] = useState(initialTab);
    /* Track which tabs have ever been mounted, so we keep them alive across switches */
    const [mounted, setMounted] = useState(() => new Set([initialTab]));
    /* Bump key to refresh calendar when user returns to overview after submitting changes */
    const [calRefresh, setCalRefresh] = useState(0);

    useEffect(() => {
        setActive(initialTab);
        setMounted(prev => prev.has(initialTab) ? prev : new Set(prev).add(initialTab));
    }, [initialTab]);

    const switchTab = (id) => {
        const tab = TABS.find(t => t.id === id);
        if (!tab) return;
        setActive(id);
        setMounted(prev => prev.has(id) ? prev : new Set(prev).add(id));
        // Update URL hash without remounting parent
        navigate({ pathname: '/attendance', hash: tab.hash }, { replace: false });
        // When returning to overview, refresh the calendar
        if (id === 'overview') setCalRefresh(k => k + 1);
    };

    return (
        <div className={s.page}>
            <header className={s.header}>
                <div>
                    <h1 className={s.title}>Attendance</h1>
                    <p className={s.subtitle}>Track your daily attendance, leaves, manual entries and analytics in one place</p>
                </div>
            </header>

            {/* Tabs */}
            <nav className={s.tabs} role="tablist" aria-label="Attendance sections">
                {TABS.map(t => {
                    const Icon = t.icon;
                    const isActive = active === t.id;
                    return (
                        <button
                            key={t.id}
                            role="tab"
                            aria-selected={isActive}
                            className={`${s.tab} ${isActive ? s.tabActive : ''}`}
                            onClick={() => switchTab(t.id)}
                        >
                            <Icon size={16} />
                            <span>{t.label}</span>
                        </button>
                    );
                })}
            </nav>

            {/* Tab content (keep-alive: render mounted tabs, hide inactive ones) */}
            <div className={s.body}>
                {mounted.has('overview') && (
                    <div style={{ display: active === 'overview' ? 'block' : 'none' }}>
                        <AttendanceCalendar refreshKey={calRefresh} />
                    </div>
                )}
                {mounted.has('leaves') && (
                    <div style={{ display: active === 'leaves' ? 'block' : 'none' }}>
                        <Suspense fallback={<PageSkeleton />}>
                            <Leaves />
                        </Suspense>
                    </div>
                )}
                {mounted.has('manual') && (
                    <div style={{ display: active === 'manual' ? 'block' : 'none' }}>
                        <Suspense fallback={<PageSkeleton />}>
                            <ManualEntry isActive={active === 'manual'} onEntryChanged={() => setCalRefresh(k => k + 1)} />
                        </Suspense>
                    </div>
                )}
                {mounted.has('analytics') && (
                    <div style={{ display: active === 'analytics' ? 'block' : 'none' }}>
                        <Suspense fallback={<PageSkeleton />}>
                            <Analytics />
                        </Suspense>
                    </div>
                )}
            </div>
        </div>
    );
}