import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { register as registerApi, getRegistrationMode } from '../api';
import PasswordInput from '../components/PasswordInput';
import { useAutoDismiss } from '../hooks/useAutoDismiss';
import s from './Auth.module.css';

export default function Register() {
  const { saveAuth } = useAuth();
  const [form, setForm] = useState({ username: '', password: '', full_name: '', email: '', invite_code: '' });
  const [error, setError] = useAutoDismiss('');
  const [loading, setLoading] = useState(false);
  const [regMode, setRegMode] = useState('open');

  useEffect(() => {
    getRegistrationMode().then(r => setRegMode(r.data.mode)).catch(e => console.error(e));
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await registerApi(form);
      saveAuth(data.user);
    } catch (err) {
      setError(err.response?.data?.error || 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  if (regMode === 'closed') {
    return (
      <div className={s['auth-container']}>
        <div className={s['auth-card']}>
          <div className={s['auth-icon']}>🔒</div>
          <h2>Registration Closed</h2>
          <p>New registrations are currently not being accepted. Contact your administrator for access.</p>
          <div className={s['auth-switch']}>
            Already have an account? <Link to="/login">Sign in</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={s['auth-container']}>
      <div className={s['auth-card']}>
        <div className={s['auth-icon']}>💼</div>
        <h2>Create Account</h2>
        <p>Register to get started with WorkPulse</p>
        {error && <div className="error-msg">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="reg-fullname">Full Name</label>
            <input
              id="reg-fullname"
              type="text"
              value={form.full_name}
              onChange={e => setForm({ ...form, full_name: e.target.value })}
              placeholder="Enter your full name"
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="reg-email">Email</label>
            <input
              id="reg-email"
              type="email"
              value={form.email}
              onChange={e => setForm({ ...form, email: e.target.value })}
              placeholder="Enter your email"
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="reg-username">Username</label>
            <input
              id="reg-username"
              type="text"
              value={form.username}
              onChange={e => setForm({ ...form, username: e.target.value })}
              placeholder="Choose a username"
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="reg-password">Password</label>
            <PasswordInput
              id="reg-password"
              value={form.password}
              onChange={e => setForm({ ...form, password: e.target.value })}
              placeholder="Choose a password (min 8 chars)"
              required
              minLength={8}
            />
          </div>
          {regMode === 'invite_only' && (
            <div className="form-group">
              <label htmlFor="reg-invite">Invite Code</label>
              <input
                id="reg-invite"
                type="text"
                value={form.invite_code}
                onChange={e => setForm({ ...form, invite_code: e.target.value.toUpperCase() })}
                placeholder="Enter your invite code"
                required
              />
            </div>
          )}
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Creating...' : 'Create Account'}
          </button>
        </form>
        <div className={s['auth-switch']}>
          Already registered? <Link to="/login">Sign in</Link>
        </div>
      </div>
    </div>
  );
}
