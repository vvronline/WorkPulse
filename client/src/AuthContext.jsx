import React, { createContext, useContext, useState, useEffect } from 'react';
import { getProfile, logoutUser } from './api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [isInitializing, setIsInitializing] = useState(true);

  useEffect(() => {
    // Rely on the browser's HttpOnly cookie to see if we are currently authenticated
    // We just ask the backend for the profile. If it succeeds, the cookie was valid!
    getProfile()
      .then(res => {
        if (res.data) {
          setUser(res.data);
          localStorage.setItem('user', JSON.stringify(res.data));
        }
      })
      .catch(err => {
        // Ignore 401s (not logged in). Only log if another error.
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
