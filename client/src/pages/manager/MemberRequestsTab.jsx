import React, { useState, useEffect } from 'react';
import { getMemberRequests } from '../../api';
import ApprovalBadge from './ApprovalBadge';
import RequestDetails from './RequestDetails';
import s from '../Admin.module.css';
import m from '../ManagerDashboard.module.css';

export default function MemberRequestsTab({ userId }) {
    const [requests, setRequests] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        getMemberRequests(userId)
            .then(r => { setRequests(r.data); setLoading(false); })
            .catch(() => setLoading(false));
    }, [userId]);

    if (loading) return <p>Loading...</p>;

    return (
        <>
            <h3 className={m['section-heading-mb']}>Approval Requests</h3>
            <table className={s.table}>
                <thead><tr><th>Type</th><th>Details</th><th>Status</th><th>Submitted</th><th>Reviewed By</th></tr></thead>
                <tbody>
                    {requests.map(r => (
                        <tr key={r.id}>
                            <td><span className={s.badgeRole}>{r.type?.replace('_', ' ')}</span></td>
                            <td className={m['cell-details']}><RequestDetails request={r} /></td>
                            <td><ApprovalBadge status={r.status} /></td>
                            <td className={m['cell-sm']}>{new Date(r.created_at + 'Z').toLocaleDateString()}</td>
                            <td>{r.approver_name || '—'}</td>
                        </tr>
                    ))}
                    {requests.length === 0 && <tr><td colSpan={5} className={m['empty-cell']}>No requests found</td></tr>}
                </tbody>
            </table>
        </>
    );
}
