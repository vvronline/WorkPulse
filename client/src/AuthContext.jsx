import React, { createContext, useContext, useState, useEffect, useMemo, useCallback } from 'react';
import { getProfile, logoutUser } from './api';

const AuthContext = createContext(null);

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
          localStorage.setItem('user', JSON.stringify(res.data));
        }
      })
      .catch(err => {
        // Session expired or invalid — clear cached user
        if (err.response?.status === 401) {
          localStorage.removeItem('user');
          setUser(null);
        }
      })
      .finally(() => {
        setIsInitializing(false);
      });
  }, []);

  const saveAuth = useCallback((user) => {
    localStorage.setItem('user', JSON.stringify(user));
    setUser(user);
  }, []);

  const updateUser = useCallback((partial) => {
    setUser(prev => {
      const updated = { ...prev, ...partial };
      localStorage.setItem('user', JSON.stringify(updated));
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
