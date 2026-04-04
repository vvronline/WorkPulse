import React, { useState, useEffect, useCallback } from 'react';
import { Calendar as CalendarIcon } from 'lucide-react';
import Calendar from '../components/calendar/Calendar';
import { getTasks, getLocalToday } from '../api';
import { useAuth } from '../AuthContext';
import s from './CalendarPage.module.css';

export default function CalendarPage() {
  const { user } = useAuth();
  const [tasks, setTasks] = useState([]);

  const fetchTasks = useCallback(async () => {
    try {
      const res = await getTasks(getLocalToday(), { scope: 'personal', include_due: '1' });
      setTasks(res.data.tasks);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchTasks(); }, [fetchTasks]);

  return (
    <div className={s.page}>
      <div className={s.header}>
        <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><CalendarIcon size={22} /> Calendar</h2>
        <p>Schedule events and manage your time</p>
      </div>
      <div className={s.calendarWrap}>
        <Calendar tasks={tasks} />
      </div>
    </div>
  );
}
