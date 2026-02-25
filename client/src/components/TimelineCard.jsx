import React, { memo } from 'react';
import s from './TimelineCard.module.css';

const TIMELINE_ICONS = {
  clock_in: '▶',
  break_start: '☕',
  break_end: '▶',
  clock_out: '⏹'
};

const TIMELINE_LABELS = {
  clock_in: 'Logged In',
  break_start: 'Break Started',
  break_end: 'Break Ended',
  clock_out: 'Logged Out'
};

const TimelineCard = memo(function TimelineCard({ entries }) {
  if (!entries || entries.length === 0) return null;

  return (
    <div className={`status-card ${s['timeline-card']}`}>
      <h3 className={s['timeline-title']}>
        <span className="page-icon">📋</span> Today's Timeline
      </h3>
      <div className={s['enhanced-timeline']}>
        {entries.map((entry, i) => {
          const time = new Date(entry.timestamp.replace(' ', 'T') + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          return (
            <div key={i} className={s['timeline-entry']}>
              <div className={s['timeline-connector']}>
                <div className={`${s['timeline-icon-circle']} ${s[entry.entry_type]}`}>
                  <span className="page-icon">{TIMELINE_ICONS[entry.entry_type]}</span>
                </div>
                {i < entries.length - 1 && <div className={s['timeline-line']} />}
              </div>
              <div className={s['timeline-content']}>
                <span className={s['timeline-event-label']}>{TIMELINE_LABELS[entry.entry_type]}</span>
                <span className={s['timeline-time']}>{time}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});

export default TimelineCard;
