import React, { memo } from 'react';
import { CalendarDays } from 'lucide-react';
import s from './TodayEventsCard.module.css';

function formatEventTime(isoString) {
  if (!isoString) return '—';
  const d = new Date(isoString);
  return isNaN(d) ? '—' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function isNowOrPast(isoString) {
  return new Date(isoString) <= new Date();
}

function isHappeningNow(start, end) {
  const now = new Date();
  return new Date(start) <= now && now < new Date(end);
}

const TodayEventsCard = memo(function TodayEventsCard({ events }) {
  if (!events) return null;

  const sorted = [...events].sort((a, b) => new Date(a.start_time) - new Date(b.start_time));

  return (
    <div className={`status-card ${s.card}`}>
      <h3 className={s.title}>
        <span className="page-icon"><CalendarDays size={18} /></span> Today's Events
        {sorted.length > 0 && <span className={s.count}>{sorted.length}</span>}
      </h3>

      {sorted.length === 0 ? (
        <p className={s.empty}>No events scheduled for today.</p>
      ) : (
        <div className={s.list}>
          {sorted.map((ev) => {
            const past = isNowOrPast(ev.end_time);
            const active = isHappeningNow(ev.start_time, ev.end_time);
            return (
              <div
                key={ev.id}
                className={`${s.item} ${past ? s.past : ''} ${active ? s.active : ''}`}
              >
                <div className={s.colorDot} style={{ background: ev.color || '#6366f1' }} />
                <div className={s.body}>
                  <span className={s.name}>{ev.title}</span>
                  <span className={s.time}>
                    {ev.all_day
                      ? 'All day'
                      : `${formatEventTime(ev.start_time)} – ${formatEventTime(ev.end_time)}`}
                  </span>
                </div>
                {active && <span className={s.nowBadge}>Now</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

export default TodayEventsCard;
