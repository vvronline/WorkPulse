import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../AuthContext';
import {
    getLeavePolicies, saveLeavePolicyAPI, deleteLeavePolicyAPI,
    getLeaveBalances, getUserLeaveBalances, updateLeaveBalance,
    getHolidays, addHoliday, deleteHoliday
} from '../api';
import s from './Admin.module.css';

export default function LeavePolicy() {
    const { user } = useAuth();
    const [tab, setTab] = useState('policies');
    const isHR = ['hr_admin', 'super_admin'].includes(user?.role);

    return (
        <div className={s.adminPage}>
            <h1>Leave Management</h1>
            <div className={s.tabs}>
                {isHR && <button className={`${s.tab} ${tab === 'policies' ? s.active : ''}`} onClick={() => setTab('policies')}>Policies</button>}
                <button className={`${s.tab} ${tab === 'balances' ? s.active : ''}`} onClick={() => setTab('balances')}>My Balances</button>
                <button className={`${s.tab} ${tab === 'holidays' ? s.active : ''}`} onClick={() => setTab('holidays')}>Holidays</button>
                {isHR && <button className={`${s.tab} ${tab === 'allBalances' ? s.active : ''}`} onClick={() => setTab('allBalances')}>All Balances</button>}
            </div>
            {tab === 'policies' && isHR && <PoliciesTab />}
            {tab === 'balances' && <MyBalances />}
            {tab === 'holidays' && <HolidaysTab isHR={isHR} />}
            {tab === 'allBalances' && isHR && <AllBalances />}
        </div>
    );
}

function PoliciesTab() {
    const [policies, setPolicies] = useState([]);
    const [editing, setEditing] = useState(null);
    const [showForm, setShowForm] = useState(false);

    const fetch = useCallback(() => {
        getLeavePolicies().then(r => setPolicies(r.data)).catch(() => {});
    }, []);

    useEffect(() => { fetch(); }, [fetch]);

    const handleDelete = async (id) => {
        if (!confirm('Delete this policy?')) return;
        try { await deleteLeavePolicyAPI(id); fetch(); } catch { }
    };

    const empty = { name: '', leave_type: 'annual', days_allowed: 12, accrual_type: 'annual', carry_forward_limit: 0, min_service_days: 0, requires_approval: 1, half_day_allowed: 1, quarter_day_allowed: 0, description: '' };

    return (
        <>
            <button className={s.btnPrimary} style={{ marginBottom: '1rem' }} onClick={() => { setEditing(empty); setShowForm(true); }}>+ Add Policy</button>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1rem' }}>
                {policies.map(p => (
                    <div key={p.id} style={{ background: 'var(--card-bg)', borderRadius: 12, padding: '1.25rem', border: '1px solid var(--border)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '0.75rem' }}>
                            <div>
                                <div style={{ fontWeight: 700, fontSize: '1.05rem' }}>{p.name}</div>
                                <span className={s.badgeRole} style={{ fontSize: '0.7rem', marginTop: '0.3rem', display: 'inline-block' }}>{p.leave_type}</span>
                            </div>
                            <div style={{ display: 'flex', gap: '0.3rem' }}>
                                <button className={s.btnSmall} style={{ background: 'var(--accent)', color: '#fff' }} onClick={() => { setEditing(p); setShowForm(true); }}>Edit</button>
                                <button className={s.btnSmall} style={{ background: '#ef4444', color: '#fff' }} onClick={() => handleDelete(p.id)}>Delete</button>
                            </div>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem', fontSize: '0.85rem' }}>
                            <div><span style={{ color: 'var(--text-secondary)' }}>Days:</span> <strong>{p.days_allowed}</strong></div>
                            <div><span style={{ color: 'var(--text-secondary)' }}>Accrual:</span> <strong>{p.accrual_type}</strong></div>
                            <div><span style={{ color: 'var(--text-secondary)' }}>Carry-forward:</span> <strong>{p.carry_forward_limit}</strong></div>
                            <div><span style={{ color: 'var(--text-secondary)' }}>Min service:</span> <strong>{p.min_service_days}d</strong></div>
                            <div>{p.half_day_allowed ? '✓ Half-day' : '✗ Half-day'}</div>
                            <div>{p.quarter_day_allowed ? '✓ Quarter-day' : '✗ Quarter-day'}</div>
                        </div>
                        {p.description && <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.5rem' }}>{p.description}</div>}
                    </div>
                ))}
                {policies.length === 0 && <div style={{ padding: '2rem', color: 'var(--text-secondary)' }}>No leave policies defined yet.</div>}
            </div>
            {showForm && <PolicyForm initial={editing} onClose={() => setShowForm(false)} onSaved={fetch} />}
        </>
    );
}

function PolicyForm({ initial, onClose, onSaved }) {
    const [form, setForm] = useState({ ...initial });
    const [error, setError] = useState('');

    const set = (k, v) => setForm({ ...form, [k]: v });

    const handleSave = async (e) => {
        e.preventDefault();
        try {
            await saveLeavePolicyAPI(form);
            onSaved();
            onClose();
        } catch (e) { setError(e.response?.data?.error || 'Failed'); }
    };

    return (
        <div className={s.modalOverlay} onClick={onClose}>
            <div className={s.modal} onClick={e => e.stopPropagation()} style={{ maxWidth: 520 }}>
                <h3>{form.id ? 'Edit Policy' : 'Create Policy'}</h3>
                {error && <div className={s.error}>{error}</div>}
                <form onSubmit={handleSave}>
                    <div className={s.formGroup}>
                        <label>Policy Name</label>
                        <input value={form.name} onChange={e => set('name', e.target.value)} required placeholder="e.g. Annual Leave" />
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                        <div className={s.formGroup}>
                            <label>Leave Type</label>
                            <select value={form.leave_type} onChange={e => set('leave_type', e.target.value)}>
                                <option value="annual">Annual</option>
                                <option value="sick">Sick</option>
                                <option value="casual">Casual</option>
                                <option value="maternity">Maternity</option>
                                <option value="paternity">Paternity</option>
                                <option value="unpaid">Unpaid</option>
                                <option value="compensatory">Compensatory</option>
                                <option value="bereavement">Bereavement</option>
                            </select>
                        </div>
                        <div className={s.formGroup}>
                            <label>Days Allowed (yearly)</label>
                            <input type="number" min="0" value={form.days_allowed} onChange={e => set('days_allowed', +e.target.value)} required />
                        </div>
                        <div className={s.formGroup}>
                            <label>Accrual Type</label>
                            <select value={form.accrual_type} onChange={e => set('accrual_type', e.target.value)}>
                                <option value="annual">Annual (all at start)</option>
                                <option value="monthly">Monthly</option>
                                <option value="quarterly">Quarterly</option>
                            </select>
                        </div>
                        <div className={s.formGroup}>
                            <label>Carry Forward Limit</label>
                            <input type="number" min="0" value={form.carry_forward_limit} onChange={e => set('carry_forward_limit', +e.target.value)} />
                        </div>
                        <div className={s.formGroup}>
                            <label>Min Service Days</label>
                            <input type="number" min="0" value={form.min_service_days} onChange={e => set('min_service_days', +e.target.value)} />
                        </div>
                    </div>
                    <div style={{ display: 'flex', gap: '1.5rem', margin: '0.75rem 0' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer' }}>
                            <input type="checkbox" checked={!!form.requires_approval} onChange={e => set('requires_approval', e.target.checked ? 1 : 0)} /> Requires Approval
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer' }}>
                            <input type="checkbox" checked={!!form.half_day_allowed} onChange={e => set('half_day_allowed', e.target.checked ? 1 : 0)} /> Half-day
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer' }}>
                            <input type="checkbox" checked={!!form.quarter_day_allowed} onChange={e => set('quarter_day_allowed', e.target.checked ? 1 : 0)} /> Quarter-day
                        </label>
                    </div>
                    <div className={s.formGroup}>
                        <label>Description</label>
                        <textarea value={form.description || ''} onChange={e => set('description', e.target.value)} rows={2} style={{ width: '100%', padding: '0.5rem', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--input-bg)', color: 'var(--text-primary)', resize: 'vertical' }} />
                    </div>
                    <div className={s.formActions}>
                        <button type="button" className={s.btnCancel} onClick={onClose}>Cancel</button>
                        <button type="submit" className={s.btnPrimary}>Save Policy</button>
                    </div>
                </form>
            </div>
        </div>
    );
}

function MyBalances() {
    const [balances, setBalances] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        getLeaveBalances().then(r => { setBalances(r.data); setLoading(false); }).catch(() => setLoading(false));
    }, []);

    if (loading) return <p>Loading...</p>;

    return (
        <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '1rem' }}>
                {balances.map(b => {
                    const used = b.used || 0;
                    const pct = b.total_days > 0 ? Math.round((used / b.total_days) * 100) : 0;
                    return (
                        <div key={b.id} style={{ background: 'var(--card-bg)', borderRadius: 12, padding: '1.25rem', border: '1px solid var(--border)' }}>
                            <div style={{ fontWeight: 700, marginBottom: '0.5rem' }}>{b.policy_name}</div>
                            <span className={s.badgeRole} style={{ fontSize: '0.7rem' }}>{b.leave_type}</span>
                            <div style={{ margin: '0.75rem 0' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '0.25rem' }}>
                                    <span>Used: {used}</span>
                                    <span>Balance: {b.balance}</span>
                                </div>
                                <div style={{ height: 8, background: 'var(--border)', borderRadius: 4 }}>
                                    <div style={{ height: '100%', borderRadius: 4, width: `${Math.min(pct, 100)}%`, background: pct >= 80 ? '#ef4444' : pct >= 50 ? '#f59e0b' : '#22c55e', transition: 'width 0.3s' }} />
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                                    <span>Total: {b.total_days}</span>
                                    <span>Carried: {b.carried_forward}</span>
                                </div>
                            </div>
                            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Year: {b.year}</div>
                        </div>
                    );
                })}
                {balances.length === 0 && <div style={{ padding: '2rem', color: 'var(--text-secondary)' }}>No leave balances found. Contact HR to set up leave policies.</div>}
            </div>
        </>
    );
}

function HolidaysTab({ isHR }) {
    const [holidays, setHolidays] = useState([]);
    const [showForm, setShowForm] = useState(false);
    const [form, setForm] = useState({ name: '', date: '', is_optional: 0 });
    const [year, setYear] = useState(new Date().getFullYear());

    const fetch = useCallback(() => {
        getHolidays(year).then(r => setHolidays(r.data)).catch(() => {});
    }, [year]);

    useEffect(() => { fetch(); }, [fetch]);

    const handleAdd = async (e) => {
        e.preventDefault();
        try {
            await addHoliday(form);
            setForm({ name: '', date: '', is_optional: 0 });
            setShowForm(false);
            fetch();
        } catch { }
    };

    const handleDelete = async (id) => {
        if (!confirm('Delete this holiday?')) return;
        try { await deleteHoliday(id); fetch(); } catch { }
    };

    const upcoming = holidays.filter(h => new Date(h.date) >= new Date()).sort((a, b) => new Date(a.date) - new Date(b.date));
    const past = holidays.filter(h => new Date(h.date) < new Date()).sort((a, b) => new Date(b.date) - new Date(a.date));

    return (
        <>
            <div className={s.toolbar}>
                <select value={year} onChange={e => setYear(+e.target.value)} style={{ padding: '0.5rem 1.8rem 0.5rem 0.5rem', borderRadius: 8, border: '1px solid var(--glass-border)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontFamily: 'inherit' }}>
                    {[year - 1, year, year + 1].map(y => <option key={y} value={y}>{y}</option>)}
                </select>
                {isHR && <button className={s.btnPrimary} onClick={() => setShowForm(true)}>+ Add Holiday</button>}
            </div>

            {upcoming.length > 0 && (
                <>
                    <h3 style={{ marginBottom: '0.5rem', fontSize: '1rem' }}>📅 Upcoming</h3>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: '0.75rem', marginBottom: '1.5rem' }}>
                        {upcoming.map(h => (
                            <HolidayCard key={h.id} holiday={h} isHR={isHR} onDelete={handleDelete} />
                        ))}
                    </div>
                </>
            )}

            {past.length > 0 && (
                <>
                    <h3 style={{ marginBottom: '0.5rem', fontSize: '1rem', color: 'var(--text-secondary)' }}>Past</h3>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: '0.75rem', opacity: 0.7 }}>
                        {past.map(h => (
                            <HolidayCard key={h.id} holiday={h} isHR={isHR} onDelete={handleDelete} />
                        ))}
                    </div>
                </>
            )}

            {holidays.length === 0 && <div style={{ padding: '2rem', color: 'var(--text-secondary)' }}>No holidays defined for {year}.</div>}

            {showForm && (
                <div className={s.modalOverlay} onClick={() => setShowForm(false)}>
                    <div className={s.modal} onClick={e => e.stopPropagation()}>
                        <h3>Add Holiday</h3>
                        <form onSubmit={handleAdd}>
                            <div className={s.formGroup}>
                                <label>Holiday Name</label>
                                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required placeholder="e.g. Christmas Day" />
                            </div>
                            <div className={s.formGroup}>
                                <label>Date</label>
                                <input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} required />
                            </div>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', margin: '0.75rem 0', cursor: 'pointer' }}>
                                <input type="checkbox" checked={!!form.is_optional} onChange={e => setForm({ ...form, is_optional: e.target.checked ? 1 : 0 })} /> Optional holiday
                            </label>
                            <div className={s.formActions}>
                                <button type="button" className={s.btnCancel} onClick={() => setShowForm(false)}>Cancel</button>
                                <button type="submit" className={s.btnPrimary}>Add</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </>
    );
}

function HolidayCard({ holiday: h, isHR, onDelete }) {
    const dt = new Date(h.date);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    return (
        <div style={{ background: 'var(--card-bg)', borderRadius: 10, padding: '0.8rem 1rem', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <div style={{ textAlign: 'center', minWidth: 45 }}>
                    <div style={{ fontSize: '1.25rem', fontWeight: 700, lineHeight: 1 }}>{dt.getDate()}</div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{months[dt.getMonth()]}</div>
                </div>
                <div>
                    <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{h.name}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                        {days[dt.getDay()]} {h.is_optional ? '• Optional' : ''}
                    </div>
                </div>
            </div>
            {isHR && <button className={s.btnSmall} style={{ background: '#ef4444', color: '#fff' }} onClick={() => onDelete(h.id)}>✗</button>}
        </div>
    );
}

function AllBalances() {
    const [balances, setBalances] = useState([]);
    const [search, setSearch] = useState('');
    const [editItem, setEditItem] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        getLeaveBalances('all').then(r => { setBalances(r.data); setLoading(false); }).catch(() => setLoading(false));
    }, []);

    const handleUpdate = async () => {
        if (!editItem) return;
        try {
            await updateLeaveBalance(editItem.user_id, { policy_id: editItem.policy_id, year: editItem.year, total_days: editItem.total_days, used: editItem.used, carried_forward: editItem.carried_forward });
            const r = await getLeaveBalances('all');
            setBalances(r.data);
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
                <thead><tr><th>Employee</th><th>Policy</th><th>Total</th><th>Used</th><th>Balance</th><th>Year</th><th>Actions</th></tr></thead>
                <tbody>
                    {filtered.map((b, i) => (
                        <tr key={i}>
                            <td>{b.full_name}</td>
                            <td>{b.policy_name}</td>
                            <td>{b.total_days}</td>
                            <td>{b.used}</td>
                            <td style={{ fontWeight: 600 }}>{b.balance}</td>
                            <td>{b.year}</td>
                            <td><button className={s.btnSmall} style={{ background: 'var(--accent)', color: '#fff' }} onClick={() => setEditItem({ ...b })}>Edit</button></td>
                        </tr>
                    ))}
                    {filtered.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-secondary)' }}>No balances found</td></tr>}
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
