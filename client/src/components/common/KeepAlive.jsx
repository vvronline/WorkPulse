import { Suspense, lazy, useRef } from 'react';
import { useLocation, Navigate } from 'react-router-dom';
import { useAuth } from '../../AuthContext';
import { ROLE_LEVEL } from '../../constants';
import PageSkeleton from './PageSkeleton';

/**
 * Keeps previously visited pages mounted in the DOM (hidden via display:none)
 * so switching back is instant — no re-fetch, no re-mount, no skeleton flash.
 */

// Lazy page imports (same modules — Vite deduplicates)
const pageImports = {
  '/': () => import('../../pages/Dashboard'),
  '/analytics': () => import('../../pages/analytics'),
  '/manual-entry': () => import('../../pages/ManualEntry'),
  '/leaves': () => import('../../pages/Leaves'),
  '/tasks': () => import('../../pages/Tasks'),
  '/calendar': () => import('../../pages/CalendarPage'),
  '/notes': () => import('../../pages/NotesPage'),
  '/chat': () => import('../../pages/Chat'),
  '/admin': () => import('../../pages/Admin'),
  '/manager': () => import('../../pages/ManagerDashboard'),
  '/leave-policy': () => import('../../pages/LeavePolicy'),
  '/organization': () => import('../../pages/Organization'),
  '/set-email': () => import('../../pages/SetEmail'),
  '/tenants': () => import('../../pages/tenants'),
};

// Role requirements (paths not listed here are open to any authenticated user)
const ROLE_REQUIREMENTS = {
  '/admin': 'hr_admin',
  '/tenants': 'platform_admin',
  '/manager': 'team_lead',
};

// Create lazy components (only once)
const lazyPages = {};
for (const [path, importFn] of Object.entries(pageImports)) {
  lazyPages[path] = lazy(importFn);
}

/** Prefetch a page's JS chunk on hover */
export function prefetchPage(path) {
  if (pageImports[path]) pageImports[path]();
}

export default function KeepAlive() {
  const { pathname } = useLocation();
  const { user } = useAuth();
  const visited = useRef(new Set());

  // Normalize path
  const current = pathname === '/' ? '/' : pathname.replace(/\/$/, '');

  // Force password change
  if (user?.must_change_password) return <Navigate to="/change-password" />;

  // Role check for current path
  const minRole = ROLE_REQUIREMENTS[current];
  if (minRole) {
    const userLevel = ROLE_LEVEL[user?.role] || 1;
    const reqLevel = ROLE_LEVEL[minRole] || 1;
    // Allow manager route if user has direct reports
    const allowed = userLevel >= reqLevel || (minRole === 'team_lead' && user?.has_reports);
    if (!allowed) return <Navigate to="/" />;
  }

  // Track visited keep-alive paths
  if (lazyPages[current]) {
    visited.current.add(current);
  }

  return (
    <>
      {[...visited.current].map(path => {
        const Page = lazyPages[path];
        const isActive = path === current;
        return (
          <div
            key={path}
            style={{ display: isActive ? 'contents' : 'none' }}
          >
            <Suspense fallback={<PageSkeleton />}>
              <Page />
            </Suspense>
          </div>
        );
      })}
    </>
  );
}
