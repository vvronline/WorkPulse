import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { useBranding } from '../BrandingContext';
import { login as loginApi, verifyMfaLogin, setupMfaEnroll, confirmMfaEnroll, serverURL } from '../api';
import { ShieldCheck, ArrowRight, KeyRound, Copy, Check } from 'lucide-react';
import PasswordInput from '../components/common/PasswordInput';
import { useAutoDismiss } from '../hooks/useAutoDismiss';
import s from './Auth.module.css';

export default function Login() {
  const { saveAuth } = useAuth();
  const { branding } = useBranding();
  const location = useLocation();
  const [form, setForm] = useState({ username: '', password: '' });
  const [error, setError] = useAutoDismiss('');
  const [loading, setLoading] = useState(false);

  // MFA second-step state.
  // step: 'credentials' | 'mfa' | 'mfa_setup' | 'mfa_recovery'
  const [step, setStep] = useState('credentials');
  const [mfaToken, setMfaToken] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  // Inline mandatory-enrollment state.
  const [setupData, setSetupData] = useState(null); // { otpauth_url, qr_data_url, secret }
  const [recoveryCodes, setRecoveryCodes] = useState(null);
  const [pendingUser, setPendingUser] = useState(null);
  const [copied, setCopied] = useState(false);

  const slug = new URLSearchParams(window.location.search).get('org') || '';
  const logoSrc = branding?.logo_url
    ? `${serverURL}/api/public/branding/logo${slug ? `?slug=${slug}` : ''}`
    : null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await loginApi(form);
      if (data.mfa_setup_required) {
        // Mandatory MFA but not enrolled — start inline enrollment.
        setMfaToken(data.mfa_token);
        setStep('mfa_setup');
        try {
          const { data: s } = await setupMfaEnroll(data.mfa_token);
          setSetupData(s);
        } catch (err) {
          setError(err.response?.data?.error || 'Failed to start MFA setup');
        }
        return;
      }
      if (data.mfa_required) {
        setMfaToken(data.mfa_token);
        setStep('mfa');
        return;
      }
      saveAuth(data.user);
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const handleMfaSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await verifyMfaLogin({ mfa_token: mfaToken, code: mfaCode });
      saveAuth(data.user);
    } catch (err) {
      setError(err.response?.data?.error || 'Verification failed');
    } finally {
      setLoading(false);
    }
  };

  const handleEnrollSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await confirmMfaEnroll(mfaToken, mfaCode);
      // Session is now issued. Show the recovery codes once before entering.
      if (data.recovery_codes && data.recovery_codes.length) {
        setRecoveryCodes(data.recovery_codes);
        setPendingUser(data.user);
        setStep('mfa_recovery');
      } else {
        saveAuth(data.user);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to enable MFA');
    } finally {
      setLoading(false);
    }
  };

  const copyCodes = () => {
    if (!recoveryCodes) return;
    navigator.clipboard.writeText(recoveryCodes.join('\n')).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className={s['auth-container']}>
      <div className={s['auth-card']}>

        {logoSrc
          ? <img src={logoSrc} alt="Organization" className={s['auth-logo']} />
          : <div className={s['auth-icon']}><ShieldCheck size={28} strokeWidth={1.5} /></div>
        }
        <h2>Welcome Back</h2>
        <p>Sign in to {branding?.org_name || 'WorkPulse'}</p>
        {location.state?.message && <div className="success-msg">{location.state.message}</div>}
        {error && <div className="error-msg">{error}</div>}

        {step === 'credentials' && (
          <>
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label htmlFor="login-username">Username</label>
                <input
                  id="login-username"
                  type="text"
                  value={form.username}
                  onChange={e => setForm({ ...form, username: e.target.value })}
                  placeholder="Enter your username"
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="login-password">Password</label>
                <PasswordInput
                  id="login-password"
                  value={form.password}
                  onChange={e => setForm({ ...form, password: e.target.value })}
                  placeholder="Enter your password"
                  required
                />
              </div>
              <div className={s['auth-forgot']}>
                <Link to="/forgot-password">Forgot password?</Link>
              </div>
              <button type="submit" className="btn btn-primary btn-fullwidth" disabled={loading}>
                {loading ? 'Signing in...' : <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>Sign In <ArrowRight size={16} /></span>}
              </button>
            </form>
            <div className={s['auth-switch']}>
              Don't have an account? <Link to="/register">Register</Link>
            </div>
          </>
        )}

        {step === 'mfa' && (
          <form onSubmit={handleMfaSubmit}>
            <p style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', justifyContent: 'center' }}>
              <KeyRound size={16} /> Two-factor authentication
            </p>
            <div className="form-group">
              <label htmlFor="mfa-code">Authenticator code</label>
              <input
                id="mfa-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={mfaCode}
                onChange={e => setMfaCode(e.target.value)}
                placeholder="123456 or recovery code"
                autoFocus
                required
              />
            </div>
            <button type="submit" className="btn btn-primary btn-fullwidth" disabled={loading}>
              {loading ? 'Verifying...' : 'Verify'}
            </button>
            <div className={s['auth-switch']}>
              <button type="button" className="btn btn-link" onClick={() => { setStep('credentials'); setMfaCode(''); setMfaToken(''); }}>
                Back to sign in
              </button>
            </div>
          </form>
        )}

        {step === 'mfa_setup' && (
          <form onSubmit={handleEnrollSubmit}>
            <p style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', justifyContent: 'center' }}>
              <ShieldCheck size={16} /> Set up two-factor authentication
            </p>
            <p style={{ fontSize: '0.85rem', textAlign: 'center', color: 'var(--text-muted, #888)' }}>
              MFA is mandatory for your account. Scan the QR code with an authenticator
              app (Google Authenticator, Authy, 1Password…), then enter the 6-digit code.
            </p>
            {setupData?.qr_data_url
              ? <img src={setupData.qr_data_url} alt="MFA QR code" style={{ display: 'block', margin: '0.75rem auto' }} />
              : <div style={{ textAlign: 'center', margin: '1rem 0' }}>Generating QR…</div>
            }
            {setupData?.secret && (
              <p style={{ fontSize: '0.75rem', textAlign: 'center', color: 'var(--text-muted, #888)' }}>
                Manual key: <code>{setupData.secret}</code>
              </p>
            )}
            <div className="form-group">
              <label htmlFor="mfa-enroll-code">Authenticator code</label>
              <input
                id="mfa-enroll-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={mfaCode}
                onChange={e => setMfaCode(e.target.value)}
                placeholder="123456"
                autoFocus
                required
              />
            </div>
            <button type="submit" className="btn btn-primary btn-fullwidth" disabled={loading || !setupData}>
              {loading ? 'Enabling…' : 'Enable & sign in'}
            </button>
            <div className={s['auth-switch']}>
              <button type="button" className="btn btn-link" onClick={() => { setStep('credentials'); setMfaCode(''); setMfaToken(''); setSetupData(null); }}>
                Back to sign in
              </button>
            </div>
          </form>
        )}

        {step === 'mfa_recovery' && (
          <div>
            <p style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', justifyContent: 'center' }}>
              <ShieldCheck size={16} /> Save your recovery codes
            </p>
            <p style={{ fontSize: '0.85rem', textAlign: 'center', color: 'var(--text-muted, #888)' }}>
              Each code can be used once if you lose access to your authenticator.
              They won't be shown again.
            </p>
            <pre style={{ background: 'var(--bg-elevated, #1118)', padding: '0.75rem', borderRadius: 6, fontFamily: 'monospace', textAlign: 'center' }}>
              {recoveryCodes && recoveryCodes.join('\n')}
            </pre>
            <button type="button" className="btn btn-secondary btn-fullwidth" onClick={copyCodes} style={{ marginBottom: '0.5rem' }}>
              {copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy codes</>}
            </button>
            <button type="button" className="btn btn-primary btn-fullwidth" onClick={() => saveAuth(pendingUser)}>
              I've saved them — continue
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
