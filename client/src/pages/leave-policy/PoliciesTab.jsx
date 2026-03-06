import React, { useState, useEffect, useCallback } from 'react';
import { getLeavePolicies, deleteLeavePolicyAPI } from '../../api';
import PolicyForm from './PolicyForm';
import s from '../LeavePolicy.module.css';

const emptyPolicy = {
    name: '',
    leave_type: 'annual',
    days_allowed: 12,
    accrual_type: 'annual',
    carry_forward_limit: 0,
    min_service_days: 0,
    requires_approval: 1,
    half_day_allowed: 1,
    quarter_day_allowed: 0,
    description: '',
};

export default function PoliciesTab() {
    const [policies, setPolicies] = useState([]);
    const [editing, setEditing] = useState(null);
    const [showForm, setShowForm] = useState(false);

    const fetch = useCallback(() => {
        getLeavePolicies().then(r => setPolicies(r.data)).catch(e => console.error(e));
    }, []);

    useEffect(() => { fetch(); }, [fetch]);

    const handleDelete = async (id) => {
        if (!confirm('Delete this policy?')) return;
        try { await deleteLeavePolicyAPI(id); fetch(); } catch { }
    };

    return (
        <>
            <button className={`${s.btnPrimary} ${s['mb-1']}`} onClick={() => { setEditing(emptyPolicy); setShowForm(true); }}>
                + Add Policy
            </button>
            <div className={s['card-grid']}>
                {policies.map(p => (
                    <div key={p.id} className={s['card-panel']}>
                        <div className={s['card-header']}>
                            <div>
                                <div className={s['card-title']}>{p.name}</div>
                                <span className={`${s.badgeRole} ${s['badge-type']}`}>{p.leave_type}</span>
                            </div>
                            <div className={s['btn-group']}>
                                <button className={`${s.btnSmall} ${s['btn-accent']}`} onClick={() => { setEditing(p); setShowForm(true); }}>Edit</button>
                                <button className={`${s.btnSmall} ${s['btn-danger']}`} onClick={() => handleDelete(p.id)}>Delete</button>
                            </div>
                        </div>
                        <div className={s['grid-2col']}>
                            <div><span className={s['text-muted']}>Days:</span> <strong>{p.days_allowed}</strong></div>
                            <div><span className={s['text-muted']}>Accrual:</span> <strong>{p.accrual_type}</strong></div>
                            <div><span className={s['text-muted']}>Carry-forward:</span> <strong>{p.carry_forward_limit}</strong></div>
                            <div><span className={s['text-muted']}>Min service:</span> <strong>{p.min_service_days}d</strong></div>
                            <div>{p.half_day_allowed ? '✓ Half-day' : '✗ Half-day'}</div>
                            <div>{p.quarter_day_allowed ? '✓ Quarter-day' : '✗ Quarter-day'}</div>
                        </div>
                        {p.description && <div className={s['description-text']}>{p.description}</div>}
                    </div>
                ))}
                {policies.length === 0 && <div className={s['empty-state']}>No leave policies defined yet.</div>}
            </div>
            {showForm && <PolicyForm initial={editing} onClose={() => setShowForm(false)} onSaved={fetch} />}
        </>
    );
}
