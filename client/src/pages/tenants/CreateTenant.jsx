import React, { useState } from 'react';
import { createTenant, createTenantUser, seedTenant } from '../../api';
import { Building2, Users, UserPlus, Sprout, Check, ChevronRight, Loader2 } from 'lucide-react';
import s from './Tenants.module.css';

const STEPS = [
  { key: 'basics', label: 'Basics', icon: Building2 },
  { key: 'limits', label: 'Limits', icon: Users },
  { key: 'admin', label: 'Super Admin', icon: UserPlus },
  { key: 'seed', label: 'Seed Data', icon: Sprout },
];

export default function CreateTenant({ onCreated }) {
  const [step, setStep] = useState(0);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [createdTenantId, setCreatedTenantId] = useState(null);

  // Step 1: Basics
  const [orgName, setOrgName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugError, setSlugError] = useState('');

  // Step 2: Limits
  const [maxUsers, setMaxUsers] = useState('');
  const [maxStorage, setMaxStorage] = useState('');

  // Step 3: Super Admin
  const [adminUsername, setAdminUsername] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminFullName, setAdminFullName] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [adminCreated, setAdminCreated] = useState(false);

  // Step 4: Seed
  const [seedDone, setSeedDone] = useState(false);
  const [seedResult, setSeedResult] = useState(null);

  const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

  const handleOrgNameChange = (name) => {
    setOrgName(name);
    const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
    setSlug(s);
    setSlugError('');
  };

  const handleSlugChange = (val) => {
    setSlug(val);
    setSlugError(val && !SLUG_RE.test(val) ? 'Lowercase alphanumeric with hyphens, 2–50 chars' : '');
  };

  const handleCreateTenant = async () => {
    if (!orgName.trim() || !slug.trim()) { setError('Organization name and slug are required'); return; }
    if (slug && !SLUG_RE.test(slug)) { setSlugError('Invalid slug format'); return; }
    setSubmitting(true); setError('');
    try {
      const res = await createTenant({
        org_name: orgName.trim(),
        slug: slug.trim(),
        max_users: maxUsers ? Number(maxUsers) : null,
        max_storage_mb: maxStorage ? Number(maxStorage) : null,
      });
      setCreatedTenantId(res.data.tenant.id);
      setStep(2); // Move to admin step
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to create tenant');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateAdmin = async () => {
    if (!adminUsername || !adminEmail || !adminFullName || !adminPassword) {
      setError('All fields are required'); return;
    }
    setSubmitting(true); setError('');
    try {
      await createTenantUser(createdTenantId, {
        username: adminUsername,
        email: adminEmail,
        full_name: adminFullName,
        password: adminPassword,
        role: 'super_admin',
      });
      setAdminCreated(true);
      setStep(3);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to create admin user');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSeed = async () => {
    setSubmitting(true); setError('');
    try {
      const res = await seedTenant(createdTenantId);
      setSeedResult(res.data.seeded);
      setSeedDone(true);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to seed data');
    } finally {
      setSubmitting(false);
    }
  };

  const handleFinish = () => {
    if (createdTenantId) onCreated(createdTenantId);
  };

  return (
    <div className={s.wizard}>
      <h2 className={s.wizardTitle}>Create New Tenant</h2>
      <p className={s.wizardSubtitle}>Set up a new organization with admin access and optional seed data</p>

      {/* Step indicators */}
      <div className={s.wizardSteps}>
        {STEPS.map((st, i) => {
          const Icon = st.icon;
          const isDone = i < step || (i === 3 && seedDone);
          const isActive = i === step;
          return (
            <div key={st.key} className={`${s.wizardStep} ${isActive ? s.wizardStepActive : ''} ${isDone ? s.wizardStepDone : ''}`}>
              {isDone ? <Check size={14} /> : <Icon size={14} />}
              {st.label}
            </div>
          );
        })}
      </div>

      {error && (
        <div className={s.errorBanner} style={{ marginBottom: 16 }}>
          <span className={s.errorText}>{error}</span>
          <button onClick={() => setError('')} className={s.errorClose}>×</button>
        </div>
      )}

      {/* Step 1: Basics + Limits combined */}
      {step === 0 && (
        <>
          <div className={s.wizardGrid}>
            <div>
              <label className={s.fieldLabelSec}>Organization Name *</label>
              <input value={orgName} onChange={e => handleOrgNameChange(e.target.value)} className={s.input} style={{ width: '100%' }} placeholder="Acme Inc." />
            </div>
            <div>
              <label className={s.fieldLabelSec}>Slug *</label>
              <input value={slug} onChange={e => handleSlugChange(e.target.value)} className={`${s.input} ${slugError ? s.inputError : ''}`} style={{ width: '100%', fontFamily: 'monospace' }} />
              {slugError && <div className={s.fieldError}>{slugError}</div>}
            </div>
          </div>
          <div className={s.wizardActions}>
            <button className={s.btnPrimary} onClick={() => { if (orgName.trim() && slug.trim() && !slugError) setStep(1); }}>
              Next: Limits <ChevronRight size={14} />
            </button>
          </div>
        </>
      )}

      {/* Step 2: Limits */}
      {step === 1 && (
        <>
          <div className={s.wizardGrid}>
            <div>
              <label className={s.fieldLabelSec}>Max Users (leave empty for unlimited)</label>
              <input type="number" value={maxUsers} onChange={e => setMaxUsers(e.target.value)} className={s.input} style={{ width: '100%' }} placeholder="∞" />
            </div>
            <div>
              <label className={s.fieldLabelSec}>Max Storage in MB (leave empty for unlimited)</label>
              <input type="number" value={maxStorage} onChange={e => setMaxStorage(e.target.value)} className={s.input} style={{ width: '100%' }} placeholder="∞" />
            </div>
          </div>
          <div className={s.wizardActions}>
            <button className={s.btnSmall} onClick={() => setStep(0)}>Back</button>
            <button className={s.btnPrimary} onClick={handleCreateTenant} disabled={submitting}>
              {submitting ? <><Loader2 size={14} className={s.spinner} /> Creating…</> : <>Create & Continue <ChevronRight size={14} /></>}
            </button>
          </div>
        </>
      )}

      {/* Step 3: Super Admin */}
      {step === 2 && (
        <>
          <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginBottom: 16 }}>
            Create the initial super admin for <strong>{orgName}</strong>. This user will be the primary administrator.
          </p>
          <div className={s.wizardGrid}>
            <div>
              <label className={s.fieldLabelSec}>Full Name *</label>
              <input value={adminFullName} onChange={e => setAdminFullName(e.target.value)} className={s.input} style={{ width: '100%' }} />
            </div>
            <div>
              <label className={s.fieldLabelSec}>Username *</label>
              <input value={adminUsername} onChange={e => setAdminUsername(e.target.value)} className={s.input} style={{ width: '100%' }} />
            </div>
            <div>
              <label className={s.fieldLabelSec}>Email *</label>
              <input type="email" value={adminEmail} onChange={e => setAdminEmail(e.target.value)} className={s.input} style={{ width: '100%' }} />
            </div>
            <div>
              <label className={s.fieldLabelSec}>Temporary Password *</label>
              <input type="password" value={adminPassword} onChange={e => setAdminPassword(e.target.value)} className={s.input} style={{ width: '100%' }} />
            </div>
          </div>
          <div className={s.wizardActions}>
            <button className={s.btnSmall} onClick={() => setStep(3)}>Skip</button>
            <button className={s.btnPrimary} onClick={handleCreateAdmin} disabled={submitting}>
              {submitting ? <><Loader2 size={14} className={s.spinner} /> Creating…</> : <>Create Admin & Continue <ChevronRight size={14} /></>}
            </button>
          </div>
        </>
      )}

      {/* Step 4: Seed Data */}
      {step === 3 && (
        <>
          {!seedDone ? (
            <>
              <p style={{ color: 'var(--text-secondary)', fontSize: 14, marginBottom: 16 }}>
                Optionally seed <strong>{orgName}</strong> with default departments (Engineering, Product, Design, Marketing, Sales, HR, Finance) and leave policies (Annual, Sick, Personal).
              </p>
              <div className={s.wizardActions}>
                <button className={s.btnSmall} onClick={handleFinish}>Skip & Finish</button>
                <button className={s.btnPrimary} onClick={handleSeed} disabled={submitting}>
                  {submitting ? <><Loader2 size={14} className={s.spinner} /> Seeding…</> : <><Sprout size={14} /> Seed Default Data</>}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className={s.successBanner} style={{ marginBottom: 16 }}>
                <span>Seed data applied — {seedResult?.departments || 0} departments, {seedResult?.leave_policies || 0} leave policies created.</span>
              </div>
              <div className={s.wizardActions}>
                <button className={s.btnPrimary} onClick={handleFinish}>
                  <Check size={14} /> View Tenant
                </button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
