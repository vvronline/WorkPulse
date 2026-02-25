import React, { useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { resetPassword } from '../api';
import s from './Auth.module.css';

export default function ResetPassword() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [form, setForm] = useState({ password: '', confirm: '' });
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (form.password !== form.confirm) {
      return setError('Passwords do not match');
    }
    if (form.password.length < 4) {
      return setError('Password must be at least 4 characters');
    }

    setLoading(true);
    try {
      const { data } = await resetPassword({ token, password: form.password });
      setSuccess(data.message);
      setTimeout(() => navigate('/login'), 3000);
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
              <label>New Password</label>
              <input
                type="password"
                value={form.password}
                onChange={e => setForm({ ...form, password: e.target.value })}
                placeholder="Enter new password"
                required
                minLength={4}
              />
            </div>
            <div className="form-group">
              <label>Confirm Password</label>
              <input
                type="password"
                value={form.confirm}
                onChange={e => setForm({ ...form, confirm: e.target.value })}
                placeholder="Confirm new password"
                required
                minLength={4}
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
