import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { getTheme, updateTheme } from './api';
import { useAuth } from './AuthContext';

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');
  const { isAuthenticated } = useAuth();

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  // Fetch theme from server when authenticated
  useEffect(() => {
    if (isAuthenticated) {
      getTheme().then(({ data }) => {
        setTheme(data.theme);
      }).catch(() => {});
    }
  }, [isAuthenticated]);

  const toggleTheme = useCallback(async () => {
    const newTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(newTheme);
    if (isAuthenticated) {
      try { await updateTheme(newTheme); } catch(e) {}
    }
  }, [theme, isAuthenticated]);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
