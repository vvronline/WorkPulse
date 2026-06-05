import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { useBranding } from '../BrandingContext';
import { login as loginApi, serverURL } from '../api';
import { ShieldCheck, ArrowRight } from 'lucide-react';
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
      saveAuth(data.user);
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed');
    } finally {
      setLoading(false);
    }
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
      </div>
    </div>
  );
}