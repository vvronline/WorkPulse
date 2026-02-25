import React, { useState, useRef, useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { useTheme } from '../ThemeContext';
import { useWorkState } from '../WorkStateContext';
import { clockOut as apiClockOut, uploadAvatar, removeAvatar } from '../api';
import s from './Navbar.module.css';

export default function Navbar() {
  const { user, logout, updateUser } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { workState, workMode } = useWorkState();
  const location = useLocation();
  const [profileOpen, setProfileOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const profileRef = useRef(null);
  const fileInputRef = useRef(null);

  const handleSignOut = async () => {
    try { await apiClockOut(); } catch {}
    logout();
  };

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (profileRef.current && !profileRef.current.contains(e.target)) {
        setProfileOpen(false);
      }
    };
    const handleEscape = (e) => {
      if (e.key === 'Escape') setProfileOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, []);

  const initials = user?.full_name
    ? user.full_name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
    : '?';

  const avatarUrl = user?.avatar || null;

  const handleAvatarUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const { data } = await uploadAvatar(file);
      updateUser({ avatar: data.avatar });
    } catch (err) {
      console.error('Upload failed:', err);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRemoveAvatar = async () => {
    try {
      await removeAvatar();
      updateUser({ avatar: null });
    } catch (err) {
      console.error('Remove failed:', err);
    }
  };

  return (
    <nav className={s.navbar}>
      <div className={s['navbar-logo']}>
        <div className={s['logo-icon']}>💼</div>
        <h1 className={s.title}>WorkPulse</h1>
      </div>
      <div className={s['navbar-right']}>
        <div className={s['nav-links']}>
          <NavLink to="/" className={location.pathname === '/' ? s.active : ''}>
            Dashboard
          </NavLink>
          <NavLink to="/analytics" className={location.pathname === '/analytics' ? s.active : ''}>
            Analytics
          </NavLink>
          <NavLink to="/leaves" className={location.pathname === '/leaves' ? s.active : ''}>
            Leaves
          </NavLink>
          <NavLink to="/tasks" className={location.pathname === '/tasks' ? s.active : ''}>
            Tasks
          </NavLink>
          <NavLink to="/manual-entry" className={location.pathname === '/manual-entry' ? s.active : ''}>
            Manual Entry
          </NavLink>
        </div>

        <div className={s['profile-section']} ref={profileRef}>
          <button
            className={s['profile-trigger']}
            onClick={() => setProfileOpen(prev => !prev)}
          >
            <div className={s['profile-avatar-wrapper']}>
              {avatarUrl
                ? <img src={avatarUrl} alt="" className={s['profile-avatar-img']} />
                : <span className={s['profile-avatar-initials']}>{initials}</span>
              }
              {workState !== 'logged_out' && (
                <span className={`${s['profile-status-dot']} ${workState === 'on_break' ? s['on-break'] : ''}`} />
              )}
            </div>
            <span className={s['profile-name']}>{user?.full_name}</span>
            <svg className={`${s['profile-chevron-icon']} ${profileOpen ? s.open : ''}`} width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
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
                  {workState !== 'logged_out' && (
                    <span className={`${s['profile-avatar-lg-status']} ${workState === 'on_break' ? s['on-break'] : ''}`} />
                  )}
                  <button
                    className={s['profile-avatar-edit']}
                    onClick={() => fileInputRef.current?.click()}
                    title="Change photo"
                  >
                    {uploading ? '⏳' : '📷'}
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
                  <div className={s['profile-dropdown-badges']}>
                    <span className={`${s['dd-status-badge']} ${s[workState] || ''}`}>
                      {workState === 'on_floor' ? (workMode === 'remote' ? '🟢 Working' : '🟢 On Floor') : workState === 'on_break' ? '🟡 On Break' : '⚪ Logged Out'}
                    </span>
                    {workState !== 'logged_out' && (
                      <span className={`${s['dd-mode-badge']} ${s[`dd-mode-${workMode}`] || ''}`}>
                        {workMode === 'office' ? '🏢 Office' : '🏠 Remote'}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className={s['profile-dropdown-body']}>
                {avatarUrl && (
                  <button className={s['profile-dropdown-item']} onClick={handleRemoveAvatar} style={{ animationDelay: '0.04s' }}>
                    <span className={s['dd-item-icon']}>
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 6h8l-.7 7.3a1 1 0 01-1 .7H5.7a1 1 0 01-1-.7L4 6zM6 6V4a1 1 0 011-1h2a1 1 0 011 1v2M3 6h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                    </span>
                    Remove Photo
                  </button>
                )}

                <button className={s['profile-dropdown-item']} onClick={toggleTheme} style={{ animationDelay: '0.08s' }}>
                  <span className={s['dd-item-icon']}>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      {theme === 'dark'
                        ? <><circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.2"/><path d="M8 2v1.5M8 12.5V14M2 8h1.5M12.5 8H14M3.75 3.75l1.06 1.06M11.19 11.19l1.06 1.06M3.75 12.25l1.06-1.06M11.19 4.81l1.06-1.06" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></>
                        : <path d="M13.36 10.06A6 6 0 015.94 2.64 6 6 0 1013.36 10.06z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                      }
                    </svg>
                  </span>
                  {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
                </button>
              </div>

              <div className={s['profile-dropdown-divider']} />

              <button className={s['profile-dropdown-signout']} onClick={handleSignOut} style={{ animationDelay: '0.12s' }}>
                <span className={`${s['dd-item-icon']} ${s['dd-signout-icon']}`}>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 14H3.33A1.33 1.33 0 012 12.67V3.33A1.33 1.33 0 013.33 2H6M10.67 11.33L14 8l-3.33-3.33M14 8H6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </span>
                Sign Out
              </button>
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
