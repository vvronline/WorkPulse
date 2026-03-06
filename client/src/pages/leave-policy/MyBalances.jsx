import React, { useState, useEffect } from 'react';
import { getLeaveBalances } from '../../api';
import s from '../LeavePolicy.module.css';

export default function MyBalances() {
    const [balances, setBalances] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        getLeaveBalances()
            .then(r => { setBalances(r.data); setLoading(false); })
            .catch(() => setLoading(false));
    }, []);

    if (loading) return <p>Loading...</p>;

    return (
        <div className={s['grid-balances']}>
            {balances.map(b => {
                const used = b.used || 0;
                const pct = b.total_days > 0 ? Math.round((used / b.total_days) * 100) : 0;
                return (
                    <div key={b.id} className={s['card-panel']}>
                        <div className={s['card-title-sm']}>{b.policy_name}</div>
                        <span className={`${s.badgeRole} ${s['badge-small']}`}>{b.leave_type}</span>
                        <div className={s['progress-section']}>
                            <div className={s['flex-between-sm']}>
                                <span>Used: {used}</span>
                                <span>Balance: {b.balance}</span>
                            </div>
                            <div className={s['progress-track']}>
                                <div className={s['progress-fill']} style={{ width: `${Math.min(pct, 100)}%`, background: pct >= 80 ? 'var(--danger)' : pct >= 50 ? 'var(--warning)' : 'var(--success)' }} />
                            </div>
                            <div className={s['flex-between-muted']}>
                                <span>Total: {b.total_days}</span>
                                <span>Carried: {b.carried_forward}</span>
                            </div>
                        </div>
                        <div className={s['text-muted-sm']}>Year: {b.year}</div>
                    </div>
                );
            })}
            {balances.length === 0 && <div className={s['empty-state']}>No leave balances found. Contact HR to set up leave policies.</div>}
        </div>
    );
}
