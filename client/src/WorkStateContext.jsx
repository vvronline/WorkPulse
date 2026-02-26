import React, { createContext, useContext, useState, useEffect } from 'react';
import { useAuth } from './AuthContext';
import { getStatus } from './api';

const WorkStateContext = createContext({
  workState: 'logged_out',
  setWorkState: () => { },
  workMode: 'office',
  setWorkMode: () => { },
  loadingStatus: true,
});

export function WorkStateProvider({ children }) {
  const { isAuthenticated } = useAuth();
  const [workState, setWorkState] = useState('logged_out');
  const [workMode, setWorkMode] = useState('office');
  const [loadingStatus, setLoadingStatus] = useState(true);

  useEffect(() => {
    if (isAuthenticated) {
      getStatus().then(res => {
        setWorkState(res.data.state || 'logged_out');
        setWorkMode(res.data.workMode || 'office');
      }).catch(err => {
        console.error("Failed to get initial work state", err);
      }).finally(() => {
        setLoadingStatus(false);
      });
    } else {
      setWorkState('logged_out');
      setLoadingStatus(false);
    }
  }, [isAuthenticated]);

  return (
    <WorkStateContext.Provider value={{ workState, setWorkState, workMode, setWorkMode, loadingStatus }}>
      {children}
    </WorkStateContext.Provider>
  );
}

export const useWorkState = () => useContext(WorkStateContext);
