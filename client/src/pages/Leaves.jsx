import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
    BarChart3, ClipboardList, Users, Send,
} from 'lucide-react';
import { useAuth } from '../AuthContext';
import { getLeaves, withdrawLeave, getLeaveBalances, exportMyLeaves } from '../api';
import ConfirmDialog from '../components/common/ConfirmDialog';
import ExportButton from '../components/common/ExportButton';
import { useToast } from '../components/common/Toast';
import LeaveBalanceCards from './leaves/LeaveBalanceCards';
import LeaveRequestForm from './leaves/LeaveRequestForm';
import LeaveHistory from './leaves/LeaveHistory';
import MyBalances from './leave-policy/MyBalances';
import PoliciesTab from './leave-policy/PoliciesTab';
import AllBalances from './leave-policy/AllBalances';
import { fmtDate } from '../utils/date';
import s from './Leaves.module.css';

/**
 * Top-level Leaves page (rendered inside the Attendance > Leaves tab).
 * Hosts an inner tab bar that consolidates the leave-management UIs:
 * personal leave requests, balances, policies, and all-employee balances.
 * Employees always raise their own leave requests — there is no admin
 * shortcut to add leaves on someone's behalf.
 *
 * Public holidays are managed inside the Policies tab (under the Holiday
 * policy card) rather than via a dedicated Holidays sub-tab — that keeps
 * holiday config co-located with the policy that governs it.
 */
const SUB_TABS = [
    { id: 'request',     label: 'My Leaves',    icon: Send,           hr: false },
    { id: 'balances',    label: 'My Balances',  icon: BarChart3,      hr: false },
    { id: 'policies',    label: 'Policies',     icon: ClipboardList,  hr: true  },
    { id: 'allBalances', label: 'All Balances', icon: Users,          hr: true  },
];

export default function Leaves() {
    const toast = useToast();
    const { user } = useAuth();
    /* Anyone at HR level or higher (hr_admin, super_admin, platform_admin) sees
       the admin-only sub-tabs (Add Leave / Policies / All Balances). */
    const isHR = ['hr_admin', 'super_admin', 'platform_admin'].includes(user?.role);

    const visibleTabs = useMemo(() => SUB_TABS.filter(t => !t.hr || isHR), [isHR]);
    const [tab, setTab] = useState('request');

    /* ── Request-tab state (existing behaviour) ──────────────────────────── */
    const [leaves, setLeaves] = useState([]);
    const [loading, setLoading] = useState(true);
    const [balances, setBalances] = useState([]);
    const [leaveToDelete, setLeaveToDelete] = useState(null);
    const [filterMonth, setFilterMonth] = useState(() => {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    });

    const fetchData = useCallback(async () => {
        try {
            setLoading(true);
            const [y, m] = filterMonth.split('-');
            const from = `${filterMonth}-01`;
            const lastDay = new Date(parseInt(y), parseInt(m), 0).getDate();
            const to = `${filterMonth}-${lastDay}`;
            const [leavesRes, balancesRes] = await Promise.all([
                getLeaves(from, to),
                getLeaveBalances(parseInt(y)).catch(() => ({ data: [] })),
            ]);
            setLeaves(leavesRes.data);
            setBalances(balancesRes.data || []);
        } catch {
            toast.error('Failed to load leave data');
        } finally {
            setLoading(false);
        }
    }, [filterMonth]); // eslint-disable-line react-hooks/exhaustive-deps

    /* Only refetch the request-tab data when the user is actually on that tab,
       to avoid wasted API calls when the user is on Holidays / Policies / etc. */
    useEffect(() => {
        if (tab === 'request') fetchData();
    }, [fetchData, tab]);

    const confirmWithdraw = async () => {
        if (!leaveToDelete) return;
        try {
            const res = await withdrawLeave(leaveToDelete.id);
            setLeaveToDelete(null);
            toast.success(res.data?.message || 'Withdrawal request submitted');
            fetchData();
        } catch (err) {
            setLeaveToDelete(null);
            toast.error(err.response?.data?.error || 'Failed to withdraw leave');
        }
    };

    return (
        <div className={s.page}>
            {/* Header */}
            <div className={s.header}>
                <div>
                    <h1 className={s.title}>Leave Management</h1>
                    <p className={s.subtitle}>Request time off, configure policies, manage balances and public holidays</p>
                </div>
                {tab === 'request' && (
                    <div className={s.headerRight}>
                        <ExportButton
                            fetchFn={exportMyLeaves}
                            params={{ year: filterMonth.split('-')[0] }}
                            label="Export Leaves"
                        />
                        <input
                            type="month"
                            value={filterMonth}
                            onChange={(e) => setFilterMonth(e.target.value)}
                            className={s.monthPicker}
                        />
                    </div>
                )}
            </div>

            {/* Sub-tabs */}
            <div className={s.subTabs} role="tablist">
                {visibleTabs.map(t => {
                    const Icon = t.icon;
                    const active = tab === t.id;
                    return (
                        <button
                            key={t.id}
                            role="tab"
                            aria-selected={active}
                            className={`${s.subTab} ${active ? s.subTabActive : ''}`}
                            onClick={() => setTab(t.id)}
                        >
                            <Icon size={14} /> <span>{t.label}</span>
                        </button>
                    );
                })}
            </div>

            {/* Tab content */}
            {tab === 'request' && (
                <>
                    <LeaveBalanceCards balances={balances} />
                    <div className={s.layout}>
                        <aside className={s.sidebar}>
                            <LeaveRequestForm onSuccess={fetchData} />
                        </aside>
                        <main className={s.main}>
                            <LeaveHistory
                                leaves={leaves}
                                loading={loading}
                                onWithdraw={setLeaveToDelete}
                            />
                        </main>
                    </div>
                </>
            )}

            {tab === 'balances'    && <MyBalances />}
            {tab === 'policies'    && isHR && <PoliciesTab />}
            {tab === 'allBalances' && isHR && <AllBalances />}

            <ConfirmDialog
                isOpen={!!leaveToDelete}
                title="Withdraw Leave Request"
                message={`Withdraw your ${leaveToDelete?.leave_type || ''} leave for ${leaveToDelete ? fmtDate(leaveToDelete.date) : ''}?${leaveToDelete?.status === 'approved' ? ' This requires manager approval.' : ''}`}
                confirmText="Withdraw"
                onConfirm={confirmWithdraw}
                onCancel={() => setLeaveToDelete(null)}
            />
        </div>
    );
}