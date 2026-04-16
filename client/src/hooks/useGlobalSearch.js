import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { globalSearch } from '../api';
import { ROLE_LEVEL } from '../constants';
import {
    Home, Calendar, CheckSquare, FileText, MessageSquare, Palmtree,
    BarChart3, FileEdit, Building2, ClipboardList, Wallet, Rocket,
    Users, Settings, User, UserPlus, Download, ScrollText, RefreshCw, Building,
} from 'lucide-react';

// Static navigation index — defines all pages/features visible through the command palette.
// minRole: the minimum role level required to see the item.
const NAV_INDEX = [
    { icon: Home, title: 'Dashboard', sub: 'Home overview & time tracker', path: '/', keywords: 'home overview clock tracker' },
    { icon: Calendar, title: 'Calendar', sub: 'Events, reminders & schedules', path: '/calendar', keywords: 'events reminders schedule' },
    { icon: CheckSquare, title: 'Tasks', sub: 'My tasks & assignments', path: '/tasks', keywords: 'todo assignments work tickets' },
    { icon: FileText, title: 'Notes', sub: 'Personal notebook', path: '/notes', keywords: 'notebook journal writing pages' },
    { icon: MessageSquare, title: 'Chat', sub: 'Team messaging', path: '/chat', keywords: 'messages messaging team direct' },
    { icon: Palmtree, title: 'Leaves', sub: 'Leave requests & history', path: '/leaves', keywords: 'vacation time off absence sick holiday request' },
    { icon: BarChart3, title: 'Analytics', sub: 'Work hours & productivity stats', path: '/analytics', keywords: 'reports hours productivity stats charts' },
    { icon: FileEdit, title: 'Manual Entry', sub: 'Log work hours manually', path: '/manual-entry', keywords: 'clock time log entry hours manual' },
    { icon: Building2, title: 'Organization', sub: 'Org profile & settings', path: '/organization', keywords: 'company settings profile org details', excludeRole: 'platform_admin' },
    { icon: ClipboardList, title: 'Leave Policy', sub: 'Leave balances & public holidays', path: '/leave-policy', keywords: 'balance quota leave entitlement policy' },
    { icon: Wallet, title: 'Leave Balances', sub: 'My leave balances & quotas', path: '/leave-policy?tab=balances', keywords: 'quota remaining sick planned balance' },
    { icon: Palmtree, title: 'Holidays', sub: 'Company public holidays', path: '/leave-policy?tab=holidays', keywords: 'public holiday national bank calendar' },
    { icon: Users, title: 'Manager Dashboard', sub: 'Team approvals & reports', path: '/manager', keywords: 'approve team overtime manual reports pending', minRole: 'team_lead' },
    { icon: Settings, title: 'Admin Panel', sub: 'User & org management', path: '/admin', keywords: 'admin manage settings panel', minRole: 'hr_admin' },
    { icon: User, title: 'User Management', sub: 'View & edit user accounts', path: '/admin?tab=users', keywords: 'users employees accounts manage', minRole: 'hr_admin' },
    { icon: UserPlus, title: 'Create User', sub: 'Add a new user account', path: '/admin?tab=create', keywords: 'new user create add register', minRole: 'hr_admin' },
    { icon: Download, title: 'Import Users', sub: 'Bulk import from CSV / JSON', path: '/admin?tab=import', keywords: 'bulk import csv json users batch', minRole: 'hr_admin' },
    { icon: ScrollText, title: 'Audit Logs', sub: 'System activity history', path: '/admin?tab=audit', keywords: 'logs history activity events actions audit', minRole: 'hr_admin' },
    { icon: RefreshCw, title: 'Role Requests', sub: 'Pending role change requests', path: '/admin?tab=role-requests', keywords: 'role promotion request pending', minRole: 'hr_admin' },
    { icon: Wallet, title: 'Payroll', sub: 'Pay periods & payroll export', path: '/admin?tab=payroll', keywords: 'pay salary export hours period payroll', minRole: 'hr_admin' },
    { icon: Building, title: 'Org Structure', sub: 'Departments, teams & org chart', path: '/admin?tab=structure', keywords: 'departments teams structure chart', minRole: 'super_admin' },
    { icon: Building, title: 'Tenant Management', sub: 'Manage tenants, organizations & databases', path: '/admin?tab=tenants', keywords: 'org tenant company organizations database', minRole: 'platform_admin' },
    { icon: ClipboardList, title: 'Leave Policies', sub: 'Configure leave quotas & accrual', path: '/leave-policy?tab=policies', keywords: 'policy accrual quota configure sick', minRole: 'hr_admin' },
    { icon: Users, title: 'All Leave Balances', sub: "View all employees' leave balances", path: '/leave-policy?tab=allBalances', keywords: 'all balances employees leave', minRole: 'hr_admin' },
];

/**
 * Encapsulates all search state, debouncing, abort-controller logic, keyboard
 * navigation, and navigation actions for the GlobalSearch component.
 */
export function useGlobalSearch({ onClose }) {
    const { user } = useAuth();
    const navigate = useNavigate();

    const [query, setQuery] = useState('');
    const [results, setResults] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [activeIdx, setActiveIdx] = useState(-1);

    const inputRef = useRef(null);
    const debounceRef = useRef(null);
    const abortCtrlRef = useRef(null);

    const userLevel = ROLE_LEVEL[user?.role] ?? 1;

    // Navigation items the current user is permitted to see
    const visibleNav = useMemo(() =>
        NAV_INDEX.filter(n =>
            (!n.minRole || userLevel >= (ROLE_LEVEL[n.minRole] ?? 1)) &&
            (!n.excludeRole || n.excludeRole !== user?.role)
        ),
        [userLevel, user?.role]
    );

    // Client-side nav filter against the current query
    const navResults = useMemo(() => {
        if (!query || query.trim().length < 2) return [];
        const lower = query.trim().toLowerCase();
        return visibleNav.filter(n =>
            n.title.toLowerCase().includes(lower) ||
            n.sub.toLowerCase().includes(lower) ||
            n.keywords.toLowerCase().includes(lower)
        ).slice(0, 6);
    }, [query, visibleNav]);

    // Flat ordered list used for keyboard navigation (arrow keys + Enter)
    const flatItems = useMemo(() => [
        ...navResults.map(n => ({ type: 'nav', data: n })),
        ...(results?.tasks || []).map(t => ({ type: 'task', data: t })),
        ...(results?.notes || []).map(n => ({ type: 'note', data: n })),
        ...(results?.events || []).map(e => ({ type: 'event', data: e })),
        ...(results?.leaves || []).map(l => ({ type: 'leave', data: l })),
        ...(results?.sprints || []).map(sp => ({ type: 'sprint', data: sp })),
        ...(results?.users || []).map(u => ({ type: 'user', data: u })),
        ...(results?.logs || []).map(l => ({ type: 'log', data: l })),
    ], [navResults, results]);

    // Pre-computed starting index for each result section — eliminates the mutable
    // flatIdx counter pattern in render, making section rendering purely declarative.
    const sectionOffsets = useMemo(() => ({
        nav: 0,
        task: navResults.length,
        note: navResults.length + (results?.tasks?.length || 0),
        event: navResults.length + (results?.tasks?.length || 0) + (results?.notes?.length || 0),
        leave: navResults.length + (results?.tasks?.length || 0) + (results?.notes?.length || 0) + (results?.events?.length || 0),
        sprint: navResults.length + (results?.tasks?.length || 0) + (results?.notes?.length || 0) + (results?.events?.length || 0) + (results?.leaves?.length || 0),
        user: navResults.length + (results?.tasks?.length || 0) + (results?.notes?.length || 0) + (results?.events?.length || 0) + (results?.leaves?.length || 0) + (results?.sprints?.length || 0),
        log: navResults.length + (results?.tasks?.length || 0) + (results?.notes?.length || 0) + (results?.events?.length || 0) + (results?.leaves?.length || 0) + (results?.sprints?.length || 0) + (results?.users?.length || 0),
    }), [navResults.length, results]);

    // Focus input on mount
    useEffect(() => { inputRef.current?.focus(); }, []);

    // Close on Escape
    useEffect(() => {
        const handle = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', handle);
        return () => window.removeEventListener('keydown', handle);
    }, [onClose]);

    // Cancel pending requests and debounce timers on unmount
    useEffect(() => () => {
        clearTimeout(debounceRef.current);
        abortCtrlRef.current?.abort();
    }, []);

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

    const handleChange = useCallback((e) => {
        const val = e.target.value;
        setQuery(val);
        clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => doSearch(val), 350);
    }, [doSearch]);

    const navigateToItem = useCallback(({ type, data }) => {
        onClose();
        switch (type) {
            case 'nav': navigate(data.path); break;
            case 'task': navigate(`/tasks?taskId=${data.id}`); break;
            case 'note': navigate(`/notes?pageId=${data.id}`); break;
            case 'event': navigate('/calendar'); break;
            case 'leave': navigate('/leaves'); break;
            case 'sprint': navigate('/manager'); break;
            case 'user': navigate(`/admin?tab=users&userId=${data.id}`); break;
            case 'log': navigate('/admin?tab=audit'); break;
        }
    }, [navigate, onClose]);

    const handleKeyDown = useCallback((e) => {
        if (!flatItems.length) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveIdx(i => Math.min(i + 1, flatItems.length - 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIdx(i => Math.max(i - 1, 0));
        } else if (e.key === 'Enter' && activeIdx >= 0) {
            e.preventDefault();
            if (flatItems[activeIdx]) navigateToItem(flatItems[activeIdx]);
        }
    }, [flatItems, activeIdx, navigateToItem]);

    const hasResults = navResults.length > 0 || (results && (
        results.tasks?.length || results.notes?.length || results.events?.length ||
        results.leaves?.length || results.sprints?.length ||
        results.users?.length || results.logs?.length
    ));

    return {
        query,
        results,
        loading,
        error,
        activeIdx,
        setActiveIdx,
        inputRef,
        navResults,
        sectionOffsets,
        handleChange,
        handleKeyDown,
        navigateToItem,
        hasResults,
    };
}
