import React, { useState, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../../AuthContext';
import NavLinks from './NavLinks';
import ProfileMenu from './ProfileMenu';
import MobileTabBar from './MobileTabBar';
import NotificationBell from '../notifications/NotificationBell';
import GlobalSearch from '../search/GlobalSearch';
import s from './Navbar.module.css';

export default function Navbar() {
  const { isAuthenticated } = useAuth();
  const [searchOpen, setSearchOpen] = useState(false);

  // Ctrl+K / Cmd+K opens global search from anywhere
  useEffect(() => {
    const handle = (e) => {
      if ((e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setSearchOpen(prev => !prev);
      }
    };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, []);

  if (!isAuthenticated) return null;

  return (
    <>
      <nav className={s.navbar}>
        <NavLink to="/" className={s['navbar-logo']}>
          <div className={s['logo-icon']}>💼</div>
          <h1 className={s.title}>WorkPulse</h1>
        </NavLink>
        <div className={s['navbar-right']}>
          <NavLinks />
          <NotificationBell />
          <button
            className={s.searchBtn}
            onClick={() => setSearchOpen(true)}
            title="Search (Ctrl+K)"
            aria-label="Open global search"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <circle cx="11" cy="11" r="8" stroke="currentColor" strokeWidth="2"/>
              <path d="M21 21l-4.35-4.35" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </button>
          <ProfileMenu />
        </div>
      </nav>

      <MobileTabBar />

      {searchOpen && <GlobalSearch onClose={() => setSearchOpen(false)} />}
    </>
  );
}
