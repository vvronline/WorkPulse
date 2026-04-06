import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../AuthContext';
import { useWorkState } from '../WorkStateContext';
import { getTaskSummary, getCalendarEvents } from '../api';
import { QUOTE_ROTATION_INTERVAL } from '../constants';
import { QUOTES, CONFETTI_PIECES } from '../hooks/useDashboardData';
import DashboardSkeleton from './dashboard/DashboardSkeleton';
import TodayEventsCard from '../components/dashboard/TodayEventsCard';
import EventReminderToast from '../components/notifications/EventReminderToast';
import TasksSummary from '../components/dashboard/TasksSummary';
import PendingApprovalsCard from '../components/dashboard/PendingApprovalsCard';
import { useEventReminder } from '../hooks/useEventReminder';
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
  const [quoteIndex, setQuoteIndex] = useState(() => Math.floor(Math.random() * QUOTES.length));
  const quoteTimerRef = useRef(null);
  const quote = QUOTES[quoteIndex];

  const isManager = (ROLE_LEVEL[user?.role] || 1) >= ROLE_LEVEL.team_lead || user?.has_reports;

  const { reminders, dismiss: dismissReminder } = useEventReminder(todayEvents);

  // Rotate quotes
  useEffect(() => {
    quoteTimerRef.current = setInterval(() => {
      setQuoteIndex(prev => (prev + 1) % QUOTES.length);
    }, QUOTE_ROTATION_INTERVAL);
    return () => clearInterval(quoteTimerRef.current);
  }, []);

  // Fetch tasks + events
  const fetchData = useCallback(async () => {
    try {
      const now = new Date();
      const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
      const tomorrowEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2).toISOString();
      const [taskRes, eventsRes, tomorrowRes] = await Promise.allSettled([
        getTaskSummary(),
        getCalendarEvents(dayStart, dayEnd),
        getCalendarEvents(dayEnd, tomorrowEnd),
      ]);
      if (taskRes.status === 'fulfilled') setTaskSummary(taskRes.value.data);
      if (eventsRes.status === 'fulfilled') setTodayEvents(eventsRes.value.data || []);
      if (tomorrowRes.status === 'fulfilled') setTomorrowEvents(tomorrowRes.value.data || []);
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

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
        <div className={s['greeting-quote']} key={quoteIndex}>
          <p className={s['quote-text']}>"{quote.text}"</p>
          <p className={s['quote-author']}>— {quote.author}</p>
        </div>
      </div>

      {/* Main content — events + tasks side by side */}
      <div className={s['dashboard-content']}>
        <TodayEventsCard events={todayEvents} tomorrowEvents={tomorrowEvents} />
        <TasksSummary taskSummary={taskSummary} />
        {isManager && <PendingApprovalsCard />}
      </div>

      <EventReminderToast reminders={reminders} onDismiss={dismissReminder} />
    </div>
  );
}
