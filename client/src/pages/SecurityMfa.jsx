import React, { useEffect, useState } from 'react';
import { ShieldCheck, KeyRound, Copy, Check, AlertTriangle } from 'lucide-react';
import {
  getMfaStatus, setupMfa, enableMfa, disableMfa, regenerateMfaRecoveryCodes,
} from '../api';
import PasswordInput from '../components/common/PasswordInput';
import { useAutoDismiss } from '../hooks/useAutoDismiss';

/**
 * Security → Two-Factor Authentication (TOTP).
 *
 * - platform_admin: MFA is mandatory; the "disable" control is hidden and the
 *   server rejects disable attempts.
 * - super_admin / hr_admin: MFA is opt-in; enable/disable controls are shown.
 * - other roles: not eligible — a friendly notice is shown.
 */
export default function SecurityMfa({ embedded = false }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useAutoDismiss('');
  const [success, setSuccess] = useAutoDismiss('');

  // Enrollment state.
  const [setupData, setSetupData] = useState(null); // { otpauth_url, qr_data_url, secret }
  const [enableCode, setEnableCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState(null); // shown once
  const [copied, setCopied] = useState(false);

  // Disable state.
  const [disablePassword, setDisablePassword] = useState('');
  const [disableCode, setDisableCode] = useState('');

  // Regenerate state.
  const [regenCode, setRegenCode] = useState('');

  const refresh = async () => {
    try {
      const { data } = await getMfaStatus();
      setStatus(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load MFA status');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  const startSetup = async () => {
    setError(''); setSuccess('');
    try {
      const { data } = await setupMfa();
      setSetupData(data);
      setRecoveryCodes(null);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to start MFA setup');
    }
  };

  const confirmEnable = async (e) => {
    e.preventDefault();
    setError(''); setSuccess('');
    try {
      const { data } = await enableMfa(enableCode);
      setRecoveryCodes(data.recovery_codes);
      setSetupData(null);
      setEnableCode('');
      setSuccess('Two-factor authentication enabled.');
      await refresh();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to enable MFA');
    }
  };

  const doDisable = async (e) => {
    e.preventDefault();
    setError(''); setSuccess('');
    try {
      await disableMfa(disablePassword, disableCode);
      setDisablePassword(''); setDisableCode('');
      setSuccess('Two-factor authentication disabled.');
      await refresh();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to disable MFA');
    }
  };

  const doRegen = async (e) => {
    e.preventDefault();
    setError(''); setSuccess('');
    try {
      const { data } = await regenerateMfaRecoveryCodes(regenCode);
      setRecoveryCodes(data.recovery_codes);
      setRegenCode('');
      setSuccess('New recovery codes generated. Save them now.');
      await refresh();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to regenerate recovery codes');
    }
  };

  const copyCodes = () => {
    if (!recoveryCodes) return;
    navigator.clipboard.writeText(recoveryCodes.join('\n')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  if (loading) return <div style={{ padding: embedded ? 0 : '1.5rem' }}>Loading…</div>;
  if (!status) return <div style={{ padding: embedded ? 0 : '1.5rem' }}>Unable to load MFA settings.</div>;

  const { enabled, required, eligible, recovery_codes_remaining } = status;

  return (
    <div style={embedded ? {} : { maxWidth: 560, margin: '0 auto', padding: '1.5rem' }}>
      {!embedded && (
        <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <ShieldCheck size={22} /> Two-Factor Authentication
        </h2>
      )}

      {error && <div className="error-msg">{error}</div>}
      {success && <div className="success-msg">{success}</div>}

      {!eligible && (
        <div className="info-msg" style={{ marginTop: '1rem' }}>
          Two-factor authentication is not available for your role.
        </div>
      )}

      {eligible && (
        <>
          <p style={{ marginTop: '0.5rem', color: 'var(--text-muted, #888)' }}>
            Status: <strong>{enabled ? 'Enabled' : 'Disabled'}</strong>
            {required && <span> · Mandatory for your role</span>}
            {enabled && <span> · {recovery_codes_remaining} recovery codes remaining</span>}
          </p>

          {/* Recovery codes panel — shown once after enable / regenerate */}
          {recoveryCodes && (
            <div style={{ border: '1px solid #f59e0b', borderRadius: 8, padding: '1rem', margin: '1rem 0', background: 'rgba(245,158,11,0.08)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.5rem' }}>
                <AlertTriangle size={16} color="#f59e0b" />
                <strong>Save your recovery codes</strong>
              </div>
              <p style={{ fontSize: '0.85rem', marginBottom: '0.5rem' }}>
                Each code can be used once if you lose access to your authenticator. They won't be shown again.
              </p>
              <pre style={{ background: 'var(--bg-elevated, #1118)', padding: '0.75rem', borderRadius: 6, fontFamily: 'monospace' }}>
                {recoveryCodes.join('\n')}
              </pre>
              <button type="button" className="btn btn-secondary" onClick={copyCodes}>
                {copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy codes</>}
              </button>
            </div>
          )}

          {/* ENABLE FLOW */}
          {!enabled && !setupData && (
            <button type="button" className="btn btn-primary" onClick={startSetup} style={{ marginTop: '1rem' }}>
              <KeyRound size={16} /> Set up authenticator
            </button>
          )}

          {!enabled && setupData && (
            <form onSubmit={confirmEnable} style={{ marginTop: '1rem' }}>
              <p>Scan this QR code with your authenticator app (Google Authenticator, Authy, 1Password, etc.):</p>
              {setupData.qr_data_url && (
                <img src={setupData.qr_data_url} alt="MFA QR code" style={{ display: 'block', margin: '0.75rem 0' }} />
              )}
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted, #888)' }}>
                Or enter this key manually: <code>{setupData.secret}</code>
              </p>
              <div className="form-group">
                <label htmlFor="mfa-enable-code">Enter the 6-digit code to confirm</label>
                <input
                  id="mfa-enable-code"
                  type="text"
                  inputMode="numeric"
                  value={enableCode}
                  onChange={e => setEnableCode(e.target.value)}
                  placeholder="123456"
                  required
                />
              </div>
              <button type="submit" className="btn btn-primary">Enable</button>
            </form>
          )}

          {/* MANAGE WHEN ENABLED */}
          {enabled && (
            <div style={{ marginTop: '1.5rem' }}>
              <h3>Recovery codes</h3>
              <form onSubmit={doRegen} style={{ marginBottom: '1.5rem' }}>
                <div className="form-group">
                  <label htmlFor="mfa-regen-code">Authenticator code</label>
                  <input
                    id="mfa-regen-code"
                    type="text"
                    inputMode="numeric"
                    value={regenCode}
                    onChange={e => setRegenCode(e.target.value)}
                    placeholder="123456"
                    required
                  />
                </div>
                <button type="submit" className="btn btn-secondary">Regenerate recovery codes</button>
              </form>

              {!required && (
                <>
                  <h3>Disable two-factor authentication</h3>
                  <form onSubmit={doDisable}>
                    <div className="form-group">
                      <label htmlFor="mfa-disable-pw">Password</label>
                      <PasswordInput
                        id="mfa-disable-pw"
                        value={disablePassword}
                        onChange={e => setDisablePassword(e.target.value)}
                        placeholder="Your password"
                        required
                      />
                    </div>
                    <div className="form-group">
                      <label htmlFor="mfa-disable-code">Authenticator or recovery code</label>
                      <input
                        id="mfa-disable-code"
                        type="text"
                        value={disableCode}
                        onChange={e => setDisableCode(e.target.value)}
                        placeholder="123456 or recovery code"
                        required
                      />
                    </div>
                    <button type="submit" className="btn btn-danger">Disable MFA</button>
                  </form>
                </>
              )}

              {required && (
                <div className="info-msg">
                  MFA is mandatory for your role and cannot be disabled.
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}