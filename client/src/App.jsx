import React, { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './AuthContext';
import { ThemeProvider } from './ThemeContext';
import { WorkStateProvider } from './WorkStateContext';
import Login from './pages/Login';
import ChangePassword from './pages/ChangePassword';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import Dashboard from './pages/Dashboard';
import Navbar from './components/Navbar';
import AxiosInterceptor from './components/AxiosInterceptor';
import { ToastProvider } from './components/Toast';

// Lazy-load non-critical pages for smaller initial bundle
const Analytics = lazy(() => import('./pages/Analytics'));
const ManualEntry = lazy(() => import('./pages/ManualEntry'));
const Leaves = lazy(() => import('./pages/Leaves'));
const Tasks = lazy(() => import('./pages/Tasks'));

// Enterprise pages
const Admin = lazy(() => import('./pages/Admin'));
const ManagerDashboard = lazy(() => import('./pages/ManagerDashboard'));
const LeavePolicy = lazy(() => import('./pages/LeavePolicy'));
const SetEmail = lazy(() => import('./pages/SetEmail'));

function ProtectedRoute({ children, minRole }) {
  const { isAuthenticated, user } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" />;
  // Force password change before accessing any route
  if (user?.must_change_password) return <Navigate to="/change-password" />;
  if (minRole) {
    const levels = { employee: 1, team_lead: 2, manager: 3, hr_admin: 4, super_admin: 5 };
    // Allow manager route if user has direct reports
    if (minRole === 'team_lead' && user?.has_reports) return children;
    if ((levels[user?.role] || 1) < (levels[minRole] || 1)) return <Navigate to="/" />;
  }
  return children;
}

function PublicRoute({ children }) {
  const { isAuthenticated } = useAuth();
  return !isAuthenticated ? children : <Navigate to="/" />;
}

function AppRoutes() {
  const { isAuthenticated } = useAuth();

  return (
    <div className="app">
      {isAuthenticated && <Navbar />}
      <Suspense fallback={<div style={{ maxWidth: '1400px', margin: '2rem auto', padding: '0 2.5rem' }}><div className="status-card"><div className="loading-spinner"><div className="spinner"></div></div></div></div>}>
        <Routes>
          <Route path="/login" element={<PublicRoute><Login /></PublicRoute>} />
          <Route path="/change-password" element={isAuthenticated ? <ChangePassword /> : <Navigate to="/login" />} />
          <Route path="/forgot-password" element={<PublicRoute><ForgotPassword /></PublicRoute>} />
          <Route path="/reset-password/:token" element={<PublicRoute><ResetPassword /></PublicRoute>} />
          <Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
          <Route path="/analytics" element={<ProtectedRoute><Analytics /></ProtectedRoute>} />
          <Route path="/manual-entry" element={<ProtectedRoute><ManualEntry /></ProtectedRoute>} />
          <Route path="/leaves" element={<ProtectedRoute><Leaves /></ProtectedRoute>} />
          <Route path="/tasks" element={<ProtectedRoute><Tasks /></ProtectedRoute>} />
          <Route path="/admin" element={<ProtectedRoute minRole="hr_admin"><Admin /></ProtectedRoute>} />
          <Route path="/manager" element={<ProtectedRoute minRole="team_lead"><ManagerDashboard /></ProtectedRoute>} />
          <Route path="/leave-policy" element={<ProtectedRoute><LeavePolicy /></ProtectedRoute>} />
          <Route path="/set-email" element={<ProtectedRoute><SetEmail /></ProtectedRoute>} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </Suspense>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ThemeProvider>
        <WorkStateProvider>
          <ToastProvider>
            <BrowserRouter>
              <AxiosInterceptor>
                <AppRoutes />
              </AxiosInterceptor>
            </BrowserRouter>
          </ToastProvider>
        </WorkStateProvider>
      </ThemeProvider>
    </AuthProvider>
  );
}
