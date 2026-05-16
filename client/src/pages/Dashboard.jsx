import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { useWorkState } from '../WorkStateContext';
import { getTaskSummary, getCalendarEvents, getActiveAnnouncements } from '../api';
import { QUOTE_ROTATION_INTERVAL } from '../constants';
import DashboardSkeleton from './dashboard/DashboardSkeleton';
import TodayEventsCard from '../components/dashboard/TodayEventsCard';
import EventReminderToast from '../components/notifications/EventReminderToast';
import TasksSummary from '../components/dashboard/TasksSummary';
import PendingApprovalsCard from '../components/dashboard/PendingApprovalsCard';
import SprintProgressCard from '../components/dashboard/SprintProgressCard';
import WorkTimerCard from '../components/dashboard/WorkTimerCard';
import { useEventReminder } from '../hooks/useEventReminder';
import useWebSocket from '../hooks/useWebSocket';
import { ROLE_LEVEL } from '../constants';
import s from './Dashboard.module.css';

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good Morning';
  if (hour < 17) return 'Good Afternoon';
  return 'Good Evening';
}

export default function Dashboard() {
  const { user } = useAuth();
  const { workState } = useWorkState();

  const [taskSummary, setTaskSummary] = useState(null);
  const [todayEvents, setTodayEvents] = useState([]);
  const [tomorrowEvents, setTomorrowEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const timerRef = useRef(null);

  const isManager = (ROLE_LEVEL[user?.role] || 1) >= ROLE_LEVEL.team_lead || user?.has_reports;

  const [announcements, setAnnouncements] = useState([]);
  const [announcementIndex, setAnnouncementIndex] = useState(0);

  const { reminders, dismiss: dismissReminder } = useEventReminder(todayEvents);

  // Rotate announcements
  useEffect(() => {
    if (announcements.length <= 1) return;
    timerRef.current = setInterval(() => {
      setAnnouncementIndex(prev => (prev + 1) % announcements.length);
    }, QUOTE_ROTATION_INTERVAL);
    return () => clearInterval(timerRef.current);
  }, [announcements.length]);

  // Fetch tasks + events
  const fetchData = useCallback(async (signal) => {
    try {
      const now = new Date();
      const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
      const tomorrowEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2).toISOString();
      const [taskRes, eventsRes, tomorrowRes, announcementsRes] = await Promise.allSettled([
        getTaskSummary(),
        getCalendarEvents(dayStart, dayEnd),
        getCalendarEvents(dayEnd, tomorrowEnd),
        getActiveAnnouncements(),
      ]);
      if (signal?.aborted) return;
      if (taskRes.status === 'fulfilled') setTaskSummary(taskRes.value.data);
      if (eventsRes.status === 'fulfilled') setTodayEvents(eventsRes.value.data || []);
      if (tomorrowRes.status === 'fulfilled') setTomorrowEvents(tomorrowRes.value.data || []);
      if (announcementsRes.status === 'fulfilled') setAnnouncements(announcementsRes.value.data?.data || []);
    } catch { /* silent */ } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchData(controller.signal);
    return () => controller.abort();
  }, [fetchData]);

  // Refetch events when a calendar_refresh WS event is received (new event
  // created, updated, or deleted — including from another tab/device).
  const refreshEvents = useCallback(() => {
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
    const tomorrowEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2).toISOString();
    getCalendarEvents(dayStart, dayEnd).then(r => setTodayEvents(r.data || [])).catch(() => {});
    getCalendarEvents(dayEnd, tomorrowEnd).then(r => setTomorrowEvents(r.data || [])).catch(() => {});
  }, []);

  useWebSocket(useCallback((msg) => {
    if (msg.type === 'calendar_refresh' || msg.type === 'meeting_updated' || msg.type === 'meeting_cancelled') {
      refreshEvents();
    }
  }, [refreshEvents]));

  // Refetch events when Dashboard becomes visible again (KeepAlive hides it
  // with display:none while on other pages — data can go stale).
  const { pathname } = useLocation();
  const prevPathRef = useRef(pathname);
  useEffect(() => {
    if (pathname === '/' && prevPathRef.current !== '/') {
      refreshEvents();
    }
    prevPathRef.current = pathname;
  }, [pathname, refreshEvents]);

  if (loading) return <DashboardSkeleton />;

  return (
    <div className={s.dashboard}>
      {/* Greeting Banner */}
      <div className={s['greeting-banner']}>
        <div className={s['greeting-left']}>
          <h2 className={s['greeting-text']}>{getGreeting()}, {user?.full_name || 'there'}!</h2>
          <p className={s['greeting-date']}>
            {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
          </p>
        </div>
        {announcements.length > 0 && (
          <div className={s['announcement-carousel']}>
            <div className={`${s['greeting-quote']} ${s[`announcement-${announcements[announcementIndex]?.type || 'info'}`]}`} key={`a-${announcementIndex}`}>
              <p className={s['quote-text']}>
                {announcements[announcementIndex]?.type === 'quote'
                  ? `"${announcements[announcementIndex]?.message}"`
                  : announcements[announcementIndex]?.message}
              </p>
            </div>
            {announcements.length > 1 && (
              <div className={s['carousel-dots']}>
                {announcements.map((_, i) => (
                  <button
                    key={i}
                    className={`${s['carousel-dot']} ${i === announcementIndex ? s['carousel-dot-active'] : ''}`}
                    onClick={() => setAnnouncementIndex(i)}
                    aria-label={`Announcement ${i + 1}`}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Main content — events + tasks side by side */}
      <div className={s['dashboard-content']}>
        <WorkTimerCard />
        <TodayEventsCard events={todayEvents} tomorrowEvents={tomorrowEvents} />
        <TasksSummary taskSummary={taskSummary} />
        <SprintProgressCard />
        {isManager && <PendingApprovalsCard />}
      </div>

      <EventReminderToast reminders={reminders} onDismiss={dismissReminder} />
    </div>
  );
}
