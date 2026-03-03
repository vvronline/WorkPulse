import React, { createContext, useContext, useState, useEffect, useMemo, useCallback } from 'react';
import { getProfile, logoutUser } from './api';

const AuthContext = createContext(null);

// Only cache display-safe fields in localStorage to prevent privilege escalation
// via tampered localStorage. Role, org_id, has_reports etc. always come from the server.
const SAFE_CACHE_FIELDS = ['id', 'username', 'full_name', 'email', 'avatar'];
function sanitizeForCache(user) {
  const safe = {};
  SAFE_CACHE_FIELDS.forEach(key => { if (user?.[key] !== undefined) safe[key] = user[key]; });
  return safe;
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [isInitializing, setIsInitializing] = useState(true);

  useEffect(() => {
    // Only verify session if there's a cached user — avoids a 401 console error
    // when the user was never logged in (no cookie exists).
    const cached = localStorage.getItem('user');
    if (!cached) {
      setIsInitializing(false);
      return;
    }
    getProfile()
      .then(res => {
        if (res.data) {
          setUser(res.data);
          localStorage.setItem('user', JSON.stringify(sanitizeForCache(res.data)));
        }
      })
      .catch(err => {
        // Session expired or invalid — clear cached user
        if (err.response?.status === 401) {
          localStorage.removeItem('user');
          setUser(null);
        } else {
          // Non-401 error (500, network) — use cached display-safe fields only.
          // Role/org_id/has_reports are NOT in the cache, so the user gets a
          // basic view without admin or manager features until the server reconnects.
          try {
            const cachedUser = JSON.parse(cached);
            setUser(sanitizeForCache(cachedUser));
          } catch {
            localStorage.removeItem('user');
            setUser(null);
          }
        }
      })
      .finally(() => {
        setIsInitializing(false);
      });
  }, []);

  const saveAuth = useCallback((user) => {
    localStorage.setItem('user', JSON.stringify(sanitizeForCache(user)));
    setUser(user);
  }, []);

  const updateUser = useCallback((partial) => {
    setUser(prev => {
      const updated = { ...prev, ...partial };
      localStorage.setItem('user', JSON.stringify(sanitizeForCache(updated)));
      return updated;
    });
  }, []);

  const logout = useCallback(async () => {
    try {
      await logoutUser();
    } catch (e) { /* ignore network error on logout */ }
    localStorage.removeItem('user');
    setUser(null);
  }, []);

  const value = useMemo(() => ({
    user,
    saveAuth,
    updateUser,
    logout,
    isAuthenticated: !!user,
    isInitializing
  }), [user, saveAuth, updateUser, logout, isInitializing]);

  return (
    <AuthContext.Provider value={value}>
      {!isInitializing && children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
