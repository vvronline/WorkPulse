import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from '../AuthContext';
import { useWorkState } from '../WorkStateContext';
import { useUserStatus } from '../UserStatusContext';
import { getStatus, clockIn, breakStart, breakEnd, clockOut } from '../api';
import { useLiveTimer } from './useLiveTimer';
import { useAutoDismiss } from './useAutoDismiss';
import { STATUS_POLL_INTERVAL } from '../constants';

const TARGET_MINUTES = 9 * 60;

/**
 * Lightweight hook that powers the floating timer widget.
 * Re-uses WorkStateContext for state sync and useLiveTimer for the ticking clock.
 * Polls /tracker/status on its own interval so it works on every page.
 */
export function useFloatingTimer() {
    const { isAuthenticated, user } = useAuth();
    const { setWorkState, setWorkMode: setContextWorkMode } = useWorkState();
    const { setManualStatus } = useUserStatus();

    const [status, setStatus] = useState(null);
    const [workMode, setWorkMode] = useState('office');
    const [actionLoading, setActionLoading] = useState('');
    const [error, setError] = useAutoDismiss('');
    const [showClockOutConfirm, setShowClockOutConfirm] = useState(false);

    const { liveFloorSec, liveBreakSec, showConfetti, reset: resetTimer } = useLiveTimer(status);

    const fetchStatus = useCallback(async () => {
        if (!isAuthenticated) return;
        try {
            const res = await getStatus();
            setStatus(res.data);
            if (res.data?.workMode) setWorkMode(res.data.workMode);
        } catch { /* keep defaults */ }
    }, [isAuthenticated]);

    useEffect(() => {
        let cancelled = false;
        fetchStatus();
        const handleVisibility = () => { if (!document.hidden && !cancelled) fetchStatus(); };
        document.addEventListener('visibilitychange', handleVisibility);
        const poll = setInterval(() => { if (!document.hidden && !cancelled) fetchStatus(); }, STATUS_POLL_INTERVAL);
        return () => { cancelled = true; document.removeEventListener('visibilitychange', handleVisibility); clearInterval(poll); };
    }, [fetchStatus]);

    const state = status?.state || 'logged_out';
    const targetMinutes = status?.targetMinutes ?? TARGET_MINUTES;
    const dailyTargetMet = status?.dailyTargetMet ?? false;
    const isWeekend = status?.isWeekend ?? false;

    useEffect(() => { setWorkState(state); }, [state, setWorkState]);
    useEffect(() => { setContextWorkMode(workMode); }, [workMode, setContextWorkMode]);

    const floorMinutes = Math.floor((state === 'logged_out' ? (status?.floorMinutes || 0) * 60 : liveFloorSec) / 60);
    const breakMinutes = Math.floor((state === 'logged_out' ? (status?.breakMinutes || 0) * 60 : liveBreakSec) / 60);
    const totalMinutes = floorMinutes + breakMinutes;
    const progressPercent = Math.min((floorMinutes / targetMinutes) * 100, 100);

    const breakCount = useMemo(
        () => status?.entries?.filter(e => e.entry_type === 'break_start').length || 0,
        [status?.entries],
    );

    const completedTarget = floorMinutes >= targetMinutes;
    const remaining = Math.max(0, targetMinutes - floorMinutes);
    const overtimeMinutes = Math.max(0, floorMinutes - targetMinutes);

    const estimatedClockOut = useMemo(() => {
        if (state !== 'on_floor' || completedTarget) return null;
        const remainingSec = (targetMinutes * 60) - liveFloorSec;
        if (remainingSec <= 0) return null;
        return new Date(Date.now() + remainingSec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }, [state, completedTarget, liveFloorSec, targetMinutes]);

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

    const handleClockIn = useCallback(async () => {
        await handleAction(() => clockIn(workMode), 'clockIn');
        setManualStatus('available');
    }, [handleAction, workMode, setManualStatus]);
    const handleBreakStart = useCallback(async () => {
        await handleAction(breakStart, 'breakStart');
        setManualStatus('away');
    }, [handleAction, setManualStatus]);
    const handleBreakEnd = useCallback(async () => {
        await handleAction(breakEnd, 'breakEnd');
        setManualStatus('available');
    }, [handleAction, setManualStatus]);
    const handleConfirmClockOut = useCallback(async () => {
        setShowClockOutConfirm(false);
        await handleAction(clockOut, 'clockOut');
        setManualStatus('offline');
    }, [handleAction, setManualStatus]);

    const radius = 38;
    const circumference = 2 * Math.PI * radius;
    const strokeDashoffset = circumference - (progressPercent / 100) * circumference;

    const progressColor = useMemo(() => {
        if (progressPercent >= 90) return { color: 'var(--success)', glow: 'var(--success-glow)' };
        if (progressPercent >= 60) return { color: 'var(--primary)', glow: 'var(--primary-glow)' };
        if (progressPercent >= 35) return { color: 'var(--warning)', glow: 'var(--warning-glow)' };
        return { color: 'var(--danger)', glow: 'var(--danger-glow)' };
    }, [progressPercent]);

    return {
        user, state, isWeekend, dailyTargetMet,
        workMode, setWorkMode,
        actionLoading, error,
        liveFloorSec, liveBreakSec, showConfetti,
        floorMinutes, progressPercent, progressColor,
        breakMinutes, totalMinutes,
        completedTarget, remaining, overtimeMinutes,
        breakCount, estimatedClockOut, targetMinutes,
        showClockOutConfirm, setShowClockOutConfirm,
        handleClockIn, handleBreakStart, handleBreakEnd, handleConfirmClockOut,
        radius, circumference, strokeDashoffset,
    };
}
