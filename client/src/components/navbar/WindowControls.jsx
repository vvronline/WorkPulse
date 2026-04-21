import React, { useState, useEffect } from 'react';
import s from './WindowControls.module.css';

export default function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    window.electronAPI?.isMaximized?.().then(setMaximized);
    const handler = (val) => setMaximized(val);
    window.electronAPI?.onMaximizeChange?.(handler);
    return () => window.electronAPI?.removeMaximizeChange?.(handler);
  }, []);

  return (
    <div className={s.controls}>
      <button className={s.btn} onClick={() => window.electronAPI?.minimize()} title="Minimize">
        <svg width="12" height="12" viewBox="0 0 12 12">
          <rect x="1" y="5.5" width="10" height="1" fill="currentColor"/>
        </svg>
      </button>
      <button className={s.btn} onClick={() => window.electronAPI?.maximize()} title={maximized ? 'Restore' : 'Maximize'}>
        {maximized ? (
          <svg width="12" height="12" viewBox="0 0 12 12">
            <rect x="2.5" y="0" width="9" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1"/>
            <rect x="0.5" y="2.5" width="9" height="9" rx="1" fill="var(--bg, #1a1a2e)" stroke="currentColor" strokeWidth="1"/>
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 12 12">
            <rect x="0.5" y="0.5" width="11" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1"/>
          </svg>
        )}
      </button>
      <button className={`${s.btn} ${s.closeBtn}`} onClick={() => window.electronAPI?.close()} title="Close">
        <svg width="12" height="12" viewBox="0 0 12 12">
          <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
        </svg>
      </button>
    </div>
  );
}
