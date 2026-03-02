import { useState, useEffect, useRef } from 'react';

const TARGET_HOURS = 9 * 60; // 9 hours in minutes

function sendNotification(title, body) {
    if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body, icon: '⏱' });
    }
}

/**
 * Custom hook that manages live timer state for the Dashboard.
 * Ticks every second when on_floor or on_break, handles anchoring,
 * 9-hour notification, and confetti trigger.
 *
 * @param {object|null} status - The status object from /api/tracker/status
 * @returns {{ liveFloorSec, liveBreakSec, showConfetti, notified8hr }}
 */
export function useLiveTimer(status) {
    const [liveFloorSec, setLiveFloorSec] = useState(0);
    const [liveBreakSec, setLiveBreakSec] = useState(0);
    const [showConfetti, setShowConfetti] = useState(false);

    const intervalRef = useRef(null);
    const notified8hr = useRef(false);
    const confettiTriggered = useRef(false);
    const floorAnchorRef = useRef({ base: 0, at: Date.now() });
    const breakAnchorRef = useRef({ base: 0, at: Date.now() });

    // Anchor baseline whenever status changes (fetch after action)
    useEffect(() => {
        if (!status) return;
        const floorSec = (status.floorMinutes || 0) * 60;
        const breakSec = (status.breakMinutes || 0) * 60;
        setLiveFloorSec(floorSec);
        setLiveBreakSec(breakSec);
        floorAnchorRef.current = { base: floorSec, at: Date.now() };
        breakAnchorRef.current = { base: breakSec, at: Date.now() };
    }, [status?.floorMinutes, status?.breakMinutes, status?.state]);

    // Live tick every second
    useEffect(() => {
        if (intervalRef.current) clearInterval(intervalRef.current);

        if (status?.state === 'on_floor') {
            intervalRef.current = setInterval(() => {
                const next = floorAnchorRef.current.base + Math.floor((Date.now() - floorAnchorRef.current.at) / 1000);
                setLiveFloorSec(next);
                if (!notified8hr.current && next >= TARGET_HOURS * 60) {
                    notified8hr.current = true;
                    sendNotification('🎉 9 Hours Complete!', "You've completed your 9-hour target. Great job!");
                    if (!confettiTriggered.current) {
                        confettiTriggered.current = true;
                        setShowConfetti(true);
                        setTimeout(() => setShowConfetti(false), 5000);
                    }
                }
            }, 1000);
        } else if (status?.state === 'on_break') {
            intervalRef.current = setInterval(() => {
                const next = breakAnchorRef.current.base + Math.floor((Date.now() - breakAnchorRef.current.at) / 1000);
                setLiveBreakSec(next);
            }, 1000);
        }

        return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
    }, [status?.state]);

    // Reset on clock-out
    const reset = () => {
        setLiveFloorSec(0);
        setLiveBreakSec(0);
        notified8hr.current = false;
        confettiTriggered.current = false;
    };

    return { liveFloorSec, liveBreakSec, showConfetti, reset };
}
