import React, { useState } from 'react';
import { useAuth } from '../AuthContext';
import { updateProfile, updateEmail, updatePassword, deleteAccount } from '../api';
import PasswordInput from './PasswordInput';
import { useAutoDismiss } from '../hooks/useAutoDismiss';
import s from './EditProfileModal.module.css';

export default function EditProfileModal({ onClose }) {
    const { user, updateUser, logout } = useAuth();

    // Section: profile
    const [fullName, setFullName] = useState(user?.full_name || '');
    const [username, setUsername] = useState(user?.username || '');
    const [profileMsg, setProfileMsg] = useAutoDismiss(null);
    const [profileLoading, setProfileLoading] = useState(false);

    // Section: email
    const [email, setEmail] = useState(user?.email || '');
    const [emailMsg, setEmailMsg] = useAutoDismiss(null);
    const [emailLoading, setEmailLoading] = useState(false);

    // Section: password
    const [curPw, setCurPw] = useState('');
    const [newPw, setNewPw] = useState('');
    const [confirmPw, setConfirmPw] = useState('');
    const [pwMsg, setPwMsg] = useAutoDismiss(null);
    const [pwLoading, setPwLoading] = useState(false);

    // Section: delete
    const [deletePw, setDeletePw] = useState('');
    const [deleteConfirm, setDeleteConfirm] = useState(false);
    const [deleteMsg, setDeleteMsg] = useAutoDismiss(null);
    const [deleteLoading, setDeleteLoading] = useState(false);

    const handleProfileSave = async (e) => {
        e.preventDefault();
        setProfileLoading(true);
        setProfileMsg(null);
        try {
            const { data } = await updateProfile({ full_name: fullName, username });
            updateUser({ full_name: data.full_name, username: data.username });
            setProfileMsg({ ok: true, text: 'Profile updated!' });
        } catch (err) {
            setProfileMsg({ ok: false, text: err.response?.data?.error || 'Failed to update profile' });
        } finally {
            setProfileLoading(false);
        }
    };

    const handleEmailSave = async (e) => {
        e.preventDefault();
        setEmailLoading(true);
        setEmailMsg(null);
        try {
            await updateEmail(email);
            updateUser({ email });
            setEmailMsg({ ok: true, text: 'Email updated!' });
        } catch (err) {
            setEmailMsg({ ok: false, text: err.response?.data?.error || 'Failed to update email' });
        } finally {
            setEmailLoading(false);
        }
    };

    const handlePasswordSave = async (e) => {
        e.preventDefault();
        setPwMsg(null);
        if (newPw !== confirmPw) {
            setPwMsg({ ok: false, text: 'New passwords do not match' });
            return;
        }
        if (newPw.length < 8) {
            setPwMsg({ ok: false, text: 'Password must be at least 8 characters' });
            return;
        }
        setPwLoading(true);
        try {
            const res = await updatePassword({ current_password: curPw, new_password: newPw });
            // Save the fresh token (old tokens are invalidated on password change)
            if (res.data.token) {
                localStorage.setItem('token', res.data.token);
            }
            setCurPw(''); setNewPw(''); setConfirmPw('');
            setPwMsg({ ok: true, text: 'Password changed successfully!' });
        } catch (err) {
            setPwMsg({ ok: false, text: err.response?.data?.error || 'Failed to change password' });
        } finally {
            setPwLoading(false);
        }
    };

    const handleDeleteAccount = async () => {
        if (!deletePw) {
            setDeleteMsg({ ok: false, text: 'Please enter your password to confirm' });
            return;
        }
        setDeleteLoading(true);
        setDeleteMsg(null);
        try {
            await deleteAccount(deletePw);
            logout();
        } catch (err) {
            setDeleteMsg({ ok: false, text: err.response?.data?.error || 'Failed to delete account' });
            setDeleteLoading(false);
        }
    };

    return (
        <div className={s.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
            <div className={s.modal}>
                {/* Header */}
                <div className={s.header}>
                    <h2 className={s.title}>Edit Profile</h2>
                    <button className={s.closeBtn} onClick={onClose} aria-label="Close">✕</button>
                </div>

                <div className={s.body}>
                    {/* ── Name & Username ── */}
                    <section className={s.section}>
                        <h3 className={s.sectionTitle}>👤 Name & Username</h3>
                        <form onSubmit={handleProfileSave} className={s.form}>
                            <div className={s.field}>
                                <label>Full Name</label>
                                <input
                                    type="text"
                                    value={fullName}
                                    onChange={(e) => setFullName(e.target.value)}
                                    placeholder="Your full name"
                                    required
                                />
                            </div>
                            <div className={s.field}>
                                <label>Username</label>
                                <div className={s.inputPrefix}>
                                    <span>@</span>
                                    <input
                                        type="text"
                                        value={username}
                                        onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/\s/g, ''))}
                                        placeholder="username"
                                        required
                                    />
                                </div>
                            </div>
                            {profileMsg && <p className={profileMsg.ok ? s.success : s.error}>{profileMsg.text}</p>}
                            <button type="submit" className={s.saveBtn} disabled={profileLoading}>
                                {profileLoading ? 'Saving…' : 'Save Changes'}
                            </button>
                        </form>
                    </section>

                    <div className={s.divider} />

                    {/* ── Email ── */}
                    <section className={s.section}>
                        <h3 className={s.sectionTitle}>✉️ Email Address</h3>
                        <form onSubmit={handleEmailSave} className={s.form}>
                            <div className={s.field}>
                                <label>Email</label>
                                <input
                                    type="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    placeholder="you@example.com"
                                    required
                                />
                            </div>
                            {emailMsg && <p className={emailMsg.ok ? s.success : s.error}>{emailMsg.text}</p>}
                            <button type="submit" className={s.saveBtn} disabled={emailLoading}>
                                {emailLoading ? 'Saving…' : 'Update Email'}
                            </button>
                        </form>
                    </section>

                    <div className={s.divider} />

                    {/* ── Password ── */}
                    <section className={s.section}>
                        <h3 className={s.sectionTitle}>🔒 Change Password</h3>
                        <form onSubmit={handlePasswordSave} className={s.form}>
                            <div className={s.field}>
                                <label>Current Password</label>
                                <PasswordInput
                                    value={curPw}
                                    onChange={(e) => setCurPw(e.target.value)}
                                    placeholder="Enter current password"
                                    required
                                />
                            </div>
                            <div className={s.field}>
                                <label>New Password</label>
                                <PasswordInput
                                    value={newPw}
                                    onChange={(e) => setNewPw(e.target.value)}
                                    placeholder="Min 8 characters"
                                    required
                                />
                            </div>
                            <div className={s.field}>
                                <label>Confirm New Password</label>
                                <PasswordInput
                                    value={confirmPw}
                                    onChange={(e) => setConfirmPw(e.target.value)}
                                    placeholder="Repeat new password"
                                    required
                                />
                            </div>
                            {pwMsg && <p className={pwMsg.ok ? s.success : s.error}>{pwMsg.text}</p>}
                            <button type="submit" className={s.saveBtn} disabled={pwLoading}>
                                {pwLoading ? 'Saving…' : 'Change Password'}
                            </button>
                        </form>
                    </section>

                    <div className={s.divider} />

                    {/* ── Danger Zone ── */}
                    <section className={`${s.section} ${s.dangerSection}`}>
                        <h3 className={`${s.sectionTitle} ${s.dangerTitle}`}>⚠️ Danger Zone</h3>
                        <p className={s.dangerDesc}>
                            Permanently delete your account and all associated data. This action cannot be undone.
                        </p>
                        {!deleteConfirm ? (
                            <button className={s.dangerBtn} onClick={() => setDeleteConfirm(true)}>
                                Delete My Account
                            </button>
                        ) : (
                            <div className={s.deleteConfirmBox}>
                                <p className={s.deleteConfirmLabel}>Enter your password to confirm deletion:</p>
                                <PasswordInput
                                    value={deletePw}
                                    onChange={(e) => setDeletePw(e.target.value)}
                                    placeholder="Your password"
                                    className={s.deleteInput}
                                />
                                {deleteMsg && <p className={s.error}>{deleteMsg.text}</p>}
                                <div className={s.deleteActions}>
                                    <button
                                        className={s.dangerBtnConfirm}
                                        onClick={handleDeleteAccount}
                                        disabled={deleteLoading}
                                    >
                                        {deleteLoading ? 'Deleting…' : '🗑 Yes, Delete Forever'}
                                    </button>
                                    <button
                                        className={s.cancelBtn}
                                        onClick={() => { setDeleteConfirm(false); setDeletePw(''); setDeleteMsg(null); }}
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        )}
                    </section>
                </div>
            </div>
        </div>
    );
}
