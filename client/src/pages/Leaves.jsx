import React, { useState, useEffect, useCallback } from 'react';
import { getLeaves, withdrawLeave, getLeaveBalances, exportMyLeaves } from '../api';
import ConfirmDialog from '../components/common/ConfirmDialog';
import ExportButton from '../components/common/ExportButton';
import { useToast } from '../components/common/Toast';
import LeaveBalanceCards from './leaves/LeaveBalanceCards';
import LeaveRequestForm from './leaves/LeaveRequestForm';
import LeaveHistory from './leaves/LeaveHistory';
import { fmtDate } from '../utils/date';
import s from './Leaves.module.css';


export default function Leaves() {
  const toast = useToast();
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
  }, [filterMonth]);

  useEffect(() => { fetchData(); }, [fetchData]);

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
          <p className={s.subtitle}>Request time off, track approvals, and view your leave history</p>
        </div>
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
      </div>

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
