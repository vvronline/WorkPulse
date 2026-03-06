import React, { createContext, useContext, useState, useEffect, useMemo } from 'react';
import { useAuth } from './AuthContext';
import { getStatus } from './api';

const WorkStateContext = createContext({
  workState: 'logged_out',
  setWorkState: () => { },
  workMode: 'office',
  setWorkMode: () => { },
});

export function WorkStateProvider({ children }) {
  const { isAuthenticated } = useAuth();
  const [workState, setWorkState] = useState('logged_out');
  const [workMode, setWorkMode] = useState('office');

  // Bootstrap work state from server on every page load/refresh so the
  // profile status dot is correct regardless of which page is active.
  useEffect(() => {
    if (!isAuthenticated) {
      setWorkState('logged_out');
      setWorkMode('office');
      return;
    }
    getStatus()
      .then(res => {
        setWorkState(res.data?.state || 'logged_out');
        if (res.data?.workMode) setWorkMode(res.data.workMode);
      })
      .catch(() => { /* keep logged_out default on error */ });
  }, [isAuthenticated]);

  const value = useMemo(() => ({ workState, setWorkState, workMode, setWorkMode }), [workState, workMode]);

  return (
    <WorkStateContext.Provider value={value}>
      {children}
    </WorkStateContext.Provider>
  );
}

export const useWorkState = () => useContext(WorkStateContext);
