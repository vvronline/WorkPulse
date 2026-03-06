import React, { useState, useEffect } from 'react';
import { getLeaveBalances, updateLeaveBalance } from '../../api';
import s from '../LeavePolicy.module.css';

export default function AllBalances() {
    const [balances, setBalances] = useState([]);
    const [search, setSearch] = useState('');
    const [editItem, setEditItem] = useState(null);
    const [loading, setLoading] = useState(true);

    const loadBalances = () => {
        getLeaveBalances('all')
            .then(r => { setBalances(r.data); setLoading(false); })
            .catch(() => setLoading(false));
    };

    useEffect(() => { loadBalances(); }, []);

    const handleUpdate = async () => {
        if (!editItem) return;
        try {
            await updateLeaveBalance(editItem.user_id, {
                policy_id: editItem.policy_id,
                year: editItem.year,
                total_days: editItem.total_days,
                used: editItem.used,
                carried_forward: editItem.carried_forward,
            });
            loadBalances();
            setEditItem(null);
        } catch { }
    };

    const filtered = balances.filter(b => !search || b.full_name?.toLowerCase().includes(search.toLowerCase()));

    if (loading) return <p>Loading...</p>;

    return (
        <>
            <div className={s.toolbar}>
                <input placeholder="Search by name..." value={search} onChange={e => setSearch(e.target.value)} className={s.searchInput} />
            </div>
            <table className={s.table}>
                <thead>
                    <tr>
                        <th>Employee</th>
                        <th>Policy</th>
                        <th>Total</th>
                        <th>Used</th>
                        <th>Balance</th>
                        <th>Year</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>
                    {filtered.map((b, i) => (
                        <tr key={i}>
                            <td>{b.full_name}</td>
                            <td>{b.policy_name}</td>
                            <td>{b.total_days}</td>
                            <td>{b.used}</td>
                            <td className={s['font-bold']}>{b.balance}</td>
                            <td>{b.year}</td>
                            <td>
                                <button className={`${s.btnSmall} ${s['btn-accent']}`} onClick={() => setEditItem({ ...b })}>Edit</button>
                            </td>
                        </tr>
                    ))}
                    {filtered.length === 0 && <tr><td colSpan={7} className={s['empty-cell']}>No balances found</td></tr>}
                </tbody>
            </table>

            {editItem && (
                <div className={s.modalOverlay} onClick={() => setEditItem(null)}>
                    <div className={s.modal} onClick={e => e.stopPropagation()}>
                        <h3>Edit Balance: {editItem.full_name}</h3>
                        <div className={s.formGroup}>
                            <label>Total Days</label>
                            <input type="number" value={editItem.total_days} onChange={e => setEditItem({ ...editItem, total_days: +e.target.value })} />
                        </div>
                        <div className={s.formGroup}>
                            <label>Used</label>
                            <input type="number" value={editItem.used} onChange={e => setEditItem({ ...editItem, used: +e.target.value })} />
                        </div>
                        <div className={s.formGroup}>
                            <label>Carried Forward</label>
                            <input type="number" value={editItem.carried_forward} onChange={e => setEditItem({ ...editItem, carried_forward: +e.target.value })} />
                        </div>
                        <div className={s.formActions}>
                            <button className={s.btnCancel} onClick={() => setEditItem(null)}>Cancel</button>
                            <button className={s.btnPrimary} onClick={handleUpdate}>Save</button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
