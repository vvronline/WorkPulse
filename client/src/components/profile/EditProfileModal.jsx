import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import { X, User, Mail, Lock, AlertTriangle, Trash2 } from 'lucide-react';
import { useAuth } from '../../AuthContext';
import { updateProfile, updateEmail, updatePassword, deleteAccount } from '../../api';
import PasswordInput from '../common/PasswordInput';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import s from './EditProfileModal.module.css';

export default function EditProfileModal({ onClose }) {
    const { user, updateUser, logout } = useAuth();
    const modalRef = useRef(null);

    // Focus trap and Escape key handler
    useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.key === 'Escape') {
                onClose();
                return;
            }
            if (e.key === 'Tab') {
                const focusable = modalRef.current?.querySelectorAll(
                    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
                );
                if (!focusable || focusable.length === 0) return;
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (e.shiftKey) {
                    if (document.activeElement === first) {
                        e.preventDefault();
                        last.focus();
                    }
                } else {
                    if (document.activeElement === last) {
                        e.preventDefault();
                        first.focus();
                    }
                }
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [onClose]);

    // Section: profile
    const [fullName, setFullName] = useState(user?.full_name || '');
    const [username, setUsername] = useState(user?.username || '');
    const profileAction = useAsyncAction();

    // Section: email
    const [email, setEmail] = useState(user?.email || '');
    const emailAction = useAsyncAction();

    // Section: password
    const [curPw, setCurPw] = useState('');
    const [newPw, setNewPw] = useState('');
    const [confirmPw, setConfirmPw] = useState('');
    const pwAction = useAsyncAction();

    // Section: delete
    const [deletePw, setDeletePw] = useState('');
    const [deleteConfirm, setDeleteConfirm] = useState(false);
    const deleteAction = useAsyncAction();

    const handleProfileSave = (e) => {
        e.preventDefault();
        profileAction.run(async () => {
            const { data } = await updateProfile({ full_name: fullName, username });
            updateUser({ full_name: data.full_name, username: data.username });
            return 'Profile updated!';
        });
    };

    const handleEmailSave = (e) => {
        e.preventDefault();
        emailAction.run(async () => {
            await updateEmail(email);
            updateUser({ email });
            return 'Email updated!';
        });
    };

    const handlePasswordSave = (e) => {
        e.preventDefault();
        if (newPw !== confirmPw) {
            pwAction.run(async () => { throw { response: { data: { error: 'New passwords do not match' } } }; });
            return;
        }
        if (newPw.length < 8) {
            pwAction.run(async () => { throw { response: { data: { error: 'Password must be at least 8 characters' } } }; });
            return;
        }
        pwAction.run(async () => {
            await updatePassword({ current_password: curPw, new_password: newPw });
            setCurPw(''); setNewPw(''); setConfirmPw('');
            return 'Password changed successfully!';
        });
    };

    const handleDeleteAccount = () => {
        if (!deletePw) {
            deleteAction.run(async () => { throw { response: { data: { error: 'Please enter your password to confirm' } } }; });
            return;
        }
        deleteAction.run(async () => {
            await deleteAccount(deletePw);
            logout();
        });
    };

    return ReactDOM.createPortal(
        <div className={s.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
            <div className={s.modal} ref={modalRef} role="dialog" aria-modal="true" aria-labelledby="edit-profile-title">
                {/* Header */}
                <div className={s.header}>
                    <h2 className={s.title} id="edit-profile-title">Edit Profile</h2>
                    <button className={s.closeBtn} onClick={onClose} aria-label="Close"><X size={16} /></button>
                </div>

                <div className={s.body}>
                    {/* ── Name & Username ── */}
                    <section className={s.section}>
                        <h3 className={s.sectionTitle}><User size={15} style={{verticalAlign:'middle',marginRight:6}} />Name & Username</h3>
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
                            {profileAction.msg && <p className={profileAction.msg.ok ? s.success : s.error}>{profileAction.msg.text}</p>}
                            <button type="submit" className={s.saveBtn} disabled={profileAction.loading}>
                                {profileAction.loading ? 'Saving…' : 'Save Changes'}
                            </button>
                        </form>
                    </section>

                    <div className={s.divider} />

                    {/* ── Email ── */}
                    <section className={s.section}>
                        <h3 className={s.sectionTitle}><Mail size={15} style={{verticalAlign:'middle',marginRight:6}} />Email Address</h3>
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
                            {emailAction.msg && <p className={emailAction.msg.ok ? s.success : s.error}>{emailAction.msg.text}</p>}
                            <button type="submit" className={s.saveBtn} disabled={emailAction.loading}>
                                {emailAction.loading ? 'Saving…' : 'Update Email'}
                            </button>
                        </form>
                    </section>

                    <div className={s.divider} />

                    {/* ── Password ── */}
                    <section className={s.section}>
                        <h3 className={s.sectionTitle}><Lock size={15} style={{verticalAlign:'middle',marginRight:6}} />Change Password</h3>
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
                            {pwAction.msg && <p className={pwAction.msg.ok ? s.success : s.error}>{pwAction.msg.text}</p>}
                            <button type="submit" className={s.saveBtn} disabled={pwAction.loading}>
                                {pwAction.loading ? 'Saving…' : 'Change Password'}
                            </button>
                        </form>
                    </section>

                    <div className={s.divider} />

                    {/* ── Danger Zone ── */}
                    <section className={`${s.section} ${s.dangerSection}`}>
                        <h3 className={`${s.sectionTitle} ${s.dangerTitle}`}><AlertTriangle size={15} style={{verticalAlign:'middle',marginRight:6}} />Danger Zone</h3>
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
                                {deleteAction.msg && <p className={s.error}>{deleteAction.msg.text}</p>}
                                <div className={s.deleteActions}>
                                    <button
                                        className={s.dangerBtnConfirm}
                                        onClick={handleDeleteAccount}
                                        disabled={deleteAction.loading}
                                    >
                                        {deleteAction.loading ? 'Deleting…' : <><Trash2 size={14} style={{marginRight:5,verticalAlign:'middle'}} />Yes, Delete Forever</>}
                                    </button>
                                    <button
                                        className={s.cancelBtn}
                                        onClick={() => { setDeleteConfirm(false); setDeletePw(''); }}
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        )}
                    </section>
                </div>
            </div>
        </div>,
        document.body
    );
}
