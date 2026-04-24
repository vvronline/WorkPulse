import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Pencil, Trash2, ClipboardList, Palmtree, ArrowLeft } from 'lucide-react';
import { getLeavePolicies, deleteLeavePolicyAPI } from '../../api';
import PolicyForm from './PolicyForm';
import HolidaysTab from './HolidaysTab';
import s from '../LeavePolicy.module.css';
import { buildLeaveTypeMeta, LEAVE_TYPE_MAP } from '../../constants/leaves';

/* New policies start completely blank — orgs/HR define every leave type
   themselves (no built-in "sick"/"personal"/etc. seed values). */
const emptyPolicy = {
    leave_type: '',
    name: '',
    color: '#6366f1',
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
    /* When the admin clicks "Manage Holidays" on the Holiday policy card we
       swap the policy grid for the holidays UI inline (no extra navigation,
       no separate sub-tab). */
    const [showHolidays, setShowHolidays] = useState(false);

    /* Build a metadata map that includes both built-in defaults AND any custom
       org-defined leave types so cards render with correct labels/colours. */
    const TYPE_META = useMemo(() => buildLeaveTypeMeta(policies), [policies]);

    const load = useCallback(() => {
        getLeavePolicies().then(r => setPolicies(r.data)).catch(console.error);
    }, []);

    useEffect(() => { load(); }, [load]);

    const handleDelete = async (id) => {
        if (!confirm(
            'Delete this policy?\n\n' +
            'This will also remove every employee\'s balance and any pending or approved leave records for this leave type. This cannot be undone.'
        )) return;
        try { await deleteLeavePolicyAPI(id); load(); } catch { }
    };

    const openAdd = () => { setEditing({ ...emptyPolicy }); setShowForm(true); };
    const openEdit = (p) => { setEditing(p); setShowForm(true); };

    /* Holidays-management view: reuses the existing HolidaysTab UI with a
       "back to policies" affordance at the top. */
    if (showHolidays) {
        return (
            <div className={s.tabPanel}>
                <button
                    className={s.cancelBtn}
                    onClick={() => setShowHolidays(false)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.8rem' }}
                >
                    <ArrowLeft size={14} /> Back to policies
                </button>
                <HolidaysTab isHR />
            </div>
        );
    }

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
                    <ClipboardList size={32} strokeWidth={1.5} />
                    <p className={s.emptyTitle}>No policies defined yet</p>
                    <p className={s.emptyText}>Create leave policies to control how employees request time off</p>
                    <button className={s.primaryBtn} onClick={openAdd}>Create First Policy</button>
                </div>
            ) : (
                <div className={s.policyGrid}>
                    {policies.map(p => {
                        const meta = TYPE_META[p.leave_type] || LEAVE_TYPE_MAP.other;
                        const isHoliday = String(p.leave_type).toLowerCase() === 'holiday';
                        return (
                            <div key={p.id} className={s.policyCard} style={{ '--pc': meta.color, '--pb': meta.bg }}>
                                <div className={s.policyCardTop}>
                                    <div className={s.policyTypeIcon} style={{ background: meta.bg, color: meta.color }}>
                                        {meta.Icon && <meta.Icon size={18} />}
                                    </div>
                                    <div className={s.policyCardActions}>
                                        <button className={s.iconBtn} onClick={() => openEdit(p)} title="Edit"><Pencil size={14} /></button>
                                        {/* The Holiday policy is built-in and managed via the
                                            Manage Holidays button below — hide the delete icon
                                            so admins can't accidentally try to remove it. */}
                                        {!isHoliday && (
                                            <button className={`${s.iconBtn} ${s.iconBtnDanger}`} onClick={() => handleDelete(p.id)} title="Delete"><Trash2 size={14} /></button>
                                        )}
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
                                {isHoliday && (
                                    <button
                                        type="button"
                                        className={s.primaryBtn}
                                        onClick={() => setShowHolidays(true)}
                                        style={{ marginTop: '0.75rem', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem' }}
                                    >
                                        <Palmtree size={14} /> Manage Holidays
                                    </button>
                                )}
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
