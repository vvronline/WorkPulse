import React, { useState, useEffect, useCallback } from 'react';
import { getRegistrationSettings, updateRegistrationSettings, getInviteCodes, createInviteCode, deactivateInviteCode } from '../../api';
import { Loader2, Copy, Check, Plus, XCircle } from 'lucide-react';
import s from '../Admin.module.css';

export default function OrgSettings() {
  const [regMode, setRegMode] = useState('open');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Invite codes
  const [codes, setCodes] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [codeForm, setCodeForm] = useState({ role: 'employee', max_uses: '', expires_days: '' });
  const [creating, setCreating] = useState(false);
  const [copiedId, setCopiedId] = useState(null);

  const loadCodes = useCallback(async () => {
    try {
      const res = await getInviteCodes();
      setCodes(Array.isArray(res.data) ? res.data : []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    Promise.all([
      getRegistrationSettings().then(r => setRegMode(r.data?.mode || 'open')).catch(() => {}),
      loadCodes(),
    ]).finally(() => setLoading(false));
  }, [loadCodes]);

  const handleChange = async (mode) => {
    setError(''); setSuccess(''); setSaving(true);
    try {
      await updateRegistrationSettings(mode);
      setRegMode(mode);
      setSuccess('Registration mode updated');
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to update');
    } finally {
      setSaving(false);
    }
  };

  const handleCreateCode = async () => {
    setError(''); setCreating(true);
    try {
      const payload = { role: codeForm.role };
      if (codeForm.max_uses) payload.max_uses = Number(codeForm.max_uses);
      if (codeForm.expires_days) payload.expires_days = Number(codeForm.expires_days);
      const res = await createInviteCode(payload);
      setSuccess(`Invite code created: ${res.data.code}`);
      setShowCreate(false);
      setCodeForm({ role: 'employee', max_uses: '', expires_days: '' });
      await loadCodes();
      // Auto-copy the new code
      try { await navigator.clipboard.writeText(res.data.code); setCopiedId('new'); setTimeout(() => setCopiedId(null), 2000); } catch {}
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to create invite code');
    } finally {
      setCreating(false);
    }
  };

  const handleDeactivate = async (id) => {
    setError('');
    try {
      await deactivateInviteCode(id);
      await loadCodes();
      setSuccess('Invite code deactivated');
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to deactivate');
    }
  };

  const copyCode = async (code, id) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {}
  };

  if (loading) return <div style={{ padding: 24, textAlign: 'center' }}><Loader2 size={20} className={s.spinner} /> Loading…</div>;

  const modes = [
    { value: 'open', label: 'Open', desc: 'Anyone can register and join' },
    { value: 'invite_only', label: 'Invite Only', desc: 'Users need an invite code to register' },
    { value: 'closed', label: 'Closed', desc: 'Registration is disabled' },
  ];

  const activeCodes = codes.filter(c => c.is_active);
  const inactiveCodes = codes.filter(c => !c.is_active);

  return (
    <div>
      {error && <div className={s.error}>{error}</div>}
      {success && <div className={s.success}>{success}</div>}

      <h3 style={{ margin: '0 0 4px' }}>Registration Mode</h3>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '0 0 16px' }}>
        Controls how new users can register for this organization.
      </p>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 32 }}>
        {modes.map(m => (
          <button
            key={m.value}
            disabled={saving}
            onClick={() => handleChange(m.value)}
            style={{
              padding: '10px 20px',
              borderRadius: 8,
              border: regMode === m.value ? '2px solid var(--accent)' : '2px solid var(--border)',
              background: regMode === m.value ? 'var(--accent-light, rgba(59,130,246,0.1))' : 'var(--bg-secondary)',
              color: 'var(--text)',
              cursor: saving ? 'wait' : 'pointer',
              textAlign: 'left',
              minWidth: 140,
              transition: 'border-color 0.15s',
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 14 }}>{m.label}</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{m.desc}</div>
          </button>
        ))}
      </div>

      {/* Invite Codes */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <h3 style={{ margin: '0 0 4px' }}>Invite Codes</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: 0 }}>
            Generate codes for users to register. Share the code or the link.
          </p>
        </div>
        <button className={s.btnPrimary} onClick={() => setShowCreate(v => !v)} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <Plus size={14} /> New Code
        </button>
      </div>

      {showCreate && (
        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 10, padding: 16, marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label style={{ fontSize: 13 }}>
              <span style={{ display: 'block', marginBottom: 4, color: 'var(--text-secondary)' }}>Role</span>
              <select value={codeForm.role} onChange={e => setCodeForm(f => ({ ...f, role: e.target.value }))}
                style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 13 }}>
                <option value="employee">Employee</option>
                <option value="team_lead">Team Lead</option>
                <option value="manager">Manager</option>
                <option value="hr_admin">HR Admin</option>
              </select>
            </label>
            <label style={{ fontSize: 13 }}>
              <span style={{ display: 'block', marginBottom: 4, color: 'var(--text-secondary)' }}>Max Uses (0 = unlimited)</span>
              <input type="number" min="0" value={codeForm.max_uses} onChange={e => setCodeForm(f => ({ ...f, max_uses: e.target.value }))}
                placeholder="0" style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', width: 80, fontSize: 13 }} />
            </label>
            <label style={{ fontSize: 13 }}>
              <span style={{ display: 'block', marginBottom: 4, color: 'var(--text-secondary)' }}>Expires In (days)</span>
              <input type="number" min="1" value={codeForm.expires_days} onChange={e => setCodeForm(f => ({ ...f, expires_days: e.target.value }))}
                placeholder="Never" style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', width: 80, fontSize: 13 }} />
            </label>
            <button className={s.btnPrimary} onClick={handleCreateCode} disabled={creating}
              style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 1 }}>
              {creating ? <Loader2 size={14} className={s.spinner} /> : <Plus size={14} />}
              Generate
            </button>
          </div>
        </div>
      )}

      {activeCodes.length === 0 && inactiveCodes.length === 0 ? (
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, textAlign: 'center', padding: 24 }}>
          No invite codes yet. Click "New Code" to generate one.
        </p>
      ) : (
        <table className={s.table}>
          <thead>
            <tr>
              <th>Code</th>
              <th>Role</th>
              <th>Uses</th>
              <th>Expires</th>
              <th>Created</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {[...activeCodes, ...inactiveCodes].map(c => (
              <tr key={c.id} style={{ opacity: c.is_active ? 1 : 0.5 }}>
                <td>
                  <code style={{ background: 'var(--bg-secondary)', padding: '2px 6px', borderRadius: 4, letterSpacing: 1, fontSize: 13, fontWeight: 600 }}>
                    {c.code}
                  </code>
                </td>
                <td><span className={s.badgeRole} data-role={c.role}>{c.role}</span></td>
                <td style={{ fontSize: 13 }}>{c.use_count || 0}{c.max_uses ? ` / ${c.max_uses}` : ' / ∞'}</td>
                <td style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  {c.expires_at ? new Date(c.expires_at).toLocaleDateString() : '—'}
                </td>
                <td style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                  {c.created_by_name || '—'}<br />
                  <span style={{ fontSize: 11 }}>{new Date(c.created_at).toLocaleDateString()}</span>
                </td>
                <td>
                  {c.is_active
                    ? <span className={s.badgeActive}>Active</span>
                    : <span className={s.badgeInactive}>Inactive</span>}
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {c.is_active && (
                      <>
                        <button className={s.btnSmall} title="Copy code" onClick={() => copyCode(c.code, c.id)}>
                          {copiedId === c.id ? <Check size={13} color="var(--success, #22c55e)" /> : <Copy size={13} />}
                        </button>
                        <button className={s.btnSmall} title="Copy register link"
                          onClick={() => copyCode(`${window.location.origin}/register?invite=${c.code}`, `link-${c.id}`)}>
                          {copiedId === `link-${c.id}` ? <Check size={13} color="var(--success, #22c55e)" /> : '🔗'}
                        </button>
                        <button className={s.btnSmall} title="Deactivate" style={{ color: 'var(--danger, #ef4444)' }}
                          onClick={() => handleDeactivate(c.id)}>
                          <XCircle size={13} />
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
