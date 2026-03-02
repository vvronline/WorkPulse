import React, { createContext, useContext, useState, useMemo } from 'react';

const WorkStateContext = createContext({
  workState: 'logged_out',
  setWorkState: () => { },
  workMode: 'office',
  setWorkMode: () => { },
});

export function WorkStateProvider({ children }) {
  const [workState, setWorkState] = useState('logged_out');
  const [workMode, setWorkMode] = useState('office');

  const value = useMemo(() => ({ workState, setWorkState, workMode, setWorkMode }), [workState, workMode]);

  return (
    <WorkStateContext.Provider value={value}>
      {children}
    </WorkStateContext.Provider>
  );
}

export const useWorkState = () => useContext(WorkStateContext);
