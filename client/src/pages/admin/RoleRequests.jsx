import React, { useState, useEffect, useCallback } from 'react';
import { useAutoDismiss } from '../../hooks/useAutoDismiss';
import { getRoleChangeRequests, approveRoleChange, rejectRoleChange, cancelRoleChange } from '../../api';
import { ROLE_LABELS } from './constants';
import s from '../Admin.module.css';
import sf from './AdminForms.module.css';
import su from './AdminUtils.module.css';

export default function RoleRequests({ userRole }) {
    const [requests, setRequests] = useState([]);
    const [filter, setFilter] = useState('pending');
    const [rejectModal, setRejectModal] = useState(null);
    const [rejectReason, setRejectReason] = useState('');
    const [msg, setMsg] = useAutoDismiss('');

    const fetchRequests = useCallback(() => {
        getRoleChangeRequests({ status: filter || undefined }).then(r => setRequests(r.data || [])).catch(() => {});
    }, [filter]);

    useEffect(() => { fetchRequests(); }, [fetchRequests]);

    const handleApprove = async (id) => {
        try {
            const r = await approveRoleChange(id);
            setMsg(r.data.message);
            fetchRequests();
        } catch (e) { setMsg(e.response?.data?.error || 'Failed'); }
    };

    const handleReject = async () => {
        if (!rejectModal) return;
        try {
            const r = await rejectRoleChange(rejectModal, rejectReason);
            setMsg(r.data.message);
            setRejectModal(null);
            setRejectReason('');
            fetchRequests();
        } catch (e) { setMsg(e.response?.data?.error || 'Failed'); }
    };

    const handleCancel = async (id) => {
        try {
            const r = await cancelRoleChange(id);
            setMsg(r.data.message);
            fetchRequests();
        } catch (e) { setMsg(e.response?.data?.error || 'Failed'); }
    };

    const renderApprovalChain = (approvals) => {
        if (!approvals || typeof approvals !== 'object') return null;
        return Object.entries(approvals).map(([role, info]) => (
            <span key={role} style={{
                display: 'inline-block',
                padding: '0.15rem 0.4rem',
                borderRadius: '3px',
                fontSize: '0.75rem',
                marginRight: '0.25rem',
                background: info.status === 'approved' ? 'var(--bg-success, #d1fae5)' : 'var(--bg-warning, #fef3c7)',
                color: info.status === 'approved' ? 'var(--success, #059669)' : 'var(--warning, #d97706)',
            }}>
                {ROLE_LABELS[role] || role}: {info.status === 'approved' ? '✓' : '⏳'}
            </span>
        ));
    };

    return (
        <>
            {msg && <div className={s.success}>{msg}</div>}
            <div className={s.toolbar}>
                <select value={filter} onChange={e => setFilter(e.target.value)}>
                    <option value="pending">Pending</option>
                    <option value="approved">Approved</option>
                    <option value="rejected">Rejected</option>
                    <option value="cancelled">Cancelled</option>
                    <option value="">All</option>
                </select>
            </div>

            <table className={s.table}>
                <thead>
                    <tr>
                        <th>User</th>
                        <th>Current Role</th>
                        <th>Requested Role</th>
                        <th>Requested By</th>
                        <th>Approval Chain</th>
                        <th>Status</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    {requests.map(r => (
                        <tr key={r.id}>
                            <td>
                                <div className={su['font-bold']}>{r.target_name}</div>
                                <div className={s['text-muted-xs']}>@{r.target_username}</div>
                            </td>
                            <td>{ROLE_LABELS[r.current_role] || r.current_role}</td>
                            <td>{ROLE_LABELS[r.requested_role] || r.requested_role}</td>
                            <td>{r.requester_name}</td>
                            <td>{renderApprovalChain(r.approvals)}</td>
                            <td>
                                {r.status === 'pending' && <span className={s.badgeActive} style={{ background: 'var(--bg-warning, #fef3c7)', color: 'var(--warning, #d97706)' }}>Pending</span>}
                                {r.status === 'approved' && <span className={s.badgeActive}>Approved</span>}
                                {r.status === 'rejected' && <span className={s.badgeInactive}>Rejected</span>}
                                {r.status === 'cancelled' && <span className={s.badgeInactive}>Cancelled</span>}
                            </td>
                            <td>
                                {r.status === 'pending' && (
                                    <div className={s.actions}>
                                        {r.approvals?.[userRole]?.status === 'pending' && (
                                            <button className={`${s.btnSmall} ${s.btnSuccess}`} onClick={() => handleApprove(r.id)}>✓ Approve</button>
                                        )}
                                        {(r.approvals?.[userRole] || userRole === 'super_admin') && (
                                            <button className={`${s.btnSmall} ${s.btnDanger}`} onClick={() => setRejectModal(r.id)}>✗ Reject</button>
                                        )}
                                        <button className={`${s.btnSmall} ${s.btnAccent}`} onClick={() => handleCancel(r.id)}>Cancel</button>
                                    </div>
                                )}
                                {r.status === 'rejected' && r.reject_reason && (
                                    <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>Reason: {r.reject_reason}</span>
                                )}
                            </td>
                        </tr>
                    ))}
                    {requests.length === 0 && <tr><td colSpan={7} className={s.emptyRow}>No role change requests found</td></tr>}
                </tbody>
            </table>

            {rejectModal && (
                <div className={sf.modalOverlay} onClick={() => setRejectModal(null)}>
                    <div className={sf.modal} onClick={e => e.stopPropagation()}>
                        <h2>Reject Role Change</h2>
                        <div className={sf.formGroup}>
                            <label>Reason (optional)</label>
                            <input value={rejectReason} onChange={e => setRejectReason(e.target.value)} placeholder="Reason for rejection..." />
                        </div>
                        <div className={sf.formActions}>
                            <button className={sf.btnCancel} onClick={() => { setRejectModal(null); setRejectReason(''); }}>Cancel</button>
                            <button className={`${s.btnPrimary} ${s.btnDanger}`} onClick={handleReject}>Reject</button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
