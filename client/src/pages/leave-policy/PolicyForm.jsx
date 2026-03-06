import React, { useState } from 'react';
import { useAutoDismiss } from '../../hooks/useAutoDismiss';
import { saveLeavePolicyAPI } from '../../api';
import s from '../LeavePolicy.module.css';

const LEAVE_TYPES = [
    { value: 'sick',     label: 'Sick Leave',    icon: '🤒' },
    { value: 'holiday',  label: 'Holiday',        icon: '🏖️' },
    { value: 'planned',  label: 'Planned Leave',  icon: '📅' },
    { value: 'personal', label: 'Personal',       icon: '👤' },
    { value: 'other',    label: 'Other',           icon: '📝' },
];

const defaults = {
    leave_type: 'sick',
    annual_quota: 12,
    accrual_type: 'annual',
    carry_forward_limit: 0,
    half_day_allowed: 1,
    quarter_day_allowed: 0,
};

export default function PolicyForm({ initial, onClose, onSaved }) {
    const [form, setForm] = useState({ ...defaults, ...initial });
    const [error, setError] = useAutoDismiss('');
    const [saving, setSaving] = useState(false);

    const set = (k, v) => setForm(prev => ({ ...prev, [k]: v }));

    const handleSave = async (e) => {
        e.preventDefault();
        setSaving(true);
        try {
            await saveLeavePolicyAPI(form);
            onSaved();
            onClose();
        } catch (err) {
            setError(err.response?.data?.error || 'Failed to save policy');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className={s.modalBackdrop} onClick={onClose}>
            <div className={s.modalBox} onClick={e => e.stopPropagation()}>
                <div className={s.modalHeader}>
                    <h3 className={s.modalTitle}>{form.id ? 'Edit Policy' : 'New Leave Policy'}</h3>
                    <button className={s.modalClose} onClick={onClose}>×</button>
                </div>

                {error && <div className={s.formError}>{error}</div>}

                <form onSubmit={handleSave} className={s.modalForm}>
                    {/* Leave Type */}
                    <div className={s.formField}>
                        <label className={s.formLabel}>Leave Type</label>
                        <div className={s.typeChipGrid}>
                            {LEAVE_TYPES.map(t => (
                                <button
                                    key={t.value}
                                    type="button"
                                    className={`${s.typeChipOption} ${form.leave_type === t.value ? s.typeChipOptionActive : ''}`}
                                    onClick={() => set('leave_type', t.value)}
                                >
                                    <span>{t.icon}</span>
                                    <span>{t.label}</span>
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className={s.formRow}>
                        <div className={s.formField}>
                            <label className={s.formLabel}>Days Allowed / Year</label>
                            <input
                                className={s.formInput}
                                type="number"
                                min="0"
                                max="365"
                                value={form.annual_quota}
                                onChange={e => set('annual_quota', +e.target.value)}
                                required
                            />
                        </div>
                        <div className={s.formField}>
                            <label className={s.formLabel}>Carry-Forward Limit</label>
                            <input
                                className={s.formInput}
                                type="number"
                                min="0"
                                value={form.carry_forward_limit}
                                onChange={e => set('carry_forward_limit', +e.target.value)}
                            />
                        </div>
                    </div>

                    <div className={s.formField}>
                        <label className={s.formLabel}>Accrual Type</label>
                        <select
                            className={s.formInput}
                            value={form.accrual_type}
                            onChange={e => set('accrual_type', e.target.value)}
                        >
                            <option value="annual">Annual — all days granted at year start</option>
                            <option value="monthly">Monthly — days accrue each month</option>
                            <option value="quarterly">Quarterly — days accrue each quarter</option>
                        </select>
                    </div>

                    <div className={s.formField}>
                        <label className={s.formLabel}>Permissions</label>
                        <div className={s.checkGroup}>
                            <label className={s.checkItem}>
                                <input
                                    type="checkbox"
                                    checked={!!form.half_day_allowed}
                                    onChange={e => set('half_day_allowed', e.target.checked ? 1 : 0)}
                                />
                                <span>Allow Half-day requests</span>
                            </label>
                            <label className={s.checkItem}>
                                <input
                                    type="checkbox"
                                    checked={!!form.quarter_day_allowed}
                                    onChange={e => set('quarter_day_allowed', e.target.checked ? 1 : 0)}
                                />
                                <span>Allow Quarter-day requests</span>
                            </label>
                        </div>
                    </div>

                    <div className={s.modalFooter}>
                        <button type="button" className={s.cancelBtn} onClick={onClose}>Cancel</button>
                        <button type="submit" className={s.primaryBtn} disabled={saving}>
                            {saving ? 'Saving…' : form.id ? 'Save Changes' : 'Create Policy'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
