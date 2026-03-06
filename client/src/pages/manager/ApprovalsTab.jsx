import React, { useState, useEffect, useCallback } from 'react';
import { getApprovals, approveRequest, rejectRequest, bulkApproval } from '../../api';
import ApprovalBadge from './ApprovalBadge';
import RequestDetails from './RequestDetails';
import s from '../Admin.module.css';
import sf from '../admin/AdminForms.module.css';
import m from '../ManagerDashboard.module.css';

export default function ApprovalsTab() {
    const [approvals, setApprovals] = useState([]);
    const [filter, setFilter] = useState('pending');
    const [selected, setSelected] = useState(new Set());
    const [rejectId, setRejectId] = useState(null);
    const [rejectReason, setRejectReason] = useState('');
    const [loading, setLoading] = useState(true);
    const [processing, setProcessing] = useState(null);

    const fetchApprovals = useCallback(() => {
        setLoading(true);
        getApprovals({ status: filter || undefined })
            .then(r => { setApprovals(r.data); setLoading(false); setSelected(new Set()); })
            .catch(() => setLoading(false));
    }, [filter]);

    useEffect(() => { fetchApprovals(); }, [fetchApprovals]);

    const handleApprove = async (id) => {
        if (processing) return;
        setProcessing(id);
        try { await approveRequest(id); fetchApprovals(); } catch { } finally { setProcessing(null); }
    };

    const handleReject = async () => {
        if (!rejectId || processing) return;
        setProcessing(rejectId);
        try {
            await rejectRequest(rejectId, rejectReason);
            setRejectId(null);
            setRejectReason('');
            fetchApprovals();
        } catch { } finally { setProcessing(null); }
    };

    const handleBulk = async (action) => {
        if (selected.size === 0 || processing) return;
        setProcessing('bulk');
        try { await bulkApproval(Array.from(selected), action); fetchApprovals(); } catch { } finally { setProcessing(null); }
    };

    const toggleSelect = (id) => {
        const next = new Set(selected);
        next.has(id) ? next.delete(id) : next.add(id);
        setSelected(next);
    };

    const toggleAll = () => {
        if (selected.size === approvals.length) setSelected(new Set());
        else setSelected(new Set(approvals.map(a => a.id)));
    };

    return (
        <>
            <div className={s.toolbar}>
                <select value={filter} onChange={e => setFilter(e.target.value)} className={m['inline-input']}>
                    <option value="pending">Pending</option>
                    <option value="approved">Approved</option>
                    <option value="rejected">Rejected</option>
                    <option value="">All</option>
                </select>
                {filter === 'pending' && selected.size > 0 && (
                    <div className={m['btn-row']}>
                        <button className={s.btnPrimary} onClick={() => handleBulk('approve')} disabled={!!processing}>Approve ({selected.size})</button>
                        <button className={s.btnDanger} onClick={() => handleBulk('reject')} disabled={!!processing}>Reject ({selected.size})</button>
                    </div>
                )}
            </div>

            {loading ? <p>Loading...</p> : (
                <table className={s.table}>
                    <thead>
                        <tr>
                            {filter === 'pending' && <th><input type="checkbox" checked={selected.size === approvals.length && approvals.length > 0} onChange={toggleAll} /></th>}
                            <th>Type</th>
                            <th>Requester</th>
                            <th>Details</th>
                            <th>Date</th>
                            <th>Status</th>
                            {filter === 'pending' && <th>Actions</th>}
                        </tr>
                    </thead>
                    <tbody>
                        {approvals.map(a => (
                            <tr key={a.id}>
                                {filter === 'pending' && <td><input type="checkbox" checked={selected.has(a.id)} onChange={() => toggleSelect(a.id)} /></td>}
                                <td><span className={s.badgeRole}>{a.type?.replace('_', ' ')}</span></td>
                                <td>
                                    <div className={s.userCell}>
                                        {a.requester_avatar ? <img src={a.requester_avatar} className={m['avatar-sm-round']} alt="" /> : <span className={s.initials}>{a.requester_name?.charAt(0)}</span>}
                                        <div><div className={s.userName}>{a.requester_name}</div></div>
                                    </div>
                                </td>
                                <td className={m['cell-details']}><RequestDetails request={a} /></td>
                                <td className={m['cell-sm']}>{new Date(a.created_at + 'Z').toLocaleDateString()}</td>
                                <td><ApprovalBadge status={a.status} /></td>
                                {filter === 'pending' && (
                                    <td>
                                        <div className={s.actions}>
                                            <button className={`${s.btnSmall} ${s.btnSuccess}`} onClick={() => handleApprove(a.id)} disabled={!!processing}>{processing === a.id ? '…' : '✓'}</button>
                                            <button className={`${s.btnSmall} ${s.btnDanger}`} onClick={() => setRejectId(a.id)} disabled={!!processing}>✗</button>
                                        </div>
                                    </td>
                                )}
                            </tr>
                        ))}
                        {approvals.length === 0 && <tr><td colSpan={7} className={m['empty-cell']}>No {filter || ''} requests</td></tr>}
                    </tbody>
                </table>
            )}

            {rejectId && (
                <div className={sf.modalOverlay} onClick={() => setRejectId(null)}>
                    <div className={sf.modal} onClick={e => e.stopPropagation()}>
                        <h3>Reject Request</h3>
                        <div className={sf.formGroup}>
                            <label>Reason (optional)</label>
                            <textarea value={rejectReason} onChange={e => setRejectReason(e.target.value)} rows={3} className={m['textarea-input']} placeholder="Provide a reason..." />
                        </div>
                        <div className={sf.formActions}>
                            <button className={sf.btnCancel} onClick={() => setRejectId(null)} disabled={!!processing}>Cancel</button>
                            <button className={s.btnDanger} onClick={handleReject} disabled={!!processing}>{processing ? 'Rejecting…' : 'Reject'}</button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
