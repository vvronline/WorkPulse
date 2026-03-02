import React, { useState, useRef, useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { useTheme } from '../ThemeContext';
import { useWorkState } from '../WorkStateContext';
import { clockOut as apiClockOut, uploadAvatar, removeAvatar, baseURL } from '../api';
import EditProfileModal from './EditProfileModal';
import ConfirmDialog from './ConfirmDialog';
import s from './Navbar.module.css';

export default function Navbar() {
  const { user, logout, updateUser } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { workState, workMode } = useWorkState();
  const location = useLocation();
  const [profileOpen, setProfileOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [signoutConfirming, setSignoutConfirming] = useState(false);
  const [removeAvatarConfirming, setRemoveAvatarConfirming] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const profileRef = useRef(null);
  const fileInputRef = useRef(null);
  const moreRef = useRef(null);
  const mobileMoreRef = useRef(null);

  const handleSignOutClick = () => {
    setProfileOpen(false);
    setSignoutConfirming(true);
  };
  const confirmSignOut = async () => {
    try { await apiClockOut(); } catch { }
    logout();
  };

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (profileRef.current && !profileRef.current.contains(e.target)) {
        setProfileOpen(false);
      }
      if (moreRef.current && !moreRef.current.contains(e.target)) {
        setMoreOpen(false);
      }
      if (mobileMoreRef.current && !mobileMoreRef.current.contains(e.target)) {
        setMobileMoreOpen(false);
      }
    };
    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        setProfileOpen(false);
        setMoreOpen(false);
        setMobileMoreOpen(false);
      }
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

  // Compute the correct base URL for static images (stripping /api if present)
  const renderBaseURL = baseURL.endsWith('/api') ? baseURL.slice(0, -4) : baseURL;

  const avatarUrl = user?.avatar
    ? user.avatar.startsWith('http')
      ? user.avatar
      : `${renderBaseURL}${user.avatar}`
    : null;

  const handleAvatarUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Client-side file size check (5MB limit)
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

  const handleRemoveAvatarClick = () => {
    setProfileOpen(false);
    setRemoveAvatarConfirming(true);
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

  // Status dot: always shown — green online, amber away, grey offline
  const statusDotClass = workState === 'on_floor'
    ? s['dot-online']
    : workState === 'on_break'
      ? s['dot-away']
      : s['dot-offline'];

  const statusLabel = workState === 'on_floor'
    ? (workMode === 'remote' ? '🟢 Working Remotely' : '🟢 Online')
    : workState === 'on_break'
      ? '🟡 Away (On Break)'
      : '⚫ Offline';

  // Role-based nav visibility
  const roleLevels = { employee: 1, team_lead: 2, manager: 3, hr_admin: 4, super_admin: 5 };
  const userLevel = roleLevels[user?.role] || 1;
  const isTeamLead = userLevel >= 2 || user?.has_reports;
  const isHR = userLevel >= 4;

  // Collect secondary nav items for "More" dropdown
  const moreItems = [];
  if (user?.org_id) moreItems.push({ to: '/leave-policy', label: 'Leave Policy' });
  if (isTeamLead) moreItems.push({ to: '/manager', label: 'Manager' });
  if (isHR) moreItems.push({ to: '/admin', label: 'Admin' });
  const moreIsActive = moreItems.some(item => location.pathname === item.to);

  return (
    <>
      <nav className={s.navbar}>
        <NavLink to="/" className={s['navbar-logo']}>
          <div className={s['logo-icon']}>💼</div>
          <h1 className={s.title}>WorkPulse</h1>
        </NavLink>
        <div className={s['navbar-right']}>
          {/* Desktop nav links — hidden on mobile via CSS */}
          <div className={`${s['nav-links']} ${s['nav-links-desktop']}`}>
            <NavLink to="/" className={location.pathname === '/' ? s.active : ''}>Dashboard</NavLink>
            <NavLink to="/analytics" className={location.pathname === '/analytics' ? s.active : ''}>Analytics</NavLink>
            <NavLink to="/leaves" className={location.pathname === '/leaves' ? s.active : ''}>Leaves</NavLink>
            <NavLink to="/tasks" className={location.pathname === '/tasks' ? s.active : ''}>Tasks</NavLink>
            <NavLink to="/manual-entry" className={location.pathname === '/manual-entry' ? s.active : ''}>Manual Entry</NavLink>
            {moreItems.length > 0 && (
              <div className={s['more-wrapper']} ref={moreRef}>
                <button
                  className={`${s['more-btn']} ${moreIsActive ? s.active : ''}`}
                  onClick={() => setMoreOpen(prev => !prev)}
                >
                  More
                  <svg className={`${s['more-chevron']} ${moreOpen ? s.open : ''}`} width="10" height="10" viewBox="0 0 12 12" fill="none">
                    <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                {moreOpen && (
                  <div className={s['more-dropdown']}>
                    {moreItems.map(item => (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        className={location.pathname === item.to ? s.active : ''}
                        onClick={() => setMoreOpen(false)}
                      >
                        {item.label}
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

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
                {/* Always show status dot */}
                <span className={`${s['profile-status-dot']} ${statusDotClass}`} />
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
                    {/* Always show status dot on large avatar */}
                    <span className={`${s['profile-avatar-lg-status']} ${statusDotClass}`} />
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
                    {user?.email && (
                      <div className={s['profile-dropdown-email']}>{user.email}</div>
                    )}
                    <div className={s['profile-dropdown-badges']}>
                      <span className={`${s['dd-status-badge']} ${s[workState] || ''}`}>
                        {statusLabel}
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
                  {/* Edit Profile */}
                  <button
                    className={s['profile-dropdown-item']}
                    onClick={() => { setProfileOpen(false); setEditModalOpen(true); }}
                    style={{ animationDelay: '0.02s' }}
                  >
                    <span className={s['dd-item-icon']}>
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                        <path d="M11.5 2.5a1.414 1.414 0 012 2L5 13H2v-3L11.5 2.5z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                    Edit Profile
                  </button>

                  {avatarUrl && (
                    <button className={s['profile-dropdown-item']} onClick={handleRemoveAvatarClick} style={{ animationDelay: '0.04s' }}>
                      <span className={s['dd-item-icon']}>
                        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 6h8l-.7 7.3a1 1 0 01-1 .7H5.7a1 1 0 01-1-.7L4 6zM6 6V4a1 1 0 011-1h2a1 1 0 011 1v2M3 6h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                      </span>
                      Remove Photo
                    </button>
                  )}

                  <button className={s['profile-dropdown-item']} onClick={toggleTheme} style={{ animationDelay: '0.08s' }}>
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
                </div>

                <div className={s['profile-dropdown-divider']} />

                <button className={s['profile-dropdown-signout']} onClick={handleSignOutClick} style={{ animationDelay: '0.12s' }}>
                  <span className={`${s['dd-item-icon']} ${s['dd-signout-icon']}`}>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 14H3.33A1.33 1.33 0 012 12.67V3.33A1.33 1.33 0 013.33 2H6M10.67 11.33L14 8l-3.33-3.33M14 8H6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </span>
                  Sign Out
                </button>
              </div>
            )}
          </div>
        </div>
      </nav>

      {/* Mobile bottom tab bar — outside <nav> to avoid backdrop-filter containment */}
      <div className={s['mobile-tab-bar']}>
        <NavLink to="/" className={location.pathname === '/' ? s.active : ''}>
          <span className={s['nav-icon']}>🏠</span>
          <span className={s['tab-label']}>Home</span>
        </NavLink>
        <NavLink to="/analytics" className={location.pathname === '/analytics' ? s.active : ''}>
          <span className={s['nav-icon']}>📈</span>
          <span className={s['tab-label']}>Stats</span>
        </NavLink>
        <NavLink to="/leaves" className={location.pathname === '/leaves' ? s.active : ''}>
          <span className={s['nav-icon']}>📅</span>
          <span className={s['tab-label']}>Leaves</span>
        </NavLink>
        <NavLink to="/tasks" className={location.pathname === '/tasks' ? s.active : ''}>
          <span className={s['nav-icon']}>✅</span>
          <span className={s['tab-label']}>Tasks</span>
        </NavLink>
        <div className={s['mobile-more-wrapper']} ref={mobileMoreRef}>
          <button
            className={`${s['mobile-more-btn']} ${mobileMoreOpen ? s.active : ''}`}
            onClick={() => setMobileMoreOpen(prev => !prev)}
          >
            <span className={s['nav-icon']}>⋯</span>
            <span className={s['tab-label']}>More</span>
          </button>
          {mobileMoreOpen && (
            <div className={s['mobile-more-popup']}>
              <NavLink to="/manual-entry" onClick={() => setMobileMoreOpen(false)}>
                <span>📝</span> Manual Entry
              </NavLink>
              {isTeamLead && (
                <NavLink to="/manager" onClick={() => setMobileMoreOpen(false)}>
                  <span>👔</span> Manager
                </NavLink>
              )}
              {user?.org_id && (
                <NavLink to="/leave-policy" onClick={() => setMobileMoreOpen(false)}>
                  <span>📋</span> Leave Policy
                </NavLink>
              )}
              {isHR && (
                <NavLink to="/admin" onClick={() => setMobileMoreOpen(false)}>
                  <span>⚙️</span> Admin
                </NavLink>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Edit Profile Modal */}
      {editModalOpen && (
        <EditProfileModal onClose={() => setEditModalOpen(false)} />
      )}

      <ConfirmDialog
        isOpen={signoutConfirming}
        title="Sign Out"
        message="Are you sure you want to sign out?"
        confirmText="Sign Out"
        isDanger={true}
        onConfirm={confirmSignOut}
        onCancel={() => setSignoutConfirming(false)}
      />

      <ConfirmDialog
        isOpen={removeAvatarConfirming}
        title="Remove Photo"
        message="Are you sure you want to remove your profile photo?"
        confirmText="Remove"
        isDanger={true}
        onConfirm={confirmRemoveAvatar}
        onCancel={() => setRemoveAvatarConfirming(false)}
      />
    </>
  );
}
