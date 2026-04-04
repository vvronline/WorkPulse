import React, { useState, useEffect } from 'react';
import { getLeaveBalances, updateLeaveBalance } from '../../api';
import { Users, Search } from 'lucide-react';
import s from '../LeavePolicy.module.css';
import { LEAVE_TYPE_MAP } from '../../constants/leaves';

const TYPE_META = {
    sick:     { ...LEAVE_TYPE_MAP.sick,     label: 'Sick'    },
    holiday:  { ...LEAVE_TYPE_MAP.holiday,  label: 'Holiday' },
    planned:  { ...LEAVE_TYPE_MAP.planned,  label: 'Planned' },
    personal: { ...LEAVE_TYPE_MAP.personal, label: 'Personal'},
    other:    { ...LEAVE_TYPE_MAP.other,    label: 'Other'   },
};

export default function AllBalances() {
    const [balances, setBalances] = useState([]);
    const [search, setSearch] = useState('');
    const [editItem, setEditItem] = useState(null);
    const [loading, setLoading] = useState(true);
    const [year, setYear] = useState(new Date().getFullYear());

    const load = () => {
        setLoading(true);
        getLeaveBalances('all')
            .then(r => { setBalances(r.data || []); setLoading(false); })
            .catch(() => setLoading(false));
    };

    useEffect(() => { load(); }, []);

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
            load();
            setEditItem(null);
        } catch { }
    };

    const filtered = balances.filter(b =>
        !search || b.full_name?.toLowerCase().includes(search.toLowerCase())
    );

    return (
        <div className={s.tabPanel}>
            <div className={s.panelHeader}>
                <div>
                    <h2 className={s.panelTitle}>All Employee Balances</h2>
                    <p className={s.panelSubtitle}>View and adjust leave balances for all employees</p>
                </div>
            </div>

            <div className={s.tableToolbar}>
                <div className={s.searchBox}>
                    <span className={s.searchIcon}><Search size={15} /></span>
                    <input
                        className={s.searchInput}
                        placeholder="Search by employee name…"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                    />
                </div>
            </div>

            {loading ? (
                <div className={s.loadingWrap}><div className="spinner" /></div>
            ) : filtered.length === 0 ? (
                <div className={s.emptyState}>
                    <Users size={32} strokeWidth={1.5} />
                    <p className={s.emptyTitle}>No balances found</p>
                </div>
            ) : (
                <div className={s.tableWrap}>
                    <table className={s.dataTable}>
                        <thead>
                            <tr>
                                <th>Employee</th>
                                <th>Leave Type</th>
                                <th>Total</th>
                                <th>Used</th>
                                <th>Balance</th>
                                <th>Carried</th>
                                <th>Year</th>
                                <th>Usage</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody>
                            {filtered.map((b, i) => {
                                const meta = TYPE_META[b.leave_type] || TYPE_META.other;
                                const total = (b.total_days || 0) + (b.carried_forward || 0);
                                const pct = total > 0 ? Math.min(Math.round(((b.used || 0) / total) * 100), 100) : 0;
                                return (
                                    <tr key={i}>
                                        <td className={s.tdName}>{b.full_name}</td>
                                        <td>
                                            <span className={s.typeTag} style={{ color: meta.color, background: `${meta.color}18`, display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                                                {meta.Icon && <meta.Icon size={13} />} {meta.label}
                                            </span>
                                        </td>
                                        <td className={s.tdNum}>{b.total_days}</td>
                                        <td className={s.tdNum}>{b.used}</td>
                                        <td className={`${s.tdNum} ${s.tdBold}`} style={{ color: pct >= 80 ? '#ef4444' : pct >= 50 ? '#f59e0b' : '#10b981' }}>{b.balance}</td>
                                        <td className={s.tdNum}>{b.carried_forward}</td>
                                        <td className={s.tdNum}>{b.year}</td>
                                        <td className={s.tdUsage}>
                                            <div className={s.miniBar}>
                                                <div className={s.miniBarFill} style={{ width: `${pct}%`, background: pct >= 80 ? '#ef4444' : meta.color }} />
                                            </div>
                                            <span className={s.miniBarPct}>{pct}%</span>
                                        </td>
                                        <td>
                                            <button className={s.editBtn} onClick={() => setEditItem({ ...b })}>Edit</button>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            {/* Edit Modal */}
            {editItem && (
                <div className={s.modalBackdrop} onClick={() => setEditItem(null)}>
                    <div className={s.modalBox} onClick={e => e.stopPropagation()}>
                        <div className={s.modalHeader}>
                            <h3 className={s.modalTitle}>Edit Balance — {editItem.full_name}</h3>
                            <button className={s.modalClose} onClick={() => setEditItem(null)}>×</button>
                        </div>
                        <div className={s.modalForm}>
                            <div className={s.formRow}>
                                <div className={s.formField}>
                                    <label className={s.formLabel}>Total Days</label>
                                    <input className={s.formInput} type="number" min="0" value={editItem.total_days}
                                        onChange={e => setEditItem({ ...editItem, total_days: +e.target.value })} />
                                </div>
                                <div className={s.formField}>
                                    <label className={s.formLabel}>Used</label>
                                    <input className={s.formInput} type="number" min="0" value={editItem.used}
                                        onChange={e => setEditItem({ ...editItem, used: +e.target.value })} />
                                </div>
                            </div>
                            <div className={s.formField}>
                                <label className={s.formLabel}>Carried Forward</label>
                                <input className={s.formInput} type="number" min="0" value={editItem.carried_forward}
                                    onChange={e => setEditItem({ ...editItem, carried_forward: +e.target.value })} />
                            </div>
                            <div className={s.modalFooter}>
                                <button className={s.cancelBtn} onClick={() => setEditItem(null)}>Cancel</button>
                                <button className={s.primaryBtn} onClick={handleUpdate}>Save Changes</button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
