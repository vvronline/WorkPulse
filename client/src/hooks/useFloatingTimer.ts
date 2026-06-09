import { useState, useEffect, useCallback, useMemo } from "react";
import { useAuth } from "../AuthContext";
import { useWorkState } from "../WorkStateContext";
// NOTE (status v2): the tracker flow no longer writes status. Clock-in/break/
// clock-out are time-tracking events, NOT presence events. Presence is
// derived server-side from open WS sessions; idle/away is derived from
// last_activity_at. See server/services/status/README.md.
import {
    getStatus,
    clockIn,
    breakStart,
    breakEnd,
    clockOut,
    getCurrentOrg,
} from "../api";
import { useLiveTimer } from "./useLiveTimer";
import { useAutoDismiss } from "./useAutoDismiss";
import { STATUS_POLL_INTERVAL } from "../constants";

const TARGET_MINUTES = 9 * 60;

interface TrackerStatus {
    state?: string;
    workMode?: string;
    targetMinutes?: number;
    dailyTargetMet?: boolean;
    isWeekend?: boolean;
    floorMinutes?: number;
    breakMinutes?: number;
    entries?: Array<{ entry_type?: string; [key: string]: unknown }>;
    [key: string]: unknown;
}

/**
 * Lightweight hook that powers the floating timer widget.
 * Re-uses WorkStateContext for state sync and useLiveTimer for the ticking clock.
 * Polls /tracker/status on its own interval so it works on every page.
 */
export function useFloatingTimer() {
    const { isAuthenticated, user } = useAuth();
    const { setWorkState, setWorkMode: setContextWorkMode } = useWorkState();

    const [status, setStatus] = useState<TrackerStatus | null>(null);
    const [workMode, setWorkMode] = useState("office");
    const [actionLoading, setActionLoading] = useState("");
    const [error, setError] = useAutoDismiss("");
    const [showClockOutConfirm, setShowClockOutConfirm] = useState(false);
    // Tenant's attendance-verification flag. We fetch the org config once on
    // mount so the WorkTimerCard knows whether to show the face+location
    // modal before the actual /tracker/clock-in POST.
    const [verificationRequired, setVerificationRequired] = useState(false);

    const {
        liveFloorSec,
        liveBreakSec,
        showConfetti,
        reset: resetTimer,
    } = useLiveTimer(status);

    const fetchStatus = useCallback(async () => {
        if (!isAuthenticated) return;
        try {
            const res = await getStatus();
            setStatus(res.data);
            if (res.data?.workMode) setWorkMode(res.data.workMode);
        } catch {
            /* keep defaults */
        }
    }, [isAuthenticated]);

    // Load org-level attendance verification flag once per session. Refresh
    // when the user changes (re-login) so admin toggles take effect on the
    // next sign-in without a full reload.
    useEffect(() => {
        if (!isAuthenticated) return;
        let cancelled = false;
        getCurrentOrg()
            .then((res) => {
                if (cancelled) return;
                setVerificationRequired(
                    !!res?.data?.attendance_verification_enabled,
                );
            })
            .catch(() => {
                /* defaults to false */
            });
        return () => {
            cancelled = true;
        };
    }, [isAuthenticated, user?.id]);

    useEffect(() => {
        let cancelled = false;
        fetchStatus();
        const handleVisibility = () => {
            if (!document.hidden && !cancelled) fetchStatus();
        };
        // Refresh immediately when a time-entry change happens elsewhere
        // (e.g. user submitted a manual entry on the Manual Entry tab).
        // Without this the WorkTimerCard would show stale data until the
        // next poll (up to STATUS_POLL_INTERVAL later) because KeepAlive
        // keeps the Dashboard mounted across SPA navigations.
        const handleEntryChanged = () => {
            if (!cancelled) fetchStatus();
        };
        document.addEventListener("visibilitychange", handleVisibility);
        window.addEventListener("workpulse:entry-changed", handleEntryChanged);
        const poll = setInterval(() => {
            if (!document.hidden && !cancelled) fetchStatus();
        }, STATUS_POLL_INTERVAL);
        return () => {
            cancelled = true;
            document.removeEventListener("visibilitychange", handleVisibility);
            window.removeEventListener(
                "workpulse:entry-changed",
                handleEntryChanged,
            );
            clearInterval(poll);
        };
    }, [fetchStatus]);

    const state = status?.state || "logged_out";
    const targetMinutes = status?.targetMinutes ?? TARGET_MINUTES;
    const dailyTargetMet = status?.dailyTargetMet ?? false;
    const isWeekend = status?.isWeekend ?? false;

    useEffect(() => {
        setWorkState(state);
    }, [state, setWorkState]);
    useEffect(() => {
        setContextWorkMode(workMode);
    }, [workMode, setContextWorkMode]);

    const floorMinutes = Math.floor(
        (state === "logged_out"
            ? (status?.floorMinutes || 0) * 60
            : liveFloorSec) / 60,
    );
    const breakMinutes = Math.floor(
        (state === "logged_out"
            ? (status?.breakMinutes || 0) * 60
            : liveBreakSec) / 60,
    );
    const totalMinutes = floorMinutes + breakMinutes;
    const progressPercent = Math.min((floorMinutes / targetMinutes) * 100, 100);

    const breakCount = useMemo(
        () =>
            status?.entries?.filter((e) => e.entry_type === "break_start")
                .length || 0,
        [status?.entries],
    );

    const completedTarget = floorMinutes >= targetMinutes;
    const remaining = Math.max(0, targetMinutes - floorMinutes);
    const overtimeMinutes = Math.max(0, floorMinutes - targetMinutes);

    const estimatedClockOut = useMemo(() => {
        if (state !== "on_floor" || completedTarget) return null;
        const remainingSec = targetMinutes * 60 - liveFloorSec;
        if (remainingSec <= 0) return null;
        return new Date(
            Date.now() + remainingSec * 1000,
        ).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }, [state, completedTarget, liveFloorSec, targetMinutes]);

    const handleAction = useCallback(
        async (actionFn: () => Promise<unknown>, actionName: string) => {
            setActionLoading(actionName);
            setError("");
            try {
                await actionFn();
                await fetchStatus();
                if (actionName === "clockOut") resetTimer();
            } catch (err) {
                const error = err as {
                    response?: { data?: { error?: string } };
                };
                setError(error.response?.data?.error || "Action failed");
                await fetchStatus();
            } finally {
                setActionLoading("");
            }
        },
        [fetchStatus, resetTimer],
    );

    const handleClockIn = useCallback(async () => {
        // Legacy code path (no verification): pass the work_mode string
        // directly and call /tracker/clock-in immediately.
        await handleAction(() => clockIn(workMode), "clockIn");
    }, [handleAction, workMode]);

    /**
     * Verified clock-in entry point used by the WorkTimerCard when the org
     * has attendance verification enabled. Accepts the full payload
     * (work_mode + location + face_descriptor) produced by
     * <ClockInVerifyModal/> and forwards it to /tracker/clock-in.
     *
     * Returns the API response on success; throws the AxiosError on failure
     * so the modal can surface the server's error message + code.
     */
    const submitVerifiedClockIn = useCallback(
        async (payload: unknown) => {
            setActionLoading("clockIn");
            setError("");
            try {
                const res = await clockIn(payload as never);
                await fetchStatus();
                return res;
            } finally {
                setActionLoading("");
            }
        },
        [fetchStatus],
    );
    const handleBreakStart = useCallback(async () => {
        await handleAction(breakStart, "breakStart");
    }, [handleAction]);
    const handleBreakEnd = useCallback(async () => {
        await handleAction(breakEnd, "breakEnd");
    }, [handleAction]);
    const handleConfirmClockOut = useCallback(async () => {
        setShowClockOutConfirm(false);
        await handleAction(clockOut, "clockOut");
    }, [handleAction]);

    const radius = 38;
    const circumference = 2 * Math.PI * radius;
    const strokeDashoffset =
        circumference - (progressPercent / 100) * circumference;

    const progressColor = useMemo(() => {
        if (progressPercent >= 90)
            return { color: "var(--success)", glow: "var(--success-glow)" };
        if (progressPercent >= 60)
            return { color: "var(--primary)", glow: "var(--primary-glow)" };
        if (progressPercent >= 35)
            return { color: "var(--warning)", glow: "var(--warning-glow)" };
        return { color: "var(--danger)", glow: "var(--danger-glow)" };
    }, [progressPercent]);

    return {
        user,
        state,
        isWeekend,
        dailyTargetMet,
        workMode,
        setWorkMode,
        actionLoading,
        error,
        liveFloorSec,
        liveBreakSec,
        showConfetti,
        floorMinutes,
        progressPercent,
        progressColor,
        breakMinutes,
        totalMinutes,
        completedTarget,
        remaining,
        overtimeMinutes,
        breakCount,
        estimatedClockOut,
        targetMinutes,
        showClockOutConfirm,
        setShowClockOutConfirm,
        handleClockIn,
        handleBreakStart,
        handleBreakEnd,
        handleConfirmClockOut,
        radius,
        circumference,
        strokeDashoffset,
        verificationRequired,
        submitVerifiedClockIn,
    };
}