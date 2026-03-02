import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { getTheme, updateTheme } from './api';
import { useAuth } from './AuthContext';

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');
  const { isAuthenticated } = useAuth();

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.style.colorScheme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);

  // Fetch theme from server when authenticated
  useEffect(() => {
    if (isAuthenticated) {
      getTheme().then(({ data }) => {
        setTheme(data.theme);
      }).catch(e => console.error(e));
    }
  }, [isAuthenticated]);

  const toggleTheme = useCallback(async () => {
    setTheme(prev => {
      const newTheme = prev === 'dark' ? 'light' : 'dark';
      if (isAuthenticated) {
        updateTheme(newTheme).catch(e => console.error(e));
      }
      return newTheme;
    });
  }, [isAuthenticated]);

  const value = useMemo(() => ({ theme, toggleTheme }), [theme, toggleTheme]);

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
