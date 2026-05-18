import React, { memo, useMemo, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarDays, Video } from 'lucide-react';
import { useBranding } from '../../BrandingContext';
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

function isJoinable(start, end) {
  const now = Date.now();
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  // Active (happening now) or starting within 5 minutes
  return now < endMs && startMs - now <= 5 * 60 * 1000;
}

function getMinutesUntil(isoString) {
  return Math.max(0, Math.round((new Date(isoString).getTime() - Date.now()) / 60000));
}

function MeetingItem({ ev, onJoinMeeting, tick }) {
  const active = isHappeningNow(ev.start_time, ev.end_time);
  const soon = !active && isStartingSoon(ev.start_time);
  const minsLeft = !active ? getMinutesUntil(ev.start_time) : 0;
  const joinable = ev.meeting_code && isJoinable(ev.start_time, ev.end_time);

  return (
    <div className={`${s['meeting-item']} ${active ? s['meeting-live'] : ''} ${soon ? s['meeting-soon'] : ''}`}>
      <div className={s['meeting-left']}>
        <div className={s['meeting-time-col']}>
          <span className={s['meeting-start']}>{formatEventTime(ev.start_time)}</span>
          <span className={s['meeting-end']}>{formatEventTime(ev.end_time)}</span>
        </div>
        <div className={s['meeting-info']}>
          <span className={s['meeting-name']}>{ev.title}</span>
          <div className={s['meeting-meta']}>
            {active && (
              <span className={s.liveBadge}>
                <span className={s.liveDot} /> Live
              </span>
            )}
            {soon && (
              <span className={s.soonBadge}>Soon · {minsLeft}m</span>
            )}
            {!active && !soon && (
              <span className={s['meeting-in']}>in {minsLeft < 60 ? `${minsLeft}m` : `${Math.floor(minsLeft / 60)}h ${minsLeft % 60}m`}</span>
            )}
          </div>
        </div>
      </div>
      {joinable && (
        <button
          className={`${s.joinBtn} ${active ? s['joinBtn-live'] : ''}`}
          onClick={(e) => { e.stopPropagation(); onJoinMeeting(ev.meeting_code); }}
          title="Join Meeting"
        >
          <Video size={13} /> Join
        </button>
      )}
    </div>
  );
}

function EventItem({ ev, accentColor }) {
  const past = isNowOrPast(ev.end_time);

  return (
    <div className={`${s.item} ${past ? s.past : ''}`}>
      <div className={s.colorDot} style={{ background: ev.meeting_code ? accentColor : (ev.color || accentColor) }} />
      <div className={s.body}>
        <span className={s.name}>{ev.title}</span>
        <span className={s.time}>
          {ev.all_day ? 'All day' : `${formatEventTime(ev.start_time)} – ${formatEventTime(ev.end_time)}`}
        </span>
      </div>
    </div>
  );
}

const TodayEventsCard = memo(function TodayEventsCard({ events, tomorrowEvents }) {
  const navigate = useNavigate();
  const { branding } = useBranding();
  const accentColor = branding.accent_color || '#2383e2';

  // Tick every 30s so join-button visibility updates in real time
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  const onJoinMeeting = (code) => navigate(`/meeting/${code}`);

  const todaySorted = useMemo(() =>
    events ? [...events].sort((a, b) => new Date(a.start_time) - new Date(b.start_time)) : [],
    [events]
  );

  const tomorrowSorted = useMemo(() =>
    tomorrowEvents ? [...tomorrowEvents].sort((a, b) => new Date(a.start_time) - new Date(b.start_time)) : [],
    [tomorrowEvents]
  );

  // Upcoming meetings: live + not-yet-ended meetings with meeting_code, capped at 4
  const upcomingMeetings = useMemo(() => {
    const now = new Date();
    return todaySorted
      .filter(ev => ev.meeting_code && new Date(ev.end_time) > now)
      .slice(0, 4);
  }, [todaySorted]);

  // Remaining non-meeting events for today
  const meetingIds = useMemo(() => new Set(upcomingMeetings.map(m => m.id)), [upcomingMeetings]);
  const otherEvents = useMemo(
    () => todaySorted.filter(ev => !meetingIds.has(ev.id)),
    [todaySorted, meetingIds]
  );

  return (
    <div className={`status-card ${s.card}`}>
      <h3 className={s.title}>
        <span className="page-icon"><CalendarDays size={18} /></span> Today's Events
        {todaySorted.length > 0 && <span className={s.count}>{todaySorted.length}</span>}
      </h3>

      {/* Upcoming meetings section */}
      {upcomingMeetings.length > 0 && (
        <div className={s['meetings-section']}>
          <h4 className={s['section-label']}>
            <Video size={14} /> Upcoming Meetings
          </h4>
          <div className={s['meetings-list']}>
            {upcomingMeetings.map(ev => (
              <MeetingItem key={ev.id} ev={ev} onJoinMeeting={onJoinMeeting} tick={tick} />
            ))}
          </div>
        </div>
      )}

      {/* Other events */}
      {otherEvents.length > 0 && (
        <>
          {upcomingMeetings.length > 0 && <h4 className={s['section-label']}>Other Events</h4>}
          <div className={s.list}>
            {otherEvents.map(ev => (
              <EventItem key={ev.id} ev={ev} accentColor={accentColor} />
            ))}
          </div>
        </>
      )}

      {todaySorted.length === 0 && (
        <p className={s.empty}>No events scheduled for today.</p>
      )}

      {/* Tomorrow preview */}
      {tomorrowSorted.length > 0 && (
        <>
          <h4 className={s.tomorrowTitle}>Tomorrow</h4>
          <div className={s.list}>
            {tomorrowSorted.slice(0, 3).map((ev) => (
              <div key={ev.id} className={`${s.item} ${s.tomorrow}`}>
                <div className={s.colorDot} style={{ background: ev.meeting_code ? accentColor : (ev.color || accentColor) }} />
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
