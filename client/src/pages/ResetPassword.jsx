import React, { useState, useEffect, useRef } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { resetPassword } from '../api';
import PasswordInput from '../components/PasswordInput';
import { useAutoDismiss } from '../hooks/useAutoDismiss';
import s from './Auth.module.css';

export default function ResetPassword() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [form, setForm] = useState({ password: '', confirm: '' });
  const [error, setError] = useAutoDismiss('');
  const [success, setSuccess] = useAutoDismiss('');
  const [loading, setLoading] = useState(false);
  const redirectTimerRef = useRef(null);

  // Cleanup redirect timer on unmount
  useEffect(() => {
    return () => {
      if (redirectTimerRef.current) clearTimeout(redirectTimerRef.current);
    };
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (form.password !== form.confirm) {
      return setError('Passwords do not match');
    }
    if (form.password.length < 8) {
      return setError('Password must be at least 8 characters');
    }

    setLoading(true);
    try {
      const { data } = await resetPassword({ token, password: form.password });
      setSuccess(data.message);
      redirectTimerRef.current = setTimeout(() => navigate('/login'), 3000);
    } catch (err) {
      setError(err.response?.data?.error || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={s['auth-container']}>
      <div className={s['auth-card']}>
        <div className={s['auth-icon']}>🔒</div>
        <h2>Reset Password</h2>
        <p>Enter your new password below</p>

        {error && <div className="error-msg">{error}</div>}
        {success && <div className={s['success-msg']}>{success}</div>}

        {!success ? (
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label htmlFor="reset-password">New Password</label>
              <PasswordInput
                id="reset-password"
                value={form.password}
                onChange={e => setForm({ ...form, password: e.target.value })}
                placeholder="Enter new password (min 8 chars)"
                required
                minLength={8}
              />
            </div>
            <div className="form-group">
              <label htmlFor="reset-confirm">Confirm Password</label>
              <PasswordInput
                id="reset-confirm"
                value={form.confirm}
                onChange={e => setForm({ ...form, confirm: e.target.value })}
                placeholder="Confirm new password"
                required
                minLength={8}
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? 'Resetting...' : 'Reset Password'}
            </button>
          </form>
        ) : (
          <div className={s['reset-sent']}>
            <div className={s['reset-sent-icon']}>✅</div>
            <p>{success}</p>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Redirecting to login...</p>
          </div>
        )}

        <div className={s['auth-switch']}>
          <Link to="/login">← Back to Sign in</Link>
        </div>
      </div>
    </div>
  );
}
