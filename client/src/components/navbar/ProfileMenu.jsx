import { useState, useRef } from 'react';
import { useAuth } from '../../AuthContext';
import { useTheme } from '../../ThemeContext';
import { useWorkState } from '../../WorkStateContext';
import { useUserStatus } from '../../UserStatusContext';
import { clockOut as apiClockOut, uploadAvatar, removeAvatar, baseURL } from '../../api';
import { Camera, Building2, House } from 'lucide-react';
import EditProfileModal from '../profile/EditProfileModal';
import ConfirmDialog from '../common/ConfirmDialog';
import StatusPicker from '../common/StatusPicker';
import { useClickOutside } from '../../hooks/useClickOutside';
import s from './Navbar.module.css';

export default function ProfileMenu() {
    const { user, logout, updateUser } = useAuth();
    const { theme, toggleTheme } = useTheme();
    const { workState, workMode } = useWorkState();
    const { myStatus } = useUserStatus();

    const [profileOpen, setProfileOpen] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [editModalOpen, setEditModalOpen] = useState(false);
    const [signoutConfirming, setSignoutConfirming] = useState(false);
    const [removeAvatarConfirming, setRemoveAvatarConfirming] = useState(false);

    const profileRef = useRef(null);
    const fileInputRef = useRef(null);

    useClickOutside(profileRef, () => setProfileOpen(false));

    const renderBaseURL = baseURL.endsWith('/api') ? baseURL.slice(0, -4) : baseURL;
    const avatarUrl = user?.avatar
        ? user.avatar.startsWith('http') ? user.avatar : `${renderBaseURL}${user.avatar}`
        : null;
    const initials = user?.full_name
        ? user.full_name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
        : '?';

    const STATUS_DOT_MAP = {
        available: s['dot-online'],
        busy: s['dot-busy'],
        dnd: s['dot-dnd'],
        away: s['dot-away'],
        offline: s['dot-offline'],
        in_call: s['dot-in-call'],
        in_meeting: s['dot-in-meeting'],
    };
    const statusDotClass = STATUS_DOT_MAP[myStatus] || s['dot-offline'];

    const STATUS_META_MAP = {
        available: { label: workState === 'on_floor' ? (workMode === 'remote' ? 'Working Remotely' : 'Working') : 'Available', glyph: 'check' },
        busy: { label: 'Busy', glyph: 'dot' },
        dnd: { label: 'Do Not Disturb', glyph: 'minus' },
        away: { label: 'Away', glyph: 'clock' },
        offline: { label: 'Offline', glyph: 'ring' },
        in_call: { label: 'In a Call', glyph: 'dot' },
        in_meeting: { label: 'In a Meeting', glyph: 'dot' },
    };
    const statusMeta = STATUS_META_MAP[myStatus] || STATUS_META_MAP.available;

    const renderStatusGlyph = (glyph, className) => {
        if (glyph === 'check') {
            return (
                <svg className={className} viewBox="0 0 10 10" fill="none" aria-hidden="true">
                    <path d="M2.1 5.1L4.2 7L7.9 3.3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            );
        }
        if (glyph === 'minus') {
            return (
                <svg className={className} viewBox="0 0 10 10" fill="none" aria-hidden="true">
                    <line x1="2.6" y1="5" x2="7.4" y2="5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                </svg>
            );
        }
        if (glyph === 'clock') {
            return (
                <svg className={className} viewBox="0 0 10 10" fill="none" aria-hidden="true">
                    <circle cx="5" cy="5" r="3.1" stroke="currentColor" strokeWidth="1.3" />
                    <path d="M5 3.2V5.1L6.4 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            );
        }
        if (glyph === 'ring') {
            return (
                <svg className={className} viewBox="0 0 10 10" fill="none" aria-hidden="true">
                    <circle cx="5" cy="5" r="3" stroke="currentColor" strokeWidth="1.5" />
                </svg>
            );
        }
        return <span className={s['status-glyph-dot']} aria-hidden="true" />;
    };

    const handleAvatarUpload = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) {
            alert('File is too large. Maximum size is 5MB.');
            if (fileInputRef.current) fileInputRef.current.value = '';
            return;
        }
        setUploading(true);
        try {
            const { data } = await uploadAvatar(file);
            updateUser({ avatar: data.avatar });
        } catch (err) {
            alert(err.response?.data?.error || 'Avatar upload failed. Please try again.');
        } finally {
            setUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    const confirmRemoveAvatar = async () => {
        try {
            await removeAvatar();
            updateUser({ avatar: null });
        } catch (err) {
            alert(err.response?.data?.error || 'Failed to remove photo. Please try again.');
        } finally {
            setRemoveAvatarConfirming(false);
        }
    };

    const confirmSignOut = async () => {
        if (workState === 'on_floor' || workState === 'on_break') {
            try { await apiClockOut(); } catch { }
        }
        logout();
    };

    return (
        <div className={s['profile-section']} ref={profileRef}>
            <button
                className={s['profile-trigger']}
                onClick={() => setProfileOpen(prev => !prev)}
                aria-expanded={profileOpen}
                aria-haspopup="true"
            >
                <div className={s['profile-avatar-wrapper']}>
                    {avatarUrl
                        ? <img src={avatarUrl} alt="" className={s['profile-avatar-img']} />
                        : <span className={s['profile-avatar-initials']}>{initials}</span>
                    }
                    <span className={`${s['profile-status-dot']} ${statusDotClass}`}>
                        {renderStatusGlyph(statusMeta.glyph, s['status-glyph'])}
                    </span>
                </div>
                <span className={s['profile-name']}>{user?.full_name}</span>
                <svg className={`${s['profile-chevron-icon']} ${profileOpen ? s.open : ''}`} width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            </button>

            {profileOpen && (
                <div className={s['profile-dropdown']}>
                    <div className={s['profile-dropdown-header']}>
                        <div className={s['profile-avatar-lg-wrapper']}>
                            {avatarUrl
                                ? <img src={avatarUrl} alt="" className={s['profile-avatar-lg-img']} />
                                : <span className={s['profile-avatar-lg-initials']}>{initials}</span>
                            }
                            <span className={`${s['profile-avatar-lg-status']} ${statusDotClass}`}>
                                {renderStatusGlyph(statusMeta.glyph, s['status-glyph'])}
                            </span>
                            <button
                                className={s['profile-avatar-edit']}
                                onClick={() => fileInputRef.current?.click()}
                                title="Change photo"
                            >
                                {uploading ? '\u22EF' : <Camera size={13} />}
                            </button>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/*"
                                className="hidden-input"
                                onChange={handleAvatarUpload}
                            />
                        </div>
                        <div className={s['profile-dropdown-info']}>
                            <div className={s['profile-dropdown-name']}>{user?.full_name}</div>
                            <div className={s['profile-dropdown-user']}>@{user?.username}</div>
                            {user?.email && <div className={s['profile-dropdown-email']}>{user.email}</div>}
                            <div className={s['profile-dropdown-badges']}>
                                <span className={`${s['dd-status-badge']} ${s[`status-${myStatus}`] || ''}`}>
                                    <span className={s['dd-status-glyph']}>
                                        {renderStatusGlyph(statusMeta.glyph, s['status-glyph-badge'])}
                                    </span>
                                    {statusMeta.label}
                                </span>
                                {workState !== 'logged_out' && (
                                    <span className={`${s['dd-mode-badge']} ${s[`dd-mode-${workMode}`] || ''}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                                        {workMode === 'office' ? <Building2 size={12} /> : <House size={12} />}
                                        {workMode === 'office' ? 'Office' : 'Remote'}
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className={s['profile-dropdown-status-picker']}>
                        <StatusPicker />
                    </div>

                    <div className={s['profile-dropdown-body']}>
                        <button className={s['profile-dropdown-item']} onClick={() => { setProfileOpen(false); setEditModalOpen(true); }}>
                            <span className={s['dd-item-icon']}>
                                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M11.5 2.5a1.414 1.414 0 012 2L5 13H2v-3L11.5 2.5z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                            </span>
                            Edit Profile
                        </button>
                        {avatarUrl && (
                            <button className={s['profile-dropdown-item']} onClick={() => { setProfileOpen(false); setRemoveAvatarConfirming(true); }}>
                                <span className={s['dd-item-icon']}>
                                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 6h8l-.7 7.3a1 1 0 01-1 .7H5.7a1 1 0 01-1-.7L4 6zM6 6V4a1 1 0 011-1h2a1 1 0 011 1v2M3 6h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                                </span>
                                Remove Photo
                            </button>
                        )}
                        <button className={s['profile-dropdown-item']} onClick={toggleTheme}>
                            <span className={s['dd-item-icon']}>
                                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                                    {theme === 'dark'
                                        ? <><circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.2" /><path d="M8 2v1.5M8 12.5V14M2 8h1.5M12.5 8H14M3.75 3.75l1.06 1.06M11.19 11.19l1.06 1.06M3.75 12.25l1.06-1.06M11.19 4.81l1.06-1.06" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></>
                                        : <path d="M13.36 10.06A6 6 0 015.94 2.64 6 6 0 1013.36 10.06z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                                    }
                                </svg>
                            </span>
                            {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
                        </button>
                        {window.electronAPI && (
                            <button className={s['profile-dropdown-item']} onClick={() => { setProfileOpen(false); window.dispatchEvent(new Event('workpulse-check-update')); }}>
                                <span className={s['dd-item-icon']}>
                                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                                        <path d="M14 8a6 6 0 1 1-4.15-5.7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                                        <polyline points="14 2 14 6 10 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                                    </svg>
                                </span>
                                Check for Updates
                            </button>
                        )}
                    </div>

                    <div className={s['profile-dropdown-divider']} />

                    <button className={s['profile-dropdown-signout']} onClick={() => { setProfileOpen(false); setSignoutConfirming(true); }}>
                        <span className={`${s['dd-item-icon']} ${s['dd-signout-icon']}`}>
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 14H3.33A1.33 1.33 0 012 12.67V3.33A1.33 1.33 0 013.33 2H6M10.67 11.33L14 8l-3.33-3.33M14 8H6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        </span>
                        Sign Out
                    </button>
                </div>
            )}

            {editModalOpen && <EditProfileModal onClose={() => setEditModalOpen(false)} />}

            <ConfirmDialog
                isOpen={signoutConfirming}
                title="Sign Out"
                message="Are you sure you want to sign out?"
                confirmText="Sign Out"
                isDanger
                onConfirm={confirmSignOut}
                onCancel={() => setSignoutConfirming(false)}
            />
            <ConfirmDialog
                isOpen={removeAvatarConfirming}
                title="Remove Photo"
                message="Are you sure you want to remove your profile photo?"
                confirmText="Remove"
                isDanger
                onConfirm={confirmRemoveAvatar}
                onCancel={() => setRemoveAvatarConfirming(false)}
            />
        </div>
    );
}
