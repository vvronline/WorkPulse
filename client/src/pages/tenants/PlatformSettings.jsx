import React, { useState, useEffect } from 'react';
import {
  getAdminAnnouncements, createAnnouncement, updateAnnouncement, deleteAnnouncement,
  getImpersonationPolicy, updateImpersonationPolicy,
  getPlatformConfig, updatePlatformConfig,
} from '../../api';
import {
  Loader2, X, Megaphone, Trash2, ToggleLeft, ToggleRight, Shield, Save,
  Wrench, Lock, Database,
} from 'lucide-react';
import ConfirmDialog from '../../components/common/ConfirmDialog';
import s from './Tenants.module.css';

/**
 * Platform-level settings panel (platform_admin only).
 *
 * NOTE: SMTP and Platform Branding fieldsets used to live here. They were
 * removed — outbound email transport now lives in env vars
 * (process.env.SMTP_* / GMAIL_*) and is consumed by server/utils/mailer.js,
 * and white-labeling is fully tenant-scoped via the per-tenant Branding
 * page (logo, accent color, email-template overrides under /api/branding).
 */
export default function PlatformSettings() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Announcements
  const [announcements, setAnnouncements] = useState([]);
  const [newMsg, setNewMsg] = useState('');
  const [newType, setNewType] = useState('info');
  const [newDuration, setNewDuration] = useState('');
  const [deleteModal, setDeleteModal] = useState({ open: false, id: null });

  // Impersonation policy
  const [policy, setPolicy] = useState(null);
  const [policyDraft, setPolicyDraft] = useState(null);
  const [policySaving, setPolicySaving] = useState(false);

  // Platform config
  const [config, setConfig] = useState(null);
  const [configDraft, setConfigDraft] = useState(null);
  const [configSaving, setConfigSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      getAdminAnnouncements().then(r => setAnnouncements(Array.isArray(r.data) ? r.data : [])).catch(() => {}),
      getImpersonationPolicy().then(r => { setPolicy(r.data); setPolicyDraft(r.data); }).catch(() => {}),
      getPlatformConfig().then(r => { setConfig(r.data); setConfigDraft(r.data); }).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, []);

  const handleSavePolicy = async () => {
    if (!policyDraft) return;
    setPolicySaving(true); setError(''); setSuccess('');
    try {
      const r = await updateImpersonationPolicy({
        requires_consent: !!policyDraft.requiresConsent,
        break_glass_allowed: !!policyDraft.breakGlassAllowed,
        max_session_minutes: Number(policyDraft.maxSessionMinutes),
        code_ttl_minutes: Number(policyDraft.codeTtlMinutes),
      });
      setPolicy(r.data);
      setPolicyDraft(r.data);
      setSuccess('Impersonation policy updated');
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to update policy');
    } finally { setPolicySaving(false); }
  };

  const policyDirty = policy && policyDraft && (
    policy.requiresConsent !== policyDraft.requiresConsent ||
    policy.breakGlassAllowed !== policyDraft.breakGlassAllowed ||
    Number(policy.maxSessionMinutes) !== Number(policyDraft.maxSessionMinutes) ||
    Number(policy.codeTtlMinutes) !== Number(policyDraft.codeTtlMinutes)
  );

  const handleSaveConfig = async (keys) => {
    setConfigSaving(true); setError(''); setSuccess('');
    try {
      const patch = {};
      for (const k of keys) patch[k] = configDraft[k];
      const r = await updatePlatformConfig(patch);
      setConfig(r.data);
      setConfigDraft(r.data);
      setSuccess('Settings saved');
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to save settings');
    } finally { setConfigSaving(false); }
  };

  const handleCreateAnnouncement = async () => {
    if (!newMsg.trim()) return;
    setError(''); setSuccess('');
    try {
      await createAnnouncement({ message: newMsg.trim(), type: newType, duration: newDuration || null });
      setNewMsg('');
      setNewType('info');
      setNewDuration('');
      const res = await getAdminAnnouncements();
      setAnnouncements(res.data);
      setSuccess('Announcement created');
    } catch (e) {
      setError(e.response?.data?.error || 'Failed');
    }
  };

  const handleToggleAnnouncement = async (ann) => {
    try {
      await updateAnnouncement(ann.id, { is_active: !ann.is_active });
      const res = await getAdminAnnouncements();
      setAnnouncements(res.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed');
    }
  };

  const handleDeleteAnnouncement = async () => {
    const { id } = deleteModal;
    setDeleteModal({ open: false, id: null });
    try {
      await deleteAnnouncement(id);
      const res = await getAdminAnnouncements();
      setAnnouncements(res.data);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed');
    }
  };

  const updateDraft = (key, value) => setConfigDraft(d => ({ ...d, [key]: value }));
  const configChanged = (keys) => config && configDraft && keys.some(k => config[k] !== configDraft[k]);

  if (loading) return <div className={s.loading}><Loader2 size={20} className={s.spinner} /> Loading…</div>;

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

      {/* ─── Maintenance Mode ────────────────────────────────────────── */}
      {configDraft && (
        <fieldset className={s.fieldset} style={{ marginBottom: 20 }}>
          <legend className={s.legend} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Wrench size={14} /> Maintenance Mode
          </legend>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '0 0 12px' }}>
            When enabled, all non-platform-admin users receive a 503 maintenance page.
            Use during deployments, migrations, or emergency fixes.
          </p>

          <label className={s.toggleRow}>
            <input
              type="checkbox"
              checked={configDraft.maintenance_mode === 'true'}
              onChange={e => updateDraft('maintenance_mode', e.target.checked ? 'true' : 'false')}
            />
            <div>
              <strong>Enable maintenance mode</strong>
              <div className={s.toggleHint}>
                All API requests (except login and health) will return 503 for non-platform-admin users.
              </div>
            </div>
          </label>

          <div style={{ marginTop: 12 }}>
            <label className={s.fieldLabel}>Maintenance message</label>
            <textarea
              value={configDraft.maintenance_message}
              onChange={e => updateDraft('maintenance_message', e.target.value)}
              placeholder="The system is currently under maintenance. Please try again later."
              className={s.input}
              rows={2}
              style={{ width: '100%', resize: 'vertical' }}
            />
          </div>

          <button
            className={s.btnPrimary}
            onClick={() => handleSaveConfig(['maintenance_mode', 'maintenance_message'])}
            disabled={!configChanged(['maintenance_mode', 'maintenance_message']) || configSaving}
            style={{ marginTop: 12 }}
          >
            {configSaving ? <Loader2 size={14} className={s.spinner} /> : <Save size={14} />}
            Save
          </button>
        </fieldset>
      )}

      {/* ─── Impersonation Policy ────────────────────────────────────── */}
      {policyDraft && (
        <fieldset className={s.fieldset} style={{ marginBottom: 20 }}>
          <legend className={s.legend} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Shield size={14} /> Impersonation Policy
          </legend>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '0 0 12px' }}>
            Controls how platform admins access tenant workspaces. Tightening these
            settings improves SOC2 / ISO 27001 support-access posture.
          </p>

          <label className={s.toggleRow}>
            <input
              type="checkbox"
              checked={!!policyDraft.requiresConsent}
              onChange={e => setPolicyDraft({ ...policyDraft, requiresConsent: e.target.checked })}
            />
            <div>
              <strong>Require tenant consent</strong>
              <div className={s.toggleHint}>
                When on, platform admins must submit an access request that a tenant super-admin
                approves before they can enter the workspace. Strongly recommended.
              </div>
            </div>
          </label>

          <label className={s.toggleRow}>
            <input
              type="checkbox"
              checked={!!policyDraft.breakGlassAllowed}
              onChange={e => setPolicyDraft({ ...policyDraft, breakGlassAllowed: e.target.checked })}
              disabled={!policyDraft.requiresConsent}
            />
            <div>
              <strong>Allow break-glass access</strong>
              <div className={s.toggleHint}>
                Lets platform admins bypass tenant consent for genuine emergencies. Every
                bypass is heavily audited and notifies the tenant after the fact. Keep off
                unless you have a documented incident-response policy.
              </div>
            </div>
          </label>

          <div className={s.fieldRowWrap} style={{ marginTop: 14 }}>
            <div>
              <label className={s.fieldLabel}>Max session length (minutes)</label>
              <input
                type="number" min="5" max="240"
                value={policyDraft.maxSessionMinutes}
                onChange={e => setPolicyDraft({ ...policyDraft, maxSessionMinutes: e.target.value })}
                className={s.inputSmall}
              />
              <small style={{ color: 'var(--text-muted)', fontSize: 11, display: 'block' }}>5–240 min</small>
            </div>
            <div>
              <label className={s.fieldLabel}>Approval code TTL (minutes)</label>
              <input
                type="number" min="1" max="60"
                value={policyDraft.codeTtlMinutes}
                onChange={e => setPolicyDraft({ ...policyDraft, codeTtlMinutes: e.target.value })}
                className={s.inputSmall}
              />
              <small style={{ color: 'var(--text-muted)', fontSize: 11, display: 'block' }}>How long an approved code stays valid before expiry.</small>
            </div>
            <button
              className={s.btnPrimary}
              onClick={handleSavePolicy}
              disabled={!policyDirty || policySaving}
              style={{ alignSelf: 'flex-end' }}
            >
              {policySaving ? <Loader2 size={14} className={s.spinner} /> : <Save size={14} />}
              Save policy
            </button>
          </div>
        </fieldset>
      )}

      {/* ─── Security Settings ────────────────────────────────────────── */}
      {configDraft && (
        <fieldset className={s.fieldset} style={{ marginBottom: 20 }}>
          <legend className={s.legend} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Lock size={14} /> Security
          </legend>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '0 0 12px' }}>
            Platform-wide password and session policies. Changes apply to all tenants.
          </p>

          <div className={s.fieldRowWrap}>
            <div>
              <label className={s.fieldLabel}>Session timeout (minutes)</label>
              <input
                type="number" min="15" max="1440"
                value={configDraft.session_timeout_minutes}
                onChange={e => updateDraft('session_timeout_minutes', e.target.value)}
                className={s.inputSmall}
              />
              <small style={{ color: 'var(--text-muted)', fontSize: 11, display: 'block' }}>15–1440 min (default: 480)</small>
            </div>
            <div>
              <label className={s.fieldLabel}>Password min length</label>
              <input
                type="number" min="6" max="32"
                value={configDraft.password_min_length}
                onChange={e => updateDraft('password_min_length', e.target.value)}
                className={s.inputSmall}
              />
            </div>
          </div>

          <div style={{ marginTop: 12, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <label className={s.toggleRow} style={{ flex: '0 0 auto' }}>
              <input
                type="checkbox"
                checked={configDraft.password_require_uppercase === 'true'}
                onChange={e => updateDraft('password_require_uppercase', e.target.checked ? 'true' : 'false')}
              />
              <span>Require uppercase</span>
            </label>
            <label className={s.toggleRow} style={{ flex: '0 0 auto' }}>
              <input
                type="checkbox"
                checked={configDraft.password_require_number === 'true'}
                onChange={e => updateDraft('password_require_number', e.target.checked ? 'true' : 'false')}
              />
              <span>Require number</span>
            </label>
            <label className={s.toggleRow} style={{ flex: '0 0 auto' }}>
              <input
                type="checkbox"
                checked={configDraft.password_require_special === 'true'}
                onChange={e => updateDraft('password_require_special', e.target.checked ? 'true' : 'false')}
              />
              <span>Require special character</span>
            </label>
          </div>

          <div style={{ marginTop: 12 }}>
            <label className={s.fieldLabel}>Allowed email domains (comma-separated, leave empty for any)</label>
            <input
              value={configDraft.allowed_email_domains}
              onChange={e => updateDraft('allowed_email_domains', e.target.value)}
              placeholder="e.g. company.com, subsidiary.com"
              className={s.input}
              style={{ width: '100%' }}
            />
            <small style={{ color: 'var(--text-muted)', fontSize: 11 }}>
              When set, only users with emails matching these domains can register.
            </small>
          </div>

          <button
            className={s.btnPrimary}
            onClick={() => handleSaveConfig([
              'session_timeout_minutes', 'password_min_length',
              'password_require_uppercase', 'password_require_number', 'password_require_special',
              'allowed_email_domains',
            ])}
            disabled={!configChanged([
              'session_timeout_minutes', 'password_min_length',
              'password_require_uppercase', 'password_require_number', 'password_require_special',
              'allowed_email_domains',
            ]) || configSaving}
            style={{ marginTop: 14 }}
          >
            {configSaving ? <Loader2 size={14} className={s.spinner} /> : <Save size={14} />}
            Save security settings
          </button>
        </fieldset>
      )}

      {/* ─── Data Retention ────────────────────────────────────────────── */}
      {configDraft && (
        <fieldset className={s.fieldset} style={{ marginBottom: 20 }}>
          <legend className={s.legend} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Database size={14} /> Data Retention
          </legend>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '0 0 12px' }}>
            Control how long various logs and deleted data are retained before cleanup.
          </p>

          <div className={s.fieldRowWrap}>
            <div>
              <label className={s.fieldLabel}>Audit log retention (days)</label>
              <input
                type="number" min="30" max="3650"
                value={configDraft.audit_log_retention_days}
                onChange={e => updateDraft('audit_log_retention_days', e.target.value)}
                className={s.inputSmall}
              />
              <small style={{ color: 'var(--text-muted)', fontSize: 11, display: 'block' }}>Platform and tenant audit logs.</small>
            </div>
            <div>
              <label className={s.fieldLabel}>Deleted tenant cleanup (days)</label>
              <input
                type="number" min="7" max="365"
                value={configDraft.deleted_tenant_cleanup_days}
                onChange={e => updateDraft('deleted_tenant_cleanup_days', e.target.value)}
                className={s.inputSmall}
              />
              <small style={{ color: 'var(--text-muted)', fontSize: 11, display: 'block' }}>Days before soft-deleted tenants are permanently removed.</small>
            </div>
            <div>
              <label className={s.fieldLabel}>Session log retention (days)</label>
              <input
                type="number" min="7" max="365"
                value={configDraft.session_log_retention_days}
                onChange={e => updateDraft('session_log_retention_days', e.target.value)}
                className={s.inputSmall}
              />
              <small style={{ color: 'var(--text-muted)', fontSize: 11, display: 'block' }}>Impersonation session history.</small>
            </div>
          </div>

          <button
            className={s.btnPrimary}
            onClick={() => handleSaveConfig(['audit_log_retention_days', 'deleted_tenant_cleanup_days', 'session_log_retention_days'])}
            disabled={!configChanged(['audit_log_retention_days', 'deleted_tenant_cleanup_days', 'session_log_retention_days']) || configSaving}
            style={{ marginTop: 14 }}
          >
            {configSaving ? <Loader2 size={14} className={s.spinner} /> : <Save size={14} />}
            Save retention policy
          </button>
        </fieldset>
      )}

      {/* ─── Global Announcements ─────────────────────────────────────── */}
      <fieldset className={s.fieldset}>
        <legend className={s.legend}>
          <Megaphone size={14} style={{ marginRight: 6 }} />Global Announcements
        </legend>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '0 0 12px' }}>
          Announcements visible to all tenants across the platform.
        </p>

        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          <input value={newMsg} onChange={e => setNewMsg(e.target.value)} placeholder="Announcement message…"
            className={s.input} style={{ flex: 1, minWidth: 200 }} />
          <select value={newType} onChange={e => setNewType(e.target.value)} className={s.statusSelect} style={{ minWidth: 100 }}>
            <option value="info">Info</option>
            <option value="success">Success</option>
            <option value="warning">Warning</option>
            <option value="urgent">Urgent</option>
          </select>
          <select value={newDuration} onChange={e => setNewDuration(e.target.value)} className={s.statusSelect} style={{ minWidth: 120 }}>
            <option value="">No expiry</option>
            <option value="1">1 hour</option>
            <option value="6">6 hours</option>
            <option value="24">1 day</option>
            <option value="168">1 week</option>
          </select>
          <button className={s.btnPrimary} onClick={handleCreateAnnouncement}>
            <Megaphone size={14} /> Post
          </button>
        </div>

        {announcements.length === 0 ? (
          <div className={s.emptyMsg}>No announcements</div>
        ) : (
          <table className={s.table}>
            <thead>
              <tr><th>Message</th><th>Type</th><th>Active</th><th>Created</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {announcements.map(a => (
                <tr key={a.id}>
                  <td>{a.message}</td>
                  <td><span className={s.badgeRole}>{a.type}</span></td>
                  <td>{a.is_active ? <span className={s.badgeActive}>yes</span> : <span className={s.badgeInactive}>no</span>}</td>
                  <td className={s.cellSecondary}>{new Date(a.created_at).toLocaleDateString()}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button className={s.btnSmall} onClick={() => handleToggleAnnouncement(a)} title={a.is_active ? 'Disable' : 'Enable'}>
                        {a.is_active ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}
                      </button>
                      <button className={s.btnSmall} style={{ color: 'var(--danger)' }} onClick={() => setDeleteModal({ open: true, id: a.id })}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </fieldset>

      <ConfirmDialog
        isOpen={deleteModal.open}
        title="Delete Announcement"
        message="Are you sure you want to delete this announcement?"
        confirmText="Delete"
        cancelText="Cancel"
        isDanger
        onConfirm={handleDeleteAnnouncement}
        onCancel={() => setDeleteModal({ open: false, id: null })}
      />
    </div>
  );
}