import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell } from 'lucide-react';
import s from './EventReminderToast.module.css';

const AUTO_CLOSE_MS = 15000;

function formatTime(isoString) {
  const d = new Date(isoString);
  return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function ReminderItem({ reminder, onDismiss }) {
  const [progress, setProgress] = useState(100);

  useEffect(() => {
    const start = Date.now();
    const tick = setInterval(() => {
      const elapsed = Date.now() - start;
      const pct = Math.max(0, 100 - (elapsed / AUTO_CLOSE_MS) * 100);
      setProgress(pct);
      if (pct === 0) clearInterval(tick);
    }, 100);
    return () => clearInterval(tick);
  }, []);

  const { event } = reminder;

  return (
    <div className={s.toast} role="alert" aria-live="assertive">
      <div className={s.body}>
        <div className={s.header}>
          <span className={s.icon}><Bell size={16} /></span>
          <span className={s.label}>Upcoming Event</span>
          <button className={s.close} onClick={() => onDismiss(reminder.id)} aria-label="Dismiss">
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M2 2l10 10M12 2L2 12" />
            </svg>
          </button>
        </div>
        <div className={s.title}>{event.title}</div>
        <div className={s.time}>
          Starts at <strong>{formatTime(event.start_time)}</strong> · in {reminder.timeLabel || '~10 min'}
        </div>
        {event.description && (
          <div className={s.desc}>{event.description}</div>
        )}
      </div>
      <div
        className={s.progressBar}
        style={{ '--progress': `${progress}%`, '--ev-color': event.color || '#6366f1' }}
      />
    </div>
  );
}

export default function EventReminderToast({ reminders, onDismiss }) {
  if (!reminders || reminders.length === 0) return null;

  return createPortal(
    <div className={s.stack}>
      {reminders.map((r) => (
        <ReminderItem key={r.id} reminder={r} onDismiss={onDismiss} />
      ))}
    </div>,
    document.body
  );
}
