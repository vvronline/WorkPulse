import React, { memo } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarDays, Video } from 'lucide-react';
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

function isStartingSoon(start) {
  const now = Date.now();
  const startMs = new Date(start).getTime();
  return startMs > now && startMs - now <= 30 * 60 * 1000;
}

function EventItem({ ev, onJoinMeeting }) {
  const past = isNowOrPast(ev.end_time);
  const active = isHappeningNow(ev.start_time, ev.end_time);
  const soon = !past && !active && isStartingSoon(ev.start_time);
  const hasMeeting = !!ev.meeting_code;

  return (
    <div className={`${s.item} ${past ? s.past : ''} ${active ? s.active : ''} ${soon ? s.soon : ''}`}>
      <div className={s.colorDot} style={{ background: ev.color || '#6366f1' }} />
      <div className={s.body}>
        <span className={s.name}>{ev.title}</span>
        <span className={s.time}>
          {ev.all_day ? 'All day' : `${formatEventTime(ev.start_time)} – ${formatEventTime(ev.end_time)}`}
        </span>
      </div>
      {active && <span className={s.nowBadge}>Now</span>}
      {soon && !active && <span className={s.soonBadge}>Soon</span>}
      {hasMeeting && (active || soon) && (
        <button className={s.joinBtn} onClick={() => onJoinMeeting(ev.meeting_code)} title="Join Meeting">
          <Video size={13} /> Join
        </button>
      )}
    </div>
  );
}

const TodayEventsCard = memo(function TodayEventsCard({ events, tomorrowEvents }) {
  const navigate = useNavigate();

  const onJoinMeeting = (code) => navigate(`/meeting/${code}`);

  const todaySorted = events
    ? [...events].sort((a, b) => new Date(a.start_time) - new Date(b.start_time))
    : [];

  const tomorrowSorted = tomorrowEvents
    ? [...tomorrowEvents].sort((a, b) => new Date(a.start_time) - new Date(b.start_time))
    : [];

  return (
    <div className={`status-card ${s.card}`}>
      <h3 className={s.title}>
        <span className="page-icon"><CalendarDays size={18} /></span> Today's Events
        {todaySorted.length > 0 && <span className={s.count}>{todaySorted.length}</span>}
      </h3>

      {todaySorted.length === 0 ? (
        <p className={s.empty}>No events scheduled for today.</p>
      ) : (
        <div className={s.list}>
          {todaySorted.map((ev) => (
            <EventItem key={ev.id} ev={ev} onJoinMeeting={onJoinMeeting} />
          ))}
        </div>
      )}

      {/* Tomorrow preview */}
      {tomorrowSorted.length > 0 && (
        <>
          <h4 className={s.tomorrowTitle}>Tomorrow</h4>
          <div className={s.list}>
            {tomorrowSorted.slice(0, 3).map((ev) => (
              <div key={ev.id} className={`${s.item} ${s.tomorrow}`}>
                <div className={s.colorDot} style={{ background: ev.color || '#6366f1' }} />
                <div className={s.body}>
                  <span className={s.name}>{ev.title}</span>
                  <span className={s.time}>
                    {ev.all_day ? 'All day' : `${formatEventTime(ev.start_time)} – ${formatEventTime(ev.end_time)}`}
                  </span>
                </div>
              </div>
            ))}
            {tomorrowSorted.length > 3 && (
              <p className={s['more-events']}>+{tomorrowSorted.length - 3} more</p>
            )}
          </div>
        </>
      )}
    </div>
  );
});

export default TodayEventsCard;
