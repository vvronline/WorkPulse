import React, { useState, useEffect, useCallback } from 'react';
import { getLeavePolicies, deleteLeavePolicyAPI } from '../../api';
import PolicyForm from './PolicyForm';
import s from '../LeavePolicy.module.css';

const TYPE_META = {
    sick:     { icon: '🤒', color: '#ef4444', bg: 'rgba(239,68,68,0.10)',     label: 'Sick Leave'    },
    holiday:  { icon: '🏖️', color: '#f59e0b', bg: 'rgba(245,158,11,0.10)',   label: 'Holiday'       },
    planned:  { icon: '📅', color: '#6366f1', bg: 'rgba(99,102,241,0.10)',    label: 'Planned Leave' },
    personal: { icon: '👤', color: '#10b981', bg: 'rgba(16,185,129,0.10)',    label: 'Personal'      },
    other:    { icon: '📝', color: '#64748b', bg: 'rgba(100,116,139,0.10)',   label: 'Other'         },
};

const emptyPolicy = {
    leave_type: 'sick',
    annual_quota: 12,
    accrual_type: 'annual',
    carry_forward_limit: 0,
    half_day_allowed: 1,
    quarter_day_allowed: 0,
};

export default function PoliciesTab() {
    const [policies, setPolicies] = useState([]);
    const [editing, setEditing] = useState(null);
    const [showForm, setShowForm] = useState(false);

    const load = useCallback(() => {
        getLeavePolicies().then(r => setPolicies(r.data)).catch(console.error);
    }, []);

    useEffect(() => { load(); }, [load]);

    const handleDelete = async (id) => {
        if (!confirm('Delete this policy?')) return;
        try { await deleteLeavePolicyAPI(id); load(); } catch { }
    };

    const openAdd = () => { setEditing({ ...emptyPolicy }); setShowForm(true); };
    const openEdit = (p) => { setEditing(p); setShowForm(true); };

    return (
        <div className={s.tabPanel}>
            <div className={s.panelHeader}>
                <div>
                    <h2 className={s.panelTitle}>Leave Policies</h2>
                    <p className={s.panelSubtitle}>Define quotas, accrual rules, and permissions per leave type</p>
                </div>
                <button className={s.primaryBtn} onClick={openAdd}>+ Add Policy</button>
            </div>

            {policies.length === 0 ? (
                <div className={s.emptyState}>
                    <div className={s.emptyIcon}>📋</div>
                    <p className={s.emptyTitle}>No policies defined yet</p>
                    <p className={s.emptyText}>Create leave policies to control how employees request time off</p>
                    <button className={s.primaryBtn} onClick={openAdd}>Create First Policy</button>
                </div>
            ) : (
                <div className={s.policyGrid}>
                    {policies.map(p => {
                        const meta = TYPE_META[p.leave_type] || TYPE_META.other;
                        return (
                            <div key={p.id} className={s.policyCard} style={{ '--pc': meta.color, '--pb': meta.bg }}>
                                <div className={s.policyCardTop}>
                                    <div className={s.policyTypeIcon} style={{ background: meta.bg, color: meta.color }}>
                                        {meta.icon}
                                    </div>
                                    <div className={s.policyCardActions}>
                                        <button className={s.iconBtn} onClick={() => openEdit(p)} title="Edit">✏️</button>
                                        <button className={`${s.iconBtn} ${s.iconBtnDanger}`} onClick={() => handleDelete(p.id)} title="Delete">🗑</button>
                                    </div>
                                </div>
                                <div className={s.policyTypeName}>{meta.label}</div>
                                <div className={s.policyQuota}>
                                    <span className={s.policyQuotaNum}>{p.annual_quota}</span>
                                    <span className={s.policyQuotaLabel}>days / year</span>
                                </div>
                                <div className={s.policyMeta}>
                                    <div className={s.policyMetaItem}>
                                        <span className={s.policyMetaKey}>Accrual</span>
                                        <span className={s.policyMetaVal}>{p.accrual_type}</span>
                                    </div>
                                    <div className={s.policyMetaItem}>
                                        <span className={s.policyMetaKey}>Carry-forward</span>
                                        <span className={s.policyMetaVal}>{p.carry_forward_limit} days</span>
                                    </div>
                                </div>
                                <div className={s.policyPerms}>
                                    <span className={`${s.permChip} ${p.half_day_allowed ? s.permOn : s.permOff}`}>½ Half-day</span>
                                    <span className={`${s.permChip} ${p.quarter_day_allowed ? s.permOn : s.permOff}`}>¼ Quarter-day</span>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {showForm && (
                <PolicyForm
                    initial={editing}
                    onClose={() => setShowForm(false)}
                    onSaved={load}
                />
            )}
        </div>
    );
}
