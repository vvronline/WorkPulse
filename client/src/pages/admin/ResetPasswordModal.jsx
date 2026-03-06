import React, { useState } from 'react';
import { useAutoDismiss } from '../../hooks/useAutoDismiss';
import { adminResetPassword } from '../../api';
import s from '../Admin.module.css';
import sf from './AdminForms.module.css';

export default function ResetPasswordModal({ user, onClose, onDone }) {
    const [pw, setPw] = useState('');
    const [error, setError] = useAutoDismiss('');

    const handleReset = async () => {
        if (pw.length < 8) { setError('Password must be at least 8 characters'); return; }
        try {
            const r = await adminResetPassword(user.id, pw);
            onDone(r.data.message);
        } catch (e) { setError(e.response?.data?.error || 'Failed'); }
    };

    return (
        <div className={sf.modalOverlay} onClick={onClose}>
            <div className={sf.modal} onClick={e => e.stopPropagation()}>
                <h2>Reset Password for {user.full_name}</h2>
                {error && <div className={s.error}>{error}</div>}
                <div className={sf.formGroup}>
                    <label>New Password</label>
                    <input type="password" value={pw} onChange={e => setPw(e.target.value)} placeholder="Minimum 8 characters" />
                </div>
                <div className={sf.formActions}>
                    <button className={sf.btnCancel} onClick={onClose}>Cancel</button>
                    <button className={s.btnPrimary} onClick={handleReset}>Reset Password</button>
                </div>
            </div>
        </div>
    );
}
