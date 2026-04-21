import React, { useState, useEffect } from 'react';
import s from './UpdateNotification.module.css';

const api = window.electronAPI;

export default function UpdateNotification() {
  const [state, setState] = useState('idle'); // idle | available | downloading | ready
  const [version, setVersion] = useState('');
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!api) return;

    api.onUpdateAvailable((info) => {
      setVersion(info.version);
      setState('available');
    });

    api.onDownloadProgress?.((info) => {
      setProgress(info.percent);
    });

    api.onUpdateDownloaded(() => {
      setState('ready');
    });
  }, []);

  if (state === 'idle') return null;

  return (
    <div className={s.banner}>
      <div className={s.content}>
        {state === 'available' && (
          <>
            <span className={s.icon}>🚀</span>
            <span>Update <strong>v{version}</strong> is available</span>
            <button className={s.actionBtn} onClick={() => { setState('downloading'); api.downloadUpdate(); }}>
              Download
            </button>
            <button className={s.dismissBtn} onClick={() => setState('idle')}>Later</button>
          </>
        )}

        {state === 'downloading' && (
          <>
            <span className={s.icon}>⏬</span>
            <span>Downloading update… {progress}%</span>
            <div className={s.progressBar}>
              <div className={s.progressFill} style={{ width: `${progress}%` }} />
            </div>
          </>
        )}

        {state === 'ready' && (
          <>
            <span className={s.icon}>✅</span>
            <span>Update <strong>v{version}</strong> ready to install</span>
            <button className={s.actionBtn} onClick={() => api.installUpdate()}>
              Restart & Update
            </button>
            <button className={s.dismissBtn} onClick={() => setState('idle')}>Later</button>
          </>
        )}
      </div>
    </div>
  );
}
