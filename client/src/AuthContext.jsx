import React, { createContext, useContext, useState, useEffect } from 'react';
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

  const saveAuth = (user) => {
    localStorage.setItem('user', JSON.stringify(user));
    setUser(user);
  };

  const updateUser = (partial) => {
    setUser(prev => {
      const updated = { ...prev, ...partial };
      localStorage.setItem('user', JSON.stringify(updated));
      return updated;
    });
  };

  const logout = async () => {
    try {
      await logoutUser();
    } catch (e) { /* ignore network error on logout */ }
    localStorage.removeItem('user');
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{
      user,
      saveAuth,
      updateUser,
      logout,
      isAuthenticated: !!user,
      isInitializing
    }}>
      {!isInitializing && children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
