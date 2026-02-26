import React, { useState } from 'react';
import { useAuth } from '../AuthContext';
import { updateEmail } from '../api';
import { useAutoDismiss } from '../hooks/useAutoDismiss';
import s from './Auth.module.css';

export default function SetEmail() {
  const { user, updateUser } = useAuth();
  const [email, setEmail] = useState('');
  const [error, setError] = useAutoDismiss('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await updateEmail(email);
      updateUser({ email });
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save email');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={s['auth-container']}>
      <div className={s['auth-card']}>
        <div className={s['auth-icon']}>📧</div>
        <h2>Add Your Email</h2>
        <p>Hi {user?.full_name || user?.username}, an email address is now required for account recovery.</p>

        {error && <div className="error-msg">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Email Address</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="Enter your email address"
              required
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Saving...' : 'Continue'}
          </button>
        </form>
      </div>
    </div>
  );
}
