import React, { useState, useEffect, useCallback } from 'react';
import s from './UpdateNotification.module.css';

const api = window.electronAPI;

export default function UpdateNotification() {
  const [state, setState] = useState('idle'); // idle | downloading | ready
  const [version, setVersion] = useState('');
  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);

  const show = useCallback(() => setVisible(true), []);
  const dismiss = useCallback(() => setVisible(false), []);

  useEffect(() => {
    if (!api) return;

    // Update found → auto-download starts immediately (autoDownload=true)
    api.onUpdateAvailable((info) => {
      setVersion(info.version);
      setState('downloading');
      setProgress(0);
      setVisible(true);
    });

    api.onDownloadProgress?.((info) => {
      setProgress(info.percent);
    });

    // Download complete → ready to install
    api.onUpdateDownloaded((info) => {
      setVersion(info.version);
      setState('ready');
      setVisible(true);
    });

    // Periodic reminder from main process (every 30 min if dismissed)
    api.onUpdateReminder?.((info) => {
      setVersion(info.version);
      setState('ready');
      setVisible(true);
    });
  }, []);

  if (!visible || state === 'idle') return null;

  return (
    <div className={s.banner}>
      <div className={s.content}>
        {state === 'downloading' && (
          <>
            <span className={s.icon}>⏬</span>
            <span>Downloading <strong>v{version}</strong>… {progress}%</span>
            <div className={s.progressBar}>
              <div className={s.progressFill} style={{ width: `${progress}%` }} />
            </div>
          </>
        )}

        {state === 'ready' && (
          <>
            <span className={s.icon}>✅</span>
            <span>Update <strong>v{version}</strong> ready — restart to apply</span>
            <button className={s.actionBtn} onClick={() => api.installUpdate()}>
              Restart Now
            </button>
            <button className={s.dismissBtn} onClick={dismiss}>Later</button>
          </>
        )}
      </div>
    </div>
  );
}
