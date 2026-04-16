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
import Dashboard from './pages/Dashboard';
import Navbar from './components/navbar/Navbar';
import AxiosInterceptor from './components/common/AxiosInterceptor';
import ErrorBoundary from './components/common/ErrorBoundary';
import { ToastProvider } from './components/common/Toast';
import { ChatProvider } from './ChatContext';
import { CallProvider } from './CallContext';
import { MeetingProvider } from './MeetingContext';
import { UserStatusProvider } from './UserStatusContext';
import MeetingPiP from './components/meeting/MeetingPiP';
import GlobalIncomingCall from './components/notifications/GlobalIncomingCall';
import PageSkeleton from './components/common/PageSkeleton';

// Lazy-load non-critical pages for smaller initial bundle
const Analytics = lazy(() => import('./pages/analytics'));
const ManualEntry = lazy(() => import('./pages/ManualEntry'));
const Leaves = lazy(() => import('./pages/Leaves'));
const Tasks = lazy(() => import('./pages/Tasks'));
const CalendarPage = lazy(() => import('./pages/CalendarPage'));
const NotesPage = lazy(() => import('./pages/NotesPage'));
const Chat = lazy(() => import('./pages/Chat'));
const MeetingJoin = lazy(() => import('./pages/MeetingJoin'));
const MeetingRoom = lazy(() => import('./pages/MeetingRoom'));

// Enterprise pages
const Admin = lazy(() => import('./pages/Admin'));
const ManagerDashboard = lazy(() => import('./pages/ManagerDashboard'));
const LeavePolicy = lazy(() => import('./pages/LeavePolicy'));
const Organization = lazy(() => import('./pages/Organization'));
const SetEmail = lazy(() => import('./pages/SetEmail'));

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

function AppRoutes() {
  const { isAuthenticated } = useAuth();
  const location = useLocation();

  return (
    <div className="app">
      <ErrorBoundary resetKey={location.pathname}>
      {isAuthenticated && !location.pathname.match(/^\/meeting\/[^/]+\/room/) && <Navbar />}
      <Suspense fallback={<PageSkeleton />}>
        <Routes>
          <Route path="/login" element={<PublicRoute><Login /></PublicRoute>} />
          <Route path="/register" element={<PublicRoute><Register /></PublicRoute>} />
          <Route path="/change-password" element={isAuthenticated ? <ChangePassword /> : <Navigate to="/login" />} />
          <Route path="/forgot-password" element={<PublicRoute><ForgotPassword /></PublicRoute>} />
          <Route path="/reset-password/:token" element={<PublicRoute><ResetPassword /></PublicRoute>} />
          <Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
          <Route path="/analytics" element={<ProtectedRoute><Analytics /></ProtectedRoute>} />
          <Route path="/manual-entry" element={<ProtectedRoute><ManualEntry /></ProtectedRoute>} />
          <Route path="/leaves" element={<ProtectedRoute><Leaves /></ProtectedRoute>} />
          <Route path="/tasks" element={<ProtectedRoute><Tasks /></ProtectedRoute>} />
          <Route path="/calendar" element={<ProtectedRoute><CalendarPage /></ProtectedRoute>} />
          <Route path="/notes" element={<ProtectedRoute><NotesPage /></ProtectedRoute>} />
          <Route path="/chat" element={<ProtectedRoute><Chat /></ProtectedRoute>} />
          <Route path="/meeting/:code" element={<ProtectedRoute><MeetingJoin /></ProtectedRoute>} />
          <Route path="/meeting/:code/room" element={<ProtectedRoute><MeetingRoom /></ProtectedRoute>} />
          <Route path="/admin" element={<ProtectedRoute minRole="hr_admin"><Admin /></ProtectedRoute>} />
          <Route path="/manager" element={<ProtectedRoute minRole="team_lead"><ManagerDashboard /></ProtectedRoute>} />
          <Route path="/leave-policy" element={<ProtectedRoute><LeavePolicy /></ProtectedRoute>} />
          <Route path="/organization" element={<ProtectedRoute><Organization /></ProtectedRoute>} />
          <Route path="/set-email" element={<ProtectedRoute><SetEmail /></ProtectedRoute>} />
          <Route path="*" element={<Navigate to="/" />} />
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
                <ChatProvider>
                  <UserStatusProvider>
                  <CallProvider>
                    <MeetingProvider>
                      <AppRoutes />
                      <MeetingPiP />
                      <GlobalIncomingCall />
                    </MeetingProvider>
                  </CallProvider>
                  </UserStatusProvider>
                </ChatProvider>
              </AxiosInterceptor>
            </BrowserRouter>
          </ToastProvider>
        </WorkStateProvider>
      </ThemeProvider>
    </AuthProvider>
  );
}
