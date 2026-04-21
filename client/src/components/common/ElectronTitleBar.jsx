import React, { useState, useEffect } from 'react';

const isElectron = !!window.electronAPI?.isElectron;
const isMac = window.electronAPI?.platform === 'darwin';

/* Minimal drag region + window controls for frameless Electron when Navbar is hidden (login, register, etc.) */
export default function ElectronTitleBar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    window.electronAPI?.isMaximized?.().then(setMaximized);
    const handler = (val) => setMaximized(val);
    window.electronAPI?.onMaximizeChange?.(handler);
    return () => window.electronAPI?.removeMaximizeChange?.(handler);
  }, []);

  if (!isElectron) return null;

  // macOS has native traffic light buttons — only need drag region
  if (isMac) {
    return (
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0, height: 32,
        WebkitAppRegion: 'drag', zIndex: 9999,
      }} />
    );
  }

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, height: 32,
      WebkitAppRegion: 'drag', zIndex: 9999,
      display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
    }}>
      <div style={{ display: 'flex', WebkitAppRegion: 'no-drag' }}>
        <button onClick={() => window.electronAPI?.minimize()} title="Minimize" style={btnStyle}>
          <svg width="12" height="12" viewBox="0 0 12 12">
            <rect x="1" y="5.5" width="10" height="1" fill="currentColor"/>
          </svg>
        </button>
        <button onClick={() => window.electronAPI?.maximize()} title={maximized ? 'Restore' : 'Maximize'} style={btnStyle}>
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
        <button onClick={() => window.electronAPI?.close()} title="Close" style={btnStyle}
          onMouseEnter={e => e.currentTarget.style.background = '#e81123'}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
        </button>
      </div>
    </div>
  );
}

const btnStyle = {
  width: 36, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
  background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.7)', cursor: 'pointer',
  borderRadius: 4,
};
