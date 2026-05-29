import React, { useState, useEffect } from 'react';
import {
  getPlanCatalog, updatePlanCatalog, resetPlanCatalog,
} from '../../api';
import {
  Loader2, Save, RotateCcw, Plus, Trash2, X, ChevronDown, ChevronUp,
} from 'lucide-react';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import s from './Tenants.module.css';

export default function PlanManagement() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [saving, setSaving] = useState(false);
  const [resetModal, setResetModal] = useState(false);

  const [plans, setPlans] = useState({});
  const [featureLabels, setFeatureLabels] = useState({});
  const [featureKeys, setFeatureKeys] = useState([]);
  const [expandedPlan, setExpandedPlan] = useState(null);
  const [newPlanKey, setNewPlanKey] = useState('');

  useEffect(() => {
    getPlanCatalog()
      .then(r => {
        setPlans(r.data.plans);
        setFeatureLabels(r.data.feature_labels || {});
        setFeatureKeys(r.data.feature_keys || Object.keys(r.data.feature_labels || {}));
      })
      .catch(e => setError(e.response?.data?.error || 'Failed to load plan catalog'))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true); setError(''); setSuccess('');
    try {
      const r = await updatePlanCatalog(plans);
      setPlans(r.data.plans);
      setSuccess('Plan catalog saved');
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to save');
    } finally { setSaving(false); }
  };

  const handleReset = async () => {
    setResetModal(false);
    setSaving(true); setError(''); setSuccess('');
    try {
      const r = await resetPlanCatalog();
      setPlans(r.data.plans);
      setSuccess('Plan catalog reset to defaults');
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to reset');
    } finally { setSaving(false); }
  };

  const handleAddPlan = () => {
    const key = newPlanKey.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (!key || plans[key]) {
      setError(key ? `Plan "${key}" already exists` : 'Plan key is required');
      return;
    }
    const features = {};
    featureKeys.forEach(k => { features[k] = false; });
    setPlans(p => ({
      ...p,
      [key]: { label: key.charAt(0).toUpperCase() + key.slice(1), description: '', features, limits: { max_users: 25, max_storage_mb: 5120 } },
    }));
    setNewPlanKey('');
    setExpandedPlan(key);
  };

  const handleDeletePlan = (key) => {
    setPlans(p => {
      const next = { ...p };
      delete next[key];
      return next;
    });
    if (expandedPlan === key) setExpandedPlan(null);
  };

  const updatePlan = (key, field, value) => {
    setPlans(p => ({ ...p, [key]: { ...p[key], [field]: value } }));
  };

  const updatePlanFeature = (planKey, featureKey, value) => {
    setPlans(p => ({
      ...p,
      [planKey]: { ...p[planKey], features: { ...p[planKey].features, [featureKey]: value } },
    }));
  };

  const updatePlanLimit = (planKey, limitKey, value) => {
    const numVal = value === '' || value === 'null' ? null : parseInt(value, 10);
    setPlans(p => ({
      ...p,
      [planKey]: { ...p[planKey], limits: { ...p[planKey].limits, [limitKey]: numVal } },
    }));
  };

  if (loading) return <div className={s.loading}><Loader2 size={20} className={s.spinner} /> Loading…</div>;

  const planKeys = Object.keys(plans);

  return (
    <div>
      {error && (
        <div className={s.errorBanner}>
          <span className={s.errorText}>{error}</span>
          <button onClick={() => setError('')} className={s.errorClose}><X size={16} /></button>
        </div>
      )}
      {success && (
        <div className={s.successBanner}>
          <span>{success}</span>
          <button onClick={() => setSuccess('')} className={s.errorClose} style={{ color: 'var(--success)' }}><X size={16} /></button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, marginBottom: 20, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className={s.btnPrimary} onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 size={14} className={s.spinner} /> : <Save size={14} />}
          Save All Plans
        </button>
        <button className={s.btnSmall} onClick={() => setResetModal(true)} disabled={saving}>
          <RotateCcw size={14} /> Reset to Defaults
        </button>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <input
            value={newPlanKey}
            onChange={e => setNewPlanKey(e.target.value)}
            placeholder="new_plan_key"
            className={s.input}
            style={{ width: 140 }}
            onKeyDown={e => e.key === 'Enter' && handleAddPlan()}
          />
          <button className={s.btnSmall} onClick={handleAddPlan}>
            <Plus size={14} /> Add Plan
          </button>
        </div>
      </div>

      {planKeys.map(key => (
        <fieldset key={key} className={s.fieldset} style={{ marginBottom: 16 }}>
          <legend className={s.legend} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
            onClick={() => setExpandedPlan(expandedPlan === key ? null : key)}>
            {expandedPlan === key ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            <strong>{plans[key].label}</strong>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'monospace' }}>({key})</span>
          </legend>

          {expandedPlan === key && (
            <div style={{ padding: '12px 0 0' }}>
              <div className={s.fieldRowWrap}>
                <div style={{ flex: '1 1 200px' }}>
                  <label className={s.fieldLabel}>Label</label>
                  <input
                    value={plans[key].label}
                    onChange={e => updatePlan(key, 'label', e.target.value)}
                    className={s.input}
                    style={{ width: '100%' }}
                  />
                </div>
                <div style={{ flex: '2 1 300px' }}>
                  <label className={s.fieldLabel}>Description</label>
                  <input
                    value={plans[key].description || ''}
                    onChange={e => updatePlan(key, 'description', e.target.value)}
                    className={s.input}
                    style={{ width: '100%' }}
                  />
                </div>
              </div>

              <div className={s.fieldRowWrap} style={{ marginTop: 12 }}>
                <div>
                  <label className={s.fieldLabel}>Max Users (empty = unlimited)</label>
                  <input
                    type="number" min="1"
                    value={plans[key].limits?.max_users ?? ''}
                    onChange={e => updatePlanLimit(key, 'max_users', e.target.value)}
                    placeholder="unlimited"
                    className={s.inputSmall}
                  />
                </div>
                <div>
                  <label className={s.fieldLabel}>Max Storage (MB, empty = unlimited)</label>
                  <input
                    type="number" min="100"
                    value={plans[key].limits?.max_storage_mb ?? ''}
                    onChange={e => updatePlanLimit(key, 'max_storage_mb', e.target.value)}
                    placeholder="unlimited"
                    className={s.inputSmall}
                  />
                </div>
              </div>

              <div style={{ marginTop: 14 }}>
                <label className={s.fieldLabel}>Features</label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '6px 16px', marginTop: 6 }}>
                  {featureKeys.map(fk => (
                    <label key={fk} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={!!plans[key].features?.[fk]}
                        onChange={e => updatePlanFeature(key, fk, e.target.checked)}
                      />
                      <span>{featureLabels[fk] || fk}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                <button
                  className={s.btnSmall}
                  style={{ color: 'var(--danger)' }}
                  onClick={() => handleDeletePlan(key)}
                >
                  <Trash2 size={13} /> Delete Plan
                </button>
              </div>
            </div>
          )}
        </fieldset>
      ))}

      {planKeys.length === 0 && (
        <div className={s.emptyState}>No plans defined. Add a plan or reset to defaults.</div>
      )}

      <ConfirmDialog
        isOpen={resetModal}
        title="Reset Plan Catalog"
        message="This will replace all custom plans with the original defaults (Standard, Pro, Enterprise). Existing tenants will keep their current plan assignment."
        confirmText="Reset"
        cancelText="Cancel"
        isDanger
        onConfirm={handleReset}
        onCancel={() => setResetModal(false)}
      />
    </div>
  );
}
