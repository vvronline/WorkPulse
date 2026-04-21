import React, { useState, useEffect, useCallback } from 'react';
import s from './UpdateNotification.module.css';

const api = window.electronAPI;

export default function UpdateNotification() {
  const [state, setState] = useState('idle'); // idle | checking | downloading | ready | upToDate | error
  const [version, setVersion] = useState('');
  const [appVersion, setAppVersion] = useState('');
  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);

  const dismiss = useCallback(() => setVisible(false), []);

  const checkForUpdate = useCallback(async () => {
    if (!api?.checkForUpdate) return;
    setState('checking');
    setVisible(true);
    try {
      await api.checkForUpdate();
    } catch {
      setState('error');
    }
  }, []);

  useEffect(() => {
    if (!api) return;
    api.getVersion?.().then(v => setAppVersion(v));

    // Allow triggering check from profile menu
    const handleExternalCheck = () => checkForUpdate();
    window.addEventListener('workpulse-check-update', handleExternalCheck);

    api.onUpdateAvailable((info) => {
      setVersion(info.version);
      setState('downloading');
      setProgress(0);
      setVisible(true);
    });

    api.onDownloadProgress?.((info) => {
      setProgress(info.percent);
    });

    api.onUpdateDownloaded((info) => {
      setVersion(info.version);
      setState('ready');
      setVisible(true);
    });

    api.onUpdateReminder?.((info) => {
      setVersion(info.version);
      setState('ready');
      setVisible(true);
    });

    api.onUpdateNotAvailable?.(() => {
      setState('upToDate');
      setVisible(true);
      setTimeout(() => { setState('idle'); setVisible(false); }, 4000);
    });

    api.onUpdateError?.(() => {
      setState('error');
      setVisible(true);
      setTimeout(() => { setState('idle'); setVisible(false); }, 4000);
    });

    return () => window.removeEventListener('workpulse-check-update', handleExternalCheck);
  }, [checkForUpdate]);

  return (
    <>
      {/* Toast banner — triggered from profile menu or auto-update */}
      {visible && state !== 'idle' && (
        <div className={s.banner}>
          <div className={s.content}>
            {state === 'checking' && (
              <>
                <span className={s.spinner} />
                <span>Checking for updates…</span>
              </>
            )}

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

            {state === 'upToDate' && (
              <>
                <span className={s.icon}>✓</span>
                <span>You're on the latest version <strong>v{appVersion}</strong></span>
              </>
            )}

            {state === 'error' && (
              <>
                <span className={s.icon}>⚠️</span>
                <span>Couldn't check for updates</span>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
