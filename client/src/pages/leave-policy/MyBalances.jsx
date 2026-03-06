import React, { useState, useEffect } from 'react';
import { getLeaveBalances } from '../../api';
import s from '../LeavePolicy.module.css';

const TYPE_META = {
    sick:     { icon: '🤒', color: '#ef4444', bg: 'rgba(239,68,68,0.10)',    label: 'Sick Leave'    },
    holiday:  { icon: '🏖️', color: '#f59e0b', bg: 'rgba(245,158,11,0.10)',   label: 'Holiday'       },
    planned:  { icon: '📅', color: '#6366f1', bg: 'rgba(99,102,241,0.10)',   label: 'Planned Leave' },
    personal: { icon: '👤', color: '#10b981', bg: 'rgba(16,185,129,0.10)',   label: 'Personal'      },
    other:    { icon: '📝', color: '#64748b', bg: 'rgba(100,116,139,0.10)',  label: 'Other'         },
};

export default function MyBalances() {
    const [balances, setBalances] = useState([]);
    const [loading, setLoading] = useState(true);
    const [year, setYear] = useState(new Date().getFullYear());

    useEffect(() => {
        setLoading(true);
        getLeaveBalances(year)
            .then(r => { setBalances(r.data || []); setLoading(false); })
            .catch(() => setLoading(false));
    }, [year]);

    const years = [year - 1, year, year + 1];

    return (
        <div className={s.tabPanel}>
            <div className={s.panelHeader}>
                <div>
                    <h2 className={s.panelTitle}>My Leave Balances</h2>
                    <p className={s.panelSubtitle}>Your available leave days for the selected year</p>
                </div>
                <select
                    className={s.yearSelect}
                    value={year}
                    onChange={e => setYear(+e.target.value)}
                >
                    {years.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
            </div>

            {loading ? (
                <div className={s.loadingWrap}><div className="spinner" /></div>
            ) : balances.length === 0 ? (
                <div className={s.emptyState}>
                    <div className={s.emptyIcon}>📊</div>
                    <p className={s.emptyTitle}>No balances found</p>
                    <p className={s.emptyText}>Contact HR to set up leave policies for your account</p>
                </div>
            ) : (
                <div className={s.balanceCardGrid}>
                    {balances.map(b => {
                        const meta = TYPE_META[b.leave_type] || TYPE_META.other;
                        const total = (b.quota || b.total_days || 0) + (b.carried_forward || 0);
                        const used = b.used || 0;
                        const available = total - used;
                        const pct = total > 0 ? Math.min(Math.round((used / total) * 100), 100) : 0;
                        const barColor = pct >= 80 ? '#ef4444' : pct >= 50 ? '#f59e0b' : meta.color;
                        return (
                            <div key={b.id || b.leave_type} className={s.balanceDetailCard} style={{ '--bc': meta.color, '--bb': meta.bg }}>
                                <div className={s.balanceDetailTop}>
                                    <div className={s.balanceDetailIcon} style={{ background: meta.bg, color: meta.color }}>
                                        {meta.icon}
                                    </div>
                                    <div>
                                        <div className={s.balanceDetailType}>{meta.label}</div>
                                        <div className={s.balanceDetailYear}>Year {b.year || year}</div>
                                    </div>
                                </div>
                                <div className={s.balanceDetailNums}>
                                    <div className={s.balanceDetailNum}>
                                        <span className={s.balanceDetailBig} style={{ color: meta.color }}>{available}</span>
                                        <span className={s.balanceDetailSmall}>available</span>
                                    </div>
                                    <div className={s.balanceDetailDivider} />
                                    <div className={s.balanceDetailNum}>
                                        <span className={s.balanceDetailBig}>{used}</span>
                                        <span className={s.balanceDetailSmall}>used</span>
                                    </div>
                                    <div className={s.balanceDetailDivider} />
                                    <div className={s.balanceDetailNum}>
                                        <span className={s.balanceDetailBig}>{total}</span>
                                        <span className={s.balanceDetailSmall}>total</span>
                                    </div>
                                </div>
                                <div className={s.balanceDetailBar}>
                                    <div className={s.balanceDetailFill} style={{ width: `${pct}%`, background: barColor }} />
                                </div>
                                <div className={s.balanceDetailMeta}>
                                    {b.carried_forward > 0 && `${b.carried_forward} carried forward`}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
