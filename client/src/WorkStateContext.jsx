import React, { createContext, useContext, useState } from 'react';

const WorkStateContext = createContext({
  workState: 'logged_out',
  setWorkState: () => {},
  workMode: 'office',
  setWorkMode: () => {},
});

export function WorkStateProvider({ children }) {
  const [workState, setWorkState] = useState('logged_out');
  const [workMode, setWorkMode] = useState('office');
  return (
    <WorkStateContext.Provider value={{ workState, setWorkState, workMode, setWorkMode }}>
      {children}
    </WorkStateContext.Provider>
  );
}

export const useWorkState = () => useContext(WorkStateContext);
