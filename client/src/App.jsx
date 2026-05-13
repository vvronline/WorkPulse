import React, { Suspense, lazy, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './AuthContext';
import { ROLE_LEVEL } from './constants';
import { ThemeProvider } from './ThemeContext';
import { WorkStateProvider } from './WorkStateContext';
import Login from './pages/Login';
import Register from './pages/Register';
import ChangePassword from './pages/ChangePassword';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import Navbar from './components/navbar/Navbar';
import AxiosInterceptor from './components/common/AxiosInterceptor';
import ErrorBoundary from './components/common/ErrorBoundary';
import { ToastProvider } from './components/common/Toast';
import { ChatProvider } from './ChatContext';
import { CallProvider } from './CallContext';
import { MeetingProvider } from './MeetingContext';
import { UserStatusProvider } from './UserStatusContext';
import { NotificationPrefsProvider } from './NotificationPrefsContext';
import { AgileConfigProvider } from './AgileConfigContext';
import { RoleLabelsProvider } from './RoleLabelsContext';
import { BrandingProvider } from './BrandingContext';
import MeetingPiP from './components/meeting/MeetingPiP';
import GlobalIncomingCall from './components/notifications/GlobalIncomingCall';
import GlobalMeetingNotification from './components/notifications/GlobalMeetingNotification';
import PageSkeleton from './components/common/PageSkeleton';
import ImpersonationBanner from './components/common/ImpersonationBanner';
import ElectronTitleBar from './components/common/ElectronTitleBar';
import UpdateNotification from './components/common/UpdateNotification';
import ScreenPicker from './components/common/ScreenPicker';
import KeepAlive from './components/common/KeepAlive';

// Lazy-load pages that are NOT part of keep-alive (meetings use dynamic params)
const MeetingJoin = lazy(() => import('./pages/MeetingJoin'));
const MeetingRoom = lazy(() => import('./pages/MeetingRoom'));
const SprintInsights = lazy(() => import('./pages/SprintInsights'));
const PublicNote = lazy(() => import('./pages/PublicNote'));

function ProtectedRoute({ children, minRole }) {
  const { isAuthenticated, user } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" />;
  // Force password change before accessing any route
  if (user?.must_change_password) return <Navigate to="/change-password" />;
  if (minRole) {
    // Allow manager route if user has direct reports (even if role < team_lead)
    if (minRole === 'team_lead' && user?.has_reports) return children;
    if ((ROLE_LEVEL[user?.role] || 1) < (ROLE_LEVEL[minRole] || 1)) return <Navigate to="/" />;
  }
  return children;
}

function PublicRoute({ children }) {
  const { isAuthenticated } = useAuth();
  return !isAuthenticated ? children : <Navigate to="/" />;
}

function KeepAliveRoutes() {
  const { pathname } = useLocation();

  // Keep-alive paths that map to static protected pages
  const KEEP_ALIVE_PATHS = [
    '/', '/attendance', '/tasks',
    '/calendar', '/notes', '/chat', '/admin', '/manager',
    '/organization', '/set-email', '/tenants',
    // Legacy redirect paths — must stay in this list so KeepAlive remains mounted
    // during the brief redirect transition; without it Chat unmounts and resets
    // call state / closes the WebSocket, breaking in-progress calls.
    '/leaves', '/analytics', '/manual-entry', '/leave-policy',
  ];

  const isKeepAlivePath = KEEP_ALIVE_PATHS.includes(pathname);

  return isKeepAlivePath ? <KeepAlive /> : null;
}

function AppRoutes() {
  const { isAuthenticated } = useAuth();
  const location = useLocation();

  return (
    <div className="app">
      <ErrorBoundary resetKey={location.pathname}>
      {isAuthenticated && <ImpersonationBanner />}
      {!isAuthenticated && <ElectronTitleBar />}
      {isAuthenticated && !location.pathname.match(/^\/meeting\/[^/]+\/room/) && <Navbar />}
      <UpdateNotification />
      <ScreenPicker />

      {/* Keep-alive pages: stay mounted across navigations */}
      {isAuthenticated && <KeepAliveRoutes />}

      {/* Non-keep-alive routes: public pages + dynamic param pages */}
      <Suspense fallback={<PageSkeleton />}>
        <Routes>
          <Route path="/login" element={<PublicRoute><Login /></PublicRoute>} />
          <Route path="/register" element={<PublicRoute><Register /></PublicRoute>} />
          <Route path="/change-password" element={isAuthenticated ? <ChangePassword /> : <Navigate to="/login" />} />
          <Route path="/forgot-password" element={<PublicRoute><ForgotPassword /></PublicRoute>} />
          <Route path="/reset-password/:token" element={<PublicRoute><ResetPassword /></PublicRoute>} />
          <Route path="/meeting/:code" element={<ProtectedRoute><MeetingJoin /></ProtectedRoute>} />
          <Route path="/meeting/:code/room" element={<ProtectedRoute><MeetingRoom /></ProtectedRoute>} />
          {/* Agile config is now ONLY editable from inside the admin panel
              (Admin → Structure → Agile Config). The standalone /agile-settings
              route redirects any non-admin to the tasks page; admins get
              forwarded to the equivalent admin section so there's a single
              entry point. */}
          <Route
            path="/agile-settings"
            element={
              <ProtectedRoute minRole="hr_admin">
                <Navigate to="/admin?tab=agile" replace />
              </ProtectedRoute>
            }
          />
          <Route path="/sprint-insights" element={<ProtectedRoute><SprintInsights /></ProtectedRoute>} />
          {/* Public read-only note viewer (no auth, no navbar). */}
          <Route path="/n/:token" element={<PublicNote />} />
          {/* Legacy redirects — old standalone pages now live under /attendance */}
          <Route path="/leaves" element={<Navigate to="/attendance#leaves" replace />} />
          <Route path="/manual-entry" element={<Navigate to="/attendance#manual-entry" replace />} />
          <Route path="/analytics" element={<Navigate to="/attendance#analytics" replace />} />
          {/* Leave Policy was merged into the Leaves tab (Policies/Holidays sub-tabs) */}
          <Route path="/leave-policy" element={<Navigate to="/attendance#leaves" replace />} />
          <Route path="*" element={isAuthenticated ? null : <Navigate to="/login" />} />
        </Routes>
      </Suspense>
      </ErrorBoundary>
    </div>
  );
}

export default function App() {
  useEffect(() => {
    // Create a single fixed tooltip div attached to body — escapes all overflow/stacking contexts
    const tip = document.createElement('div');
    tip.id = '__app-tooltip';
    Object.assign(tip.style, {
      position: 'fixed',
      zIndex: '2147483647',
      padding: '5px 10px',
      borderRadius: '6px',
      fontSize: '0.75rem',
      lineHeight: '1.4',
      whiteSpace: 'nowrap',
      pointerEvents: 'none',
      opacity: '0',
      transition: 'opacity 0.15s',
      background: 'var(--bg-secondary, #eaf1f9)',
      color: 'var(--text, #06526d)',
      boxShadow: '0 8px 24px rgba(15, 23, 42, 0.18)',
      border: 'none',
    });
    document.body.appendChild(tip);

    let hideTimer = null;
    let activeEl = null;

    const positionTip = (el) => {
      const rect = el.getBoundingClientRect();
      const tipW = tip.offsetWidth;
      const tipH = tip.offsetHeight;
      const gap = 6;

      // Prefer above, fall back to below if not enough space
      let top = rect.top - tipH - gap;
      if (top < 4) top = rect.bottom + gap;

      let left = rect.left + rect.width / 2 - tipW / 2;
      left = Math.max(6, Math.min(left, window.innerWidth - tipW - 6));

      tip.style.top = `${top}px`;
      tip.style.left = `${left}px`;
      tip.style.opacity = '1';
    };

    // Event delegation: capture mouseenter on any [title] or [data-tooltip]
    const onOver = (e) => {
      const el = e.target.closest('[title], [data-tooltip]');
      if (!el) return;
      // Swap title → data-tooltip to suppress native tooltip
      if (el.hasAttribute('title')) {
        el.setAttribute('data-tooltip', el.getAttribute('title'));
        el.removeAttribute('title');
      }
      const text = el.getAttribute('data-tooltip');
      if (!text) return;
      clearTimeout(hideTimer);
      activeEl = el;
      tip.textContent = text;
      tip.style.opacity = '0';
      tip.style.display = 'block';
      positionTip(el);
    };

    const onOut = (e) => {
      const el = e.target.closest('[data-tooltip]');
      if (el && el === activeEl) {
        hideTimer = setTimeout(() => { tip.style.opacity = '0'; activeEl = null; }, 50);
      }
    };

    const hideImmediately = () => {
      clearTimeout(hideTimer);
      tip.style.opacity = '0';
      activeEl = null;
    };

    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mouseout', onOut, true);
    document.addEventListener('pointerdown', hideImmediately, true);
    document.addEventListener('click', hideImmediately, true);

    return () => {
      clearTimeout(hideTimer);
      document.removeEventListener('mouseover', onOver, true);
      document.removeEventListener('mouseout', onOut, true);
      document.removeEventListener('pointerdown', hideImmediately, true);
      document.removeEventListener('click', hideImmediately, true);
      tip.remove();
    };
  }, []);

  return (
    <AuthProvider>
      <ThemeProvider>
        <WorkStateProvider>
          <ToastProvider>
            <BrowserRouter>
              <AxiosInterceptor>
                <NotificationPrefsProvider>
                  <BrandingProvider>
                  <RoleLabelsProvider>
                  <AgileConfigProvider>
                  <ChatProvider>
                    <UserStatusProvider>
                    <CallProvider>
                      <MeetingProvider>
                        <AppRoutes />
                        <MeetingPiP />
                        <GlobalIncomingCall />
                        <GlobalMeetingNotification />
                      </MeetingProvider>
                    </CallProvider>
                    </UserStatusProvider>
                  </ChatProvider>
                  </AgileConfigProvider>
                  </RoleLabelsProvider>
                  </BrandingProvider>
                </NotificationPrefsProvider>
              </AxiosInterceptor>
            </BrowserRouter>
          </ToastProvider>
        </WorkStateProvider>
      </ThemeProvider>
    </AuthProvider>
  );
}
