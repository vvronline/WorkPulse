import React, { useState } from 'react';
import { useAutoDismiss } from '../../hooks/useAutoDismiss';
import { saveLeavePolicyAPI } from '../../api';
import s from '../LeavePolicy.module.css';

const defaults = {
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

export default function PolicyForm({ initial, onClose, onSaved }) {
    const [form, setForm] = useState({ ...defaults, ...initial });
    const [error, setError] = useAutoDismiss('');

    const set = (k, v) => setForm(prev => ({ ...prev, [k]: v }));

    const handleSave = async (e) => {
        e.preventDefault();
        try {
            await saveLeavePolicyAPI(form);
            onSaved();
            onClose();
        } catch (err) {
            setError(err.response?.data?.error || 'Failed');
        }
    };

    return (
        <div className={s.modalOverlay} onClick={onClose}>
            <div className={`${s.modal} ${s['modal-narrow']}`} onClick={e => e.stopPropagation()}>
                <h3>{form.id ? 'Edit Policy' : 'Create Policy'}</h3>
                {error && <div className={s.error}>{error}</div>}
                <form onSubmit={handleSave}>
                    <div className={s.formGroup}>
                        <label>Policy Name</label>
                        <input value={form.name} onChange={e => set('name', e.target.value)} required placeholder="e.g. Annual Leave" />
                    </div>
                    <div className={s['grid-2col-form']}>
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
                    <div className={s['checkbox-row']}>
                        <label className={s['checkbox-label']}>
                            <input type="checkbox" checked={!!form.requires_approval} onChange={e => set('requires_approval', e.target.checked ? 1 : 0)} /> Requires Approval
                        </label>
                        <label className={s['checkbox-label']}>
                            <input type="checkbox" checked={!!form.half_day_allowed} onChange={e => set('half_day_allowed', e.target.checked ? 1 : 0)} /> Half-day
                        </label>
                        <label className={s['checkbox-label']}>
                            <input type="checkbox" checked={!!form.quarter_day_allowed} onChange={e => set('quarter_day_allowed', e.target.checked ? 1 : 0)} /> Quarter-day
                        </label>
                    </div>
                    <div className={s.formGroup}>
                        <label>Description</label>
                        <textarea value={form.description || ''} onChange={e => set('description', e.target.value)} rows={2} className={s['textarea-input']} />
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
