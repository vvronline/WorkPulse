import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAuth } from '../AuthContext';
import { QUOTE_ROTATION_INTERVAL, STATUS_POLL_INTERVAL } from '../constants';
import { useWorkState } from '../WorkStateContext';
import {
    getStatus, clockIn, breakStart, breakEnd, clockOut,
    getWidgets, getWeeklyChart, getTaskSummary, getCalendarEvents,
} from '../api';
import { useAutoDismiss } from './useAutoDismiss';
import { useLiveTimer } from './useLiveTimer';
import { useEventReminder } from './useEventReminder';

export const TARGET_HOURS = 9 * 60;
export const MANDATORY_HOURS = 8 * 60;

export const QUOTES = [
    { text: "The secret of getting ahead is getting started.", author: "Mark Twain" },
    { text: "Focus on being productive instead of busy.", author: "Tim Ferriss" },
    { text: "Productivity is never an accident.", author: "Paul J. Meyer" },
    { text: "Do the hard jobs first. The easy ones will take care of themselves.", author: "Dale Carnegie" },
    { text: "Amateurs sit and wait for inspiration. The rest of us just get up and go to work.", author: "Stephen King" },
    { text: "Your work is going to fill a large part of your life. Love what you do.", author: "Steve Jobs" },
    { text: "The way to get started is to quit talking and begin doing.", author: "Walt Disney" },
    { text: "Don't count the days. Make the days count.", author: "Muhammad Ali" },
    { text: "Success is the sum of small efforts repeated day in and day out.", author: "Robert Collier" },
    { text: "It's not about having time. It's about making time.", author: "Unknown" },
];

// Confetti pieces are a static decorative asset — generated once per session.
const _confettiColors = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899'];
export const CONFETTI_PIECES = [...Array(50)].map(() => ({
    '--confetti-left': `${Math.random() * 100}%`,
    '--confetti-delay': `${Math.random() * 2}s`,
    '--confetti-duration': `${2 + Math.random() * 3}s`,
    '--confetti-color': _confettiColors[Math.floor(Math.random() * 7)],
    '--confetti-width': `${6 + Math.random() * 6}px`,
    '--confetti-height': `${6 + Math.random() * 6}px`,
}));

function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
}

/**
 * Owns all Dashboard state, side-effects, and derived values.
 * Dashboard.jsx becomes a thin JSX layer that consumes this hook.
 */
export function useDashboardData() {
    const { user } = useAuth();
    const { setWorkState, setWorkMode: setContextWorkMode } = useWorkState();

    const [status, setStatus] = useState(null);
    const [widgets, setWidgets] = useState(null);
    const [weeklyData, setWeeklyData] = useState(null);
    const [taskSummary, setTaskSummary] = useState(null);
    const [loading, setLoading] = useState(true);
    const [actionLoading, setActionLoading] = useState('');
    const [error, setError] = useAutoDismiss('');
    const [workMode, setWorkMode] = useState('office');
    const [showClockOutConfirm, setShowClockOutConfirm] = useState(false);
    const [quoteIndex, setQuoteIndex] = useState(() => Math.floor(Math.random() * QUOTES.length));
    const [todayEvents, setTodayEvents] = useState([]);
    const quoteTimerRef = useRef(null);

    const { liveFloorSec, liveBreakSec, showConfetti, reset: resetTimer } = useLiveTimer(status);
    const { reminders, dismiss: dismissReminder } = useEventReminder(todayEvents);

    // Rotate quotes every 20 seconds
    useEffect(() => {
        quoteTimerRef.current = setInterval(() => {
            setQuoteIndex(prev => (prev + 1) % QUOTES.length);
        }, QUOTE_ROTATION_INTERVAL);
        return () => clearInterval(quoteTimerRef.current);
    }, []);

    const fetchStatus = useCallback(async () => {
        try {
            const now = new Date();
            const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
            const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

            const [statusRes, widgetsRes, weeklyRes, taskRes, eventsRes] = await Promise.allSettled([
                getStatus(), getWidgets(), getWeeklyChart(), getTaskSummary(),
                getCalendarEvents(dayStart, dayEnd),
            ]);
            if (statusRes.status === 'fulfilled') {
                setStatus(statusRes.value.data);
                if (statusRes.value.data.workMode) setWorkMode(statusRes.value.data.workMode);
            } else {
                console.error('Status fetch failed:', statusRes.reason);
                setError('Failed to fetch status');
            }
            if (widgetsRes.status === 'fulfilled') setWidgets(widgetsRes.value.data);
            if (weeklyRes.status === 'fulfilled') setWeeklyData(weeklyRes.value.data);
            if (taskRes.status === 'fulfilled') setTaskSummary(taskRes.value.data);
            if (eventsRes.status === 'fulfilled') setTodayEvents(eventsRes.value.data || []);
        } catch (err) {
            console.error('Dashboard fetch error:', err);
            setError('Failed to fetch status');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        let cancelled = false;
        fetchStatus();
        requestNotificationPermission();

        const handleVisibility = () => {
            if (!document.hidden && !cancelled) fetchStatus();
        };
        document.addEventListener('visibilitychange', handleVisibility);
        const pollInterval = setInterval(() => {
            if (!document.hidden && !cancelled) fetchStatus();
        }, STATUS_POLL_INTERVAL);

        return () => {
            cancelled = true;
            document.removeEventListener('visibilitychange', handleVisibility);
            clearInterval(pollInterval);
        };
    }, [fetchStatus]);

    const handleAction = useCallback(async (actionFn, actionName) => {
        setActionLoading(actionName);
        setError('');
        try {
            await actionFn();
            await fetchStatus();
            if (actionName === 'clockOut') resetTimer();
        } catch (err) {
            setError(err.response?.data?.error || 'Action failed');
            await fetchStatus();
        } finally {
            setActionLoading('');
        }
    }, [fetchStatus, resetTimer]);

    const state = status?.state || 'logged_out';

    // Sync work state & mode to shared context so Navbar can read them
    useEffect(() => { setWorkState(state); }, [state, setWorkState]);
    useEffect(() => { setContextWorkMode(workMode); }, [workMode, setContextWorkMode]);

    const displayFloorSec = state === 'logged_out' ? 0 : liveFloorSec;
    const displayBreakSec = state === 'logged_out' ? 0 : liveBreakSec;
    const floorMinutes = Math.floor(displayFloorSec / 60);
    const progressPercent = Math.min((floorMinutes / TARGET_HOURS) * 100, 100);

    const clockInEntry = status?.entries?.find(e => e.entry_type === 'clock_in');
    const clockInTime = useMemo(() =>
        clockInEntry
            ? new Date(clockInEntry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : null,
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [clockInEntry?.timestamp],
    );

    const progressColor = useMemo(() => {
        if (progressPercent >= 90) return { color: 'var(--success)', glow: 'var(--success-glow)' };
        if (progressPercent >= 60) return { color: 'var(--primary)', glow: 'var(--primary-glow)' };
        if (progressPercent >= 35) return { color: 'var(--warning)', glow: 'var(--warning-glow)' };
        if (progressPercent >= 10) return { color: 'var(--warning)', glow: 'var(--warning-glow)' };
        return { color: 'var(--danger)', glow: 'var(--danger-glow)' };
    }, [progressPercent]);

    const breakCount = useMemo(
        () => status?.entries?.filter(e => e.entry_type === 'break_start').length || 0,
        [status?.entries],
    );

    const completedTarget = floorMinutes >= TARGET_HOURS;
    const completedMandatory = floorMinutes >= MANDATORY_HOURS;
    const remaining = Math.max(0, TARGET_HOURS - floorMinutes);
    const mandatoryRemaining = Math.max(0, MANDATORY_HOURS - floorMinutes);
    const isWeekend = status?.isWeekend;
    const overtimeMinutes = Math.max(0, floorMinutes - TARGET_HOURS);

    const estimatedClockOut = useMemo(() => {
        if (state !== 'on_floor' || completedTarget) return null;
        const remainingSec = (TARGET_HOURS * 60) - liveFloorSec;
        if (remainingSec <= 0) return null;
        const est = new Date(Date.now() + remainingSec * 1000);
        return est.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }, [state, completedTarget, liveFloorSec]);

    const radius = 90;
    const circumference = 2 * Math.PI * radius;
    const strokeDashoffset = circumference - (progressPercent / 100) * circumference;

    // Pre-built action handlers (avoids passing raw API functions + workMode into Dashboard JSX)
    const handleClockIn = useCallback(() => handleAction(() => clockIn(workMode), 'clockIn'), [handleAction, workMode]);
    const handleBreakStart = useCallback(() => handleAction(breakStart, 'breakStart'), [handleAction]);
    const handleBreakEnd = useCallback(() => handleAction(breakEnd, 'breakEnd'), [handleAction]);
    const handleConfirmClockOut = useCallback(() => {
        setShowClockOutConfirm(false);
        handleAction(clockOut, 'clockOut');
    }, [handleAction]);

    return {
        user, status, state, loading, actionLoading, error,
        workMode, setWorkMode,
        widgets, weeklyData, taskSummary, todayEvents,
        liveFloorSec, liveBreakSec, showConfetti,
        reminders, dismissReminder,
        floorMinutes, progressPercent, progressColor,
        completedTarget, completedMandatory,
        remaining, mandatoryRemaining,
        breakCount, estimatedClockOut, overtimeMinutes,
        isWeekend, clockInTime,
        quote: QUOTES[quoteIndex], quoteIndex,
        showClockOutConfirm, setShowClockOutConfirm,
        handleClockIn, handleBreakStart, handleBreakEnd, handleConfirmClockOut,
        radius, circumference, strokeDashoffset,
        displayFloorSec, displayBreakSec,
    };
}
