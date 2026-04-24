import React, { useState } from 'react';
import { X } from 'lucide-react';
import { useAutoDismiss } from '../../hooks/useAutoDismiss';
import { saveLeavePolicyAPI } from '../../api';
import s from '../LeavePolicy.module.css';

const defaults = {
    leave_type: '',
    name: '',
    color: '#6366f1',
    annual_quota: 12,
    accrual_type: 'annual',
    carry_forward_limit: 0,
    half_day_allowed: 1,
    quarter_day_allowed: 0,
};

/* Slugify a free-form leave-type name into a stable, URL-safe identifier so
   the DB always stores a clean, lowercase slug regardless of the label the
   admin typed in. */
function slugify(s) {
    return String(s || '')
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40);
}

export default function PolicyForm({ initial, onClose, onSaved }) {
    const [form, setForm] = useState({ ...defaults, ...initial });
    const [error, setError] = useAutoDismiss('');
    const [saving, setSaving] = useState(false);

    /* Every leave type is now custom — orgs/HR define their own taxonomy.
       For new policies the field is blank and editable; for existing ones we
       seed the input with the policy's stored name (or its slug as a fallback)
       and lock the slug so we never accidentally rename an existing type. */
    const isExisting = !!form.id;
    const [customLabel, setCustomLabel] = useState(form.name || form.leave_type || '');

    const set = (k, v) => setForm(prev => ({ ...prev, [k]: v }));

    const handleSave = async (e) => {
        e.preventDefault();
        setSaving(true);
        try {
            const payload = { ...form };
            const label = (customLabel || '').trim();
            if (!label) { setError('Please enter a leave type name'); setSaving(false); return; }
            payload.name = label;
            if (!isExisting) {
                const slug = slugify(label);
                if (!slug) { setError('Invalid leave type name'); setSaving(false); return; }
                payload.leave_type = slug;
            }
            await saveLeavePolicyAPI(payload);
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
                <button className={s.modalClose} onClick={onClose} aria-label="Close"><X size={18} /></button>
                </div>

                {error && <div className={s.formError}>{error}</div>}

                <form onSubmit={handleSave} className={s.modalForm}>
                    {/* Leave Type — fully org-defined. There are no built-in
                        types, so HR/admins decide their own taxonomy. */}
                    <div className={s.formField}>
                        <label className={s.formLabel}>Leave Type Name</label>
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <input
                                className={s.formInput}
                                type="text"
                                placeholder="e.g. Sick, Casual, Bereavement, Maternity, Comp Off…"
                                value={customLabel}
                                onChange={e => setCustomLabel(e.target.value)}
                                maxLength={40}
                                required
                                disabled={isExisting}
                                title={isExisting ? 'Leave-type identifier cannot be renamed once created' : ''}
                                style={{ flex: 1 }}
                            />
                            <input
                                type="color"
                                value={form.color || '#6366f1'}
                                onChange={e => set('color', e.target.value)}
                                title="Pick a colour for this leave type"
                                style={{ width: 44, height: 38, padding: 2, border: '1px solid var(--border)', borderRadius: 8, background: 'transparent' }}
                            />
                        </div>
                        {isExisting && (
                            <p style={{ marginTop: '0.4rem', fontSize: '0.75rem', color: 'var(--muted, #888)' }}>
                                The leave-type identifier is locked once created so existing balances and requests stay linked. Delete and re-create the policy to rename it.
                            </p>
                        )}
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
