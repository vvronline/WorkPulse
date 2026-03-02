import React, { useState } from 'react';
import { useAutoDismiss } from '../hooks/useAutoDismiss';
import { useAuth } from '../AuthContext';
import { updatePassword as changePasswordApi } from '../api';
import PasswordInput from '../components/PasswordInput';
import s from './Auth.module.css';

export default function ChangePassword() {
  const { user, updateUser, logout } = useAuth();
  const [form, setForm] = useState({ current_password: '', new_password: '', confirm_password: '' });
  const [error, setError] = useAutoDismiss('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (form.new_password !== form.confirm_password) {
      return setError('New passwords do not match');
    }
    if (form.new_password.length < 8) {
      return setError('New password must be at least 8 characters');
    }
    if (form.current_password === form.new_password) {
      return setError('New password must be different from current password');
    }
    setLoading(true);
    try {
      await changePasswordApi({ current_password: form.current_password, new_password: form.new_password });
      updateUser({ must_change_password: false });
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to change password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={s['auth-container']}>
      <div className={s['auth-card']}>
        <div className={s['auth-icon']}>🔑</div>
        <h2>Change Your Password</h2>
        <p>Welcome, <strong>{user?.full_name}</strong>! Your account was created by an administrator. Please set a new password to continue.</p>
        {error && <div className="error-msg">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="current-pwd">Current Password</label>
            <PasswordInput
              id="current-pwd"
              value={form.current_password}
              onChange={e => setForm({ ...form, current_password: e.target.value })}
              placeholder="Password given by admin"
              required
            />
          </div>
          <div className="form-group">
            <label htmlFor="new-pwd">New Password</label>
            <PasswordInput
              id="new-pwd"
              value={form.new_password}
              onChange={e => setForm({ ...form, new_password: e.target.value })}
              placeholder="Choose a new password"
              required
              minLength={8}
            />
          </div>
          <div className="form-group">
            <label htmlFor="confirm-pwd">Confirm New Password</label>
            <PasswordInput
              id="confirm-pwd"
              value={form.confirm_password}
              onChange={e => setForm({ ...form, confirm_password: e.target.value })}
              placeholder="Confirm new password"
              required
              minLength={8}
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Updating...' : '→ Set New Password'}
          </button>
        </form>
        <div className={s['auth-switch']}>
          <a href="#" onClick={(e) => { e.preventDefault(); logout(); }}>Sign out</a>
        </div>
      </div>
    </div>
  );
}
